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
async def embed(files: list[UploadFile] = File(...)):
    embs = []
    for f in files:
        img = decode(await f.read())
        faces = fa.get(img)
        if len(faces) != 1:
            return JSONResponse({'ok': False, 'error': f'偵測到 {len(faces)} 張臉(需恰好1張)'}, status_code=422)
        embs.append(faces[0].normed_embedding)
    mean = np.mean(embs, axis=0)
    mean = mean / np.linalg.norm(mean)
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

@app.get('/frame/{punch_id}')
def frame(punch_id: str):
    p = os.path.join(FRAMES_DIR, f'{punch_id}.jpg')
    if not os.path.exists(p):
        return JSONResponse({'error': 'not found'}, status_code=404)
    return FileResponse(p, media_type='image/jpeg')

@app.delete('/frame/{punch_id}')
def delete_frame(punch_id: str):
    p = os.path.join(FRAMES_DIR, f'{punch_id}.jpg')
    if os.path.exists(p):
        os.remove(p)
    return {'ok': True}
