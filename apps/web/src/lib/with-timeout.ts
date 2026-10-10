// ★ cwm-facemissing-20261010：promise 時限 —— 逾時掟 name=<name> 嘅 Error；
//   原 promise 之後先完成（例如遲到嘅相機 stream）就交俾 onLate 收尾
export function withTimeout<T>(p: Promise<T>, ms: number, name: string, onLate?: (v: T) => void): Promise<T> {
  let timedOut = false
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { timedOut = true; reject(Object.assign(new Error(`${name} after ${ms}ms`), { name })) }, ms)
    p.then(
      v => { if (timedOut) { try { onLate?.(v) } catch { /* ignore */ } } else { clearTimeout(t); resolve(v) } },
      e => { if (!timedOut) { clearTimeout(t); reject(e) } },
    )
  })
}

