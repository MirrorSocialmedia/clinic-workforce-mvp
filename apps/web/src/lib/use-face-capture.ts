'use client'
import { useRef, useCallback } from 'react'

export function useFaceCapture() {
  const detectorRef = useRef<any>(null)

  const init = useCallback(async () => {
    if (detectorRef.current) return
    const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision')
    const vision = await FilesetResolver.forVisionTasks('/models/wasm')
    detectorRef.current = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite' },
      runningMode: 'VIDEO',
    })
  }, [])

  const captureQualified = useCallback(async (video: HTMLVideoElement, timeoutMs = 3000, onHint?: (h: string) => void): Promise<Blob | null> => {
    await init()
    const canvas = document.createElement('canvas')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const det = detectorRef.current.detectForVideo(video, performance.now())
      const d = det?.detections?.[0]
      if (det?.detections?.length === 1 && d.boundingBox) {
        const bb = d.boundingBox
        const cx = (bb.originX + bb.width / 2) / video.videoWidth
        const cy = (bb.originY + bb.height / 2) / video.videoHeight
        const wRatio = bb.width / video.videoWidth

        // 太遠 (<0.15) 不收
        if (wRatio < 0.15 || wRatio > 0.70) {
          onHint?.(wRatio < 0.15 ? '請再靠近一點' : '請退遠一點')
          await new Promise(r => setTimeout(r, 120))
          continue
        }

        // 框內判定 (橢圓中心 50%/48%, 寬 62%, 高 78%)
        const inFrame =
          Math.abs(cx - 0.5) < 0.20 &&
          Math.abs(cy - 0.48) < 0.26

        if (!inFrame) {
          onHint?.('請將臉移入框內')
          await new Promise(r => setTimeout(r, 120))
          continue
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
      }
      await new Promise(r => setTimeout(r, 120))
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

  return { captureQualified, captureRaw, warmup: init }
}
