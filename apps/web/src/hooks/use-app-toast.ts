import { toast } from 'sonner'

export function showToast(
  message: string,
  type: 'success' | 'error' | 'info' = 'success'
) {
  if (type === 'success') toast.success(message)
  else if (type === 'error') toast.error(message)
  else toast.info(message)
}

export { toast } from 'sonner'
