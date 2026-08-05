import os, io, json
import numpy as np, cv2
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
import insightface

FRAMES_DIR = '/data/frames'
os.makedirs(FRAMES_DIR, exist_ok=True)

app = FastAPI()
fa = insightface.app.FaceAnalysis(name='buffalo_l', providers=['CPUExecutionProvider'])
fa.prepare(ctx_id=-1, det_size=(640, 640))

# 活體接縫：模型在則載入，不在則回 None（第 6 階段補裝）
LIVENESS = None
LIVE_PATH = 'models/minifasnet.onnx'
if os.path.exists(LIVE_PATH):
    import onnxruntime as ort
    LIVENESS = ort.InferenceSession(LIVE_PATH, providers=['CPUExecutionProvider'])

def decode(b: bytes):
    img = cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError('bad image')
    return img

def run_liveness(img, bbox):
    if LIVENESS is None:
        return None
    x1, y1, x2, y2 = [int(v) for v in bbox]
    h, w = img.shape[:2]
    cx, cy, bw, bh = (x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) * 2.7, (y2 - y1) * 2.7
    xa, ya = max(0, int(cx - bw / 2)), max(0, int(cy - bh / 2))
    xb, yb = min(w, int(cx + bw / 2)), min(h, int(cy + bh / 2))
    crop = cv2.resize(img[ya:yb, xa:xb], (80, 80)).astype(np.float32)
    inp = np.transpose(crop, (2, 0, 1))[None]
    out = LIVENESS.run(None, {LIVENESS.get_inputs()[0].name: inp})[0]
    prob = np.exp(out) / np.exp(out).sum()
    return float(prob[0][1])  # index 1 = real

@app.get('/health')
def health():
    return {'ok': True, 'liveness_loaded': LIVENESS is not None}

@app.post('/embed')
async def embed(files: list[UploadFile] = File(...), store_ref: str = Form(None)):
    embs = []
    first_bytes = None
    for i, f in enumerate(files):
        raw = await f.read()
        if i == 0:
            first_bytes = raw
        img = decode(raw)
        faces = fa.get(img)
        if len(faces) != 1:
            return JSONResponse({'ok': False, 'error': f'偵測到 {len(faces)} 張臉(需恰好1張)'}, status_code=422)
        embs.append(faces[0].normed_embedding)
    mean = np.mean(embs, axis=0)
    mean = mean / np.linalg.norm(mean)
    if store_ref and first_bytes:
        _save(f'ref_{store_ref}', first_bytes)
    return {'ok': True, 'embedding': mean.tolist()}

@app.post('/verify')
async def verify(file: UploadFile = File(...), embedding: str = Form(...),
                 punch_id: str = Form(...), save_on_fail: bool = Form(True),
                 threshold: float = Form(0.45)):
    raw = await file.read()
    img = decode(raw)
    faces = fa.get(img)
    if len(faces) != 1:
        path = _save(punch_id, raw) if save_on_fail else None
        return {'ok': True, 'status': 'FAIL', 'reason': 'no_single_face', 'score': None, 'liveness': None, 'framePath': path}
    tmpl = np.array(json.loads(embedding), dtype=np.float32)
    score = float(np.dot(faces[0].normed_embedding, tmpl))
    live = run_liveness(img, faces[0].bbox)
    passed = score >= threshold and (live is None or live >= 0.7)
    path = None
    if not passed and save_on_fail:
        path = _save(punch_id, raw)
    return {'ok': True, 'status': 'PASS' if passed else 'FAIL', 'score': round(score, 4),
            'liveness': None if live is None else round(live, 4), 'framePath': path}

def _save(punch_id: str, raw: bytes) -> str:
    p = os.path.join(FRAMES_DIR, f'{punch_id}.jpg')
    with open(p, 'wb') as f:
        f.write(raw)
    return p

@app.post('/store/{punch_id}')
async def store(punch_id: str, file: UploadFile = File(...)):
    raw = await file.read()
    path = _save(punch_id, raw)
    return {'ok': True, 'framePath': path}

@app.get('/frame/{punch_id}')
def frame(punch_id: str):
    p = os.path.join(FRAMES_DIR, f'{punch_id}.jpg')
    if not os.path.exists(p):
        return JSONResponse({'error': 'not found'}, status_code=404)
    return FileResponse(p, media_type='image/jpeg')

@app.delete('/frame/{punch_id}')
def delete_frame(punch_id: str, allow_ref: bool = False):
    # ★ 參考照係核准後永久保留（2026-07-29 決定），
    #   唔可以經一般打卡幀刪除路徑誤刪。
    if punch_id.startswith('ref_') and not allow_ref:
        return JSONResponse({'error': 'ref frames are protected'}, status_code=403)
    p = os.path.join(FRAMES_DIR, f'{punch_id}.jpg')
    if os.path.exists(p):
        os.remove(p)
    return {'ok': True}

# ──────────────────────────────────────────────
# Mask detection endpoint (P1)
# ──────────────────────────────────────────────

# ONNX mask classifier (optional — zero new package, onnxruntime is insightface dep)
MASK_MODEL = None
MASK_MODEL_PATH = '/models/mask_detector.onnx'
try:
    import onnxruntime as ort
    if os.path.exists(MASK_MODEL_PATH):
        MASK_MODEL = ort.InferenceSession(MASK_MODEL_PATH, providers=['CPUExecutionProvider'])
