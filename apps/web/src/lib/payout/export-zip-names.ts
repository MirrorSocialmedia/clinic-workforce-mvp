// ★ cwm-exportzip-20261012：ZIP 入面檔名 —— 醫生全名（老闆要求）；剷走檔名唔准用嘅字元；同名加 (2)(3)
export function zipFileName(base: string, used: Set<string>, ext = '.xlsx'): string {
  const clean = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim() || '未命名'
  let name = `${clean}${ext}`
  for (let i = 2; used.has(name); i++) name = `${clean} (${i})${ext}`
  used.add(name)
  return name
}
