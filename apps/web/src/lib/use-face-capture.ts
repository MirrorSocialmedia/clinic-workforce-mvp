'use client'
import { useRef, useCallback } from 'react'

export function useFaceCapture() {
  const detectorRef = useRef<any>(null)
  // ★ maskGate latch — null = not yet checked, true = server error/latched (pass through)
  const maskLatchRef = useRef<boolean | null>(null)

  const init = useCallback(async () => {
    if (detectorRef.current) return
    try {
      const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks('/models/wasm')
      detectorRef.current = await FaceDetector.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite' },
        runningMode: 'VIDEO',
      })
    } catch (e: any) {
      const err: any = new Error(e?.message || 'detector init failed')
      err.name = `Init_${e?.name ?? 'Error'}`
      throw err
    }
  }, [])

  const captureQualified = useCallback(async (video: HTMLVideoElement, timeoutMs = 3000, onHint?: (h: string) => void): Promise<Blob | null> => {
    maskLatchRef.current = null // reset latch per capture attempt
    await init()
    // ★ Wait for first frame — WebKit 252465
    const frameDeadline = Date.now() + 2000
    while (!video.videoWidth && Date.now() < frameDeadline)
      await new Promise(r => setTimeout(r, 100))
    if (!video.videoWidth) {
      const err: any = new Error('video has no frames (videoWidth=0)')
      err.name = 'NoFrame'
      throw err
    }
    const canvas = document.createElement('canvas')
    const deadline = Date.now() + timeoutMs
    let stableCount = 0
    let prevCx = -1, prevCy = -1 // ★ 位移追蹤
    while (Date.now() < deadline) {
      let det: any
      try {
        det = detectorRef.current.detectForVideo(video, performance.now())
      } catch (e: any) {
        const err: any = new Error(e?.message || 'detect failed')
        err.name = `Detect_${e?.name ?? 'Error'}`
        throw err
      }
      const d = det?.detections?.[0]
      if (det?.detections?.length === 1 && d.boundingBox) {
        const bb = d.boundingBox
        const cx = (bb.originX + bb.width / 2) / video.videoWidth
        const cy = (bb.originY + bb.height / 2) / video.videoHeight
        const wRatio = bb.width / video.videoWidth

        // 太遠 (<0.15) 不收
        if (wRatio < 0.15 || wRatio > 0.70) {
          stableCount = 0; prevCx = -1; prevCy = -1
          onHint?.(wRatio < 0.15 ? '請再靠近一點' : '請退遠一點')
          await new Promise(r => setTimeout(r, 120))
          continue
        }

        // 框內判定 (橢圓中心 50%/48%, 寬 62%, 高 78%)
        const inFrame =
          Math.abs(cx - 0.5) < 0.20 &&
          Math.abs(cy - 0.48) < 0.26

        if (!inFrame) {
          stableCount = 0; prevCx = -1; prevCy = -1
          onHint?.('請將臉移入框內')
          await new Promise(r => setTimeout(r, 120))
          continue
        }

        // ★ 2026-08-06 穩定幀 gate：連續 6 幀合格＋冇明顯移動先影
        const moved = prevCx >= 0 &&
          (Math.abs(cx - prevCx) > 0.03 || Math.abs(cy - prevCy) > 0.03)
        prevCx = cx; prevCy = cy
        if (moved) {
          stableCount = 0
          onHint?.('請保持穩定')
          await new Promise(r => setTimeout(r, 120)); continue
        }
        stableCount++
        if (stableCount < 6) {
          onHint?.('請保持穩定…')
          await new Promise(r => setTimeout(r, 120)); continue
        }

        // ★ maskGate — after inFrame+distance, before light/capture
        //   latch on any error (fail-open), 1.5s re-check interval, 8s hard deadline
        if (maskLatchRef.current !== true) {
          try {
            // Capture current frame for mask check (320px jpeg)
            const maskCanvas = document.createElement('canvas')
            const ms = Math.min(1, 320 / video.videoWidth)
            maskCanvas.width = Math.round(video.videoWidth * ms)
            maskCanvas.height = Math.round(video.videoHeight * ms)
            const mctx = maskCanvas.getContext('2d')!
            mctx.drawImage(video, 0, 0, maskCanvas.width, maskCanvas.height)
            const maskBlob = await new Promise<Blob | null>(r => maskCanvas.toBlob(b => r(b), 'image/jpeg', 0.7))
            if (maskBlob) {
              const mfd = new FormData()
              mfd.append('frame', maskBlob, 'mask.jpg')
              const mRes = await fetch('/api/face/mask-check', {
                method: 'POST', credentials: 'include', body: mfd,
                signal: AbortSignal.timeout(1200),
              }).catch(() => null)
              if (mRes && mRes.ok) {
                const mData = await mRes.json()
                if (mData.masked === true) {
                  maskLatchRef.current = null // not latched yet
                  onHint?.('😷 請除下口罩再看鏡頭')
                  await new Promise(r => setTimeout(r, 1500))
                  continue
                }
              }
            }
            // OK (not masked) or fail → pass through
            maskLatchRef.current = true
          } catch {
            // Any error → latch and pass through (fail-open)
            console.warn('[face-capture] maskGate error, latching pass-through')
            maskLatchRef.current = true
          }
        }

        // 降採樣
        const scale = Math.min(1, 640 / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const sample = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let luma = 0
        for (let i = 0; i < sample.length; i += 4 * 50)
          luma += 0.299 * sample[i] + 0.587 * sample[i + 1] + 0.114 * sample[i + 2]
        luma /= (sample.length / (4 * 50))
        if (luma > 55 && luma < 215) {
          return await new Promise(r => canvas.toBlob(b => r(b), 'image/jpeg', 0.85))
        }
        if (luma <= 55) onHint?.('光線不足')
      } else {
        stableCount = 0; prevCx = -1; prevCy = -1
      }
      await new Promise(r => setTimeout(r, 120))
    }
    return null
  }, [init])

  /** 寬鬆模式：單臉存在即影（唔理距離/框/穩定/mask）— 盲影前最後機會 */
  const captureLoose = useCallback(async (video: HTMLVideoElement, timeoutMs = 2000): Promise<Blob | null> => {
    await init()
    // Wait for first frame
    const frameDeadline = Date.now() + 2000
    while (!video.videoWidth && Date.now() < frameDeadline)
      await new Promise(r => setTimeout(r, 100))
    if (!video.videoWidth) {
      const err: any = new Error('video has no frames (videoWidth=0)')
      err.name = 'NoFrame'
      throw err
    }
    const canvas = document.createElement('canvas')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      let det: any
      try {
        det = detectorRef.current.detectForVideo(video, performance.now())
      } catch (e: any) {
        const err: any = new Error(e?.message || 'detect failed')
        err.name = `Detect_${e?.name ?? 'Error'}`
        throw err
      }
      if (det?.detections?.length === 1) {
        // 有單臉就影（唔理距離/框/穩定/mask）
        const scale = Math.min(1, 640 / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        return await new Promise(r => canvas.toBlob(b => r(b), 'image/jpeg', 0.85))
      }
      await new Promise(r => setTimeout(r, 150))
    }
    return null
  }, [init])

  // ★ 裸快照: 無門檻,拍到什麼是什麼 (NO_FACE 證據)
  const captureRaw = useCallback(async (video: HTMLVideoElement): Promise<Blob | null> => {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 640 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return new Promise(r => canvas.toBlob(b => r(b), 'image/jpeg', 0.8))
  }, [])

  return { captureQualified, captureRaw, captureLoose, warmup: init }
}