except Exception:
    MASK_MODEL = None

def _heuristic_mask_check(img, bbox):
    """Fallback: forehead-reference + uniformity heuristic.

    Uses upper face (forehead) as skin-tone reference, then compares
    lower face region. Detects masks by: (1) large color distance from
    reference AND (2) low standard deviation (uniform color = mask-like).
    White masks (bright + uniform) and blue masks (color distance + uniform)
    both trigger. Beards (non-uniform) don't trigger.
    """
    try:
        x1, y1, x2, y2 = [int(v) for v in bbox[:4]]
        h, w = img.shape[:2]
        face_h = y2 - y1
        face_w = x2 - x1

        # Reference region: upper 1/3 (forehead) — should be bare skin
        ref_y_start = int(y1 + face_h * 0.05)
        ref_y_end = int(y1 + face_h * 0.35)
        ref_x_start = int(x1 + face_w * 0.15)
        ref_x_end = int(x2 - face_w * 0.15)
        ref_y_start = min(ref_y_start, h - 1)
        ref_y_end = min(ref_y_end, h - 1)
        ref_x_start = max(ref_x_start, 0)
        ref_x_end = min(ref_x_end, w - 1)
        ref_region = img[ref_y_start:ref_y_end, ref_x_start:ref_x_end]

        # Lower face region: middle-lower 30% (nose to chin)
        low_y_start = int(y1 + face_h * 0.50)
        low_y_end = int(y1 + face_h * 0.80)
        low_x_start = int(x1 + face_w * 0.20)
        low_x_end = int(x2 - face_w * 0.20)
        low_y_start = min(low_y_start, h - 1)
        low_y_end = min(low_y_end, h - 1)
        low_x_start = max(low_x_start, 0)
        low_x_end = min(low_x_end, w - 1)
        low_region = img[low_y_start:low_y_end, low_x_start:low_x_end]

        if ref_region.size == 0 or low_region.size == 0:
            return False, 0.5

        # Compute reference mean RGB (skin tone from forehead)
        ref_mean = np.mean(ref_region, axis=(0, 1))  # (R, G, B)
        # Compute lower region stats
        low_mean = np.mean(low_region, axis=(0, 1))
        low_std = float(np.std(low_region))

        # Condition 1: Color distance (Euclidean in RGB)
        color_dist = float(np.sqrt(np.sum((low_mean - ref_mean) ** 2)))
        # Condition 2: Low uniformity (std < 40 = large uniform patch like mask)
        is_uniform = low_std < 40

        # Mask detection: significant color shift + uniform region
        # color_dist > 30 catches both light masks (very different from skin) and dark masks
        masked = color_dist > 30 and is_uniform

        if masked:
            # Confidence: higher for more uniform + larger color distance
            confidence = min(0.7, 0.3 + (color_dist - 30) / 200 + (40 - low_std) / 100)
        else:
            confidence = max(0.3, 1.0 - color_dist / 200)

        return bool(masked), float(confidence)
    except Exception:
        return False, 0.3

@app.post('/mask')
async def mask_check(file: UploadFile = File(...)):
    """
    POST /mask — Detect whether person is wearing a mask.
    
    Returns:
    - { masked: bool, confidence: float, degraded: bool }
    - degraded=true means heuristic fallback was used
    - Never returns 5xx; worst case: { masked: false, degraded: true }
    
    Kill switch: env MASK_CHECK=off → { masked: false }
    """
    # Kill switch
    if os.environ.get('MASK_CHECK', '').lower() == 'off':
        return {'masked': False, 'confidence': 0.0, 'degraded': False}

    try:
        raw = await file.read()
        img = decode(raw)

        # Detect face
        faces = fa.get(img)
        if len(faces) != 1:
            return {'masked': False, 'confidence': 0.0, 'degraded': True}

        bbox = faces[0].bbox

        # Tier 1: ONNX mask classifier
        if MASK_MODEL is not None:
            try:
                x1, y1, x2, y2 = [int(v) for v in bbox[:4]]
                face_crop = img[y1:y2, x1:x2]
                face_crop = cv2.resize(face_crop, (128, 128)).astype(np.float32)
                # TODO: normalize input (divide by 255 or mean/std) per model card —
                # wrong normalize = all false positives/negatives
                face_crop = np.transpose(face_crop, (2, 0, 1))[None]
                input_name = MASK_MODEL.get_inputs()[0].name
                output = MASK_MODEL.run(None, {input_name: face_crop})[0]
                # Assume binary classifier: output[0][0] = not_masked, output[0][1] = masked
                if output.shape[1] == 2:
                    probs = np.exp(output[0]) / np.sum(np.exp(output[0]))
                    masked = probs[1] > 0.5
                    confidence = float(probs[1] if masked else probs[0])
                else:
                    val = float(output[0][0])
                    masked = val > 0.5
                    confidence = val
                return {'masked': masked, 'confidence': round(confidence, 4), 'degraded': False}
            except Exception:
                pass  # Fall through to heuristic

        # Tier 2: Heuristic fallback
        masked, confidence = _heuristic_mask_check(img, bbox)
        return {'masked': masked, 'confidence': round(confidence, 4), 'degraded': True}

    except Exception:
        # Tier 3: Any error → fail-open
        return {'masked': False, 'confidence': 0.0, 'degraded': True}
