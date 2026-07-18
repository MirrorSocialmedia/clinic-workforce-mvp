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

  const captureQualified = useCallback(async (video: HTMLVideoElement, timeoutMs = 3000): Promise<Blob | null> => {
    await init()
    const canvas = document.createElement('canvas')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const det = detectorRef.current.detectForVideo(video, performance.now())
      const d = det?.detections?.[0]
      if (det?.detections?.length === 1 && d.boundingBox && d.boundingBox.width > video.videoWidth * 0.15) {
        // ★ 降採樣: 最大 640 寬（ArcFace 內部 112×112，保持體積 <64KB 以支援 keepalive）
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
      }
      await new Promise(r => setTimeout(r, 120))
    }
    return null
  }, [init])

  return { captureQualified, warmup: init }
}
