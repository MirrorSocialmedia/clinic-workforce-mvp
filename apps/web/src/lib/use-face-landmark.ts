'use client'
import { useRef, useCallback } from 'react'

export type Pose = 'frontal' | 'left' | 'right' | 'any'

export function useFaceLandmark() {
 const lmRef = useRef<any>(null)

 const init = useCallback(async () => {
  if (lmRef.current) return
  const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
  const vision = await FilesetResolver.forVisionTasks('/models/wasm')
  lmRef.current = await FaceLandmarker.createFromOptions(vision, {
   baseOptions: { modelAssetPath: '/models/face_landmarker.task' },
   runningMode: 'VIDEO', numFaces: 1,
  })
 }, [])

 const shoot = useCallback(async (video: HTMLVideoElement, pose: Pose): Promise<{ blob?: Blob; error?: string; ratio?: number }> => {
  await init()
  const res = lmRef.current.detectForVideo(video, performance.now())
  const lm = res?.faceLandmarks?.[0]
  if (!lm) return { error: '未偵測到人臉，請正對鏡頭' }

  const nose = lm[1], right = lm[234], left = lm[454]
  const ratio = (nose.x - right.x) / Math.max(1e-6, left.x - right.x)

  if (pose === 'frontal' && (ratio < 0.40 || ratio > 0.60)) return { error: '請正對鏡頭', ratio }
  if (pose === 'left' && ratio > 0.36) return { error: '請再向左轉一些', ratio }
  if (pose === 'right' && ratio < 0.64) return { error: '請再向右轉一些', ratio }

  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth; canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(video, 0, 0)
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let luma = 0
  for (let i = 0; i < d.length; i += 4 * 50) luma += 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2]
  luma /= (d.length / (4 * 50))
  if (luma < 55) return { error: '光線不足，請移到較亮處' }

  const blob = await new Promise<Blob | null>(r => canvas.toBlob(b => r(b), 'image/jpeg', 0.85))
  return blob ? { blob } : { error: '擷取失敗，請重試' }
 }, [init])

 return { shoot }
}
