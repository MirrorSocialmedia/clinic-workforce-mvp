/**
 * cwm-labdoc P1 — 存底儲存層（§4.1）
 *
 * LAB_DOC_DIR（docker volume lab_docs → /data/lab-docs）：
 *   {yyyy}/{mm}/{fileId}.bin                    — 原檔（加密）
 *   {yyyy}/{mm}/{fileId}.p{n}.jpg.bin           — 顯示圖（長邊 1600，加密）
 *   {yyyy}/{mm}/{fileId}.p{n}.thumb.jpg.bin     — 縮圖（長邊 320，加密）
 *
 * 安全：
 *   - 路徑只可以由 storageKey／pagesJson 讀；storageKey 必過 STORAGE_KEY_RE
 *     （防 path traversal — 唔准用檔名／query string 拼路徑）
 *   - 寫檔：先 *.tmp → fsync → rename（原子）
 *   - 每晚 sweep 刪孤兒（碟有、DB 冇、mtime > 24h）
 */
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { decrypt, encrypt, getCurrentKid } from './crypto'

/** storageKey 嚴格格式：{yyyy}/{mm}/{fileId 25 位 cuid}(.p{n}(.thumb)?)?.bin */
export const STORAGE_KEY_RE =
  /^\d{4}\/\d{2}\/[a-z0-9]{25}(\.p\d+(?:\.thumb)?\.jpg)?\.bin$/

export function getLabDocDir(): string {
  const dir = process.env.LAB_DOC_DIR
  if (!dir) throw new Error('LAB_DOC_DIR 未設')
  return dir
}

/**
 * 由 storageKey 拼絕對路徑。
 * @throws 如果 storageKey 唔合格式（path traversal guard）
 */
export function keyToPath(storageKey: string): string {
  if (!STORAGE_KEY_RE.test(storageKey)) {
    throw new Error(`invalid storageKey: ${storageKey}`)
  }
  // resolve 之後仍必須喺 root 下（雙保險）
  const abs = path.resolve(getLabDocDir(), storageKey)
  const root = path.resolve(getLabDocDir())
  if (!abs.startsWith(root + path.sep)) {
    throw new Error(`storageKey escapes LAB_DOC_DIR: ${storageKey}`)
  }
  return abs
}

/** 由 uploadedAt 計 storageKey 前綴 {yyyy}/{mm}（HK wall-clock — 同 app 慣例） */
export function storageKeyPrefix(date: Date): string {
  const d = new Date(date.getTime() + 8 * 3600 * 1000) // HK = UTC+8
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export function buildStorageKey(fileId: string, uploadedAt: Date): string {
  return `${storageKeyPrefix(uploadedAt)}/${fileId}.bin`
}
export function buildPageKey(fileId: string, uploadedAt: Date, pageNo: number, variant: 'display' | 'thumb' = 'display'): string {
  const base = `${storageKeyPrefix(uploadedAt)}/${fileId}.p${pageNo}`
  return variant === 'thumb' ? `${base}.thumb.jpg.bin` : `${base}.jpg.bin`
}

/** 寫加密檔：tmp → fsync → rename（原子；中途死唔會留半個檔） */
export async function saveEncrypted(storageKey: string, plain: Buffer, kid?: string): Promise<void> {
  const abs = keyToPath(storageKey)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const blob = encrypt(plain, kid)
  const tmp = `${abs}.tmp`
  const fd = await fs.open(tmp, 'w')
  try {
    await fd.writeFile(blob)
    await fd.sync()
  } finally {
    await fd.close()
  }
  await fs.rename(tmp, abs)
}

export async function readEncrypted(storageKey: string): Promise<Buffer> {
  const abs = keyToPath(storageKey)
  const buf = await fs.readFile(abs).catch((e) => {
    if (e.code === 'ENOENT') throw new Error(`labdoc file missing: ${storageKey}`)
    throw e
  })
  return decrypt(buf).plain
}

/** 刪加密檔；回傳真 = 真刪咗、假 = 原本唔存在（ENOENT 容忍 — purge 冪等重試用） */
export async function deleteEncrypted(storageKey: string): Promise<boolean> {
  const abs = keyToPath(storageKey)
  try {
    await fs.unlink(abs)
    return true
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e
    return false
  }
}

export async function fileExists(storageKey: string): Promise<boolean> {
  try {
    await fs.access(keyToPath(storageKey), fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 孤兒 sweep（§4.1）：碟上有、DB 冇（唔喺任何 LabFile.storageKey／pagesJson）、
 * mtime > 24h 嘅 .bin 檔 → 刪。回傳刪咗幾多。
 * 24h 緩衝防「DB commit 先、sweep 後」嘅 race（正常寫檔流程先寫碟後 commit，
 * 中途死嘅檔要等足 24h 先清 — 保守）。
 * ★ 一併清 `.bin.tmp`：saveEncrypted 寫到一半死（rename 前）會留 tmp；
 *   冪等重試會直接 rename 覆蓋 .bin，但 tmp 殘留唔會自己消失 — 24h 後當孤兒清。
 */
export async function sweepOrphans(now: Date = new Date()): Promise<number> {
  const root = getLabDocDir()
  const allKeys = await listAllStorageKeys()
  const dbKeys = new Set<string>(await loadDbStorageKeys())
  const cutoff = now.getTime() - 24 * 3600 * 1000
  let deleted = 0
  for (const rel of allKeys) {
    // rel 可能係 'xxx.bin' 或 'xxx.bin.tmp'
    const isTmp = rel.endsWith('.bin.tmp')
    const coreKey = isTmp ? rel.slice(0, -'.tmp'.length) : rel
    if (!STORAGE_KEY_RE.test(coreKey)) continue // 唔認得嘅形狀 → 唔郁（保守）
    if (dbKeys.has(coreKey) && !isTmp) continue // DB 有 = 正常檔
    // （tmp 即使 DB 有 coreKey 都係殘留 — rename 成功後 tmp 唔應該存在）
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root + path.sep)) continue // 雙保險
    const st = await fs.stat(abs).catch(() => null)
    if (!st || st.mtimeMs >= cutoff) continue
    await fs.unlink(abs)
    deleted++
  }
  return deleted
}

/** 行完 LAB_DOC_DIR 全部 .bin key（相對路徑；一併收集 .bin.tmp 殘留） */
async function listAllStorageKeys(): Promise<string[]> {
  const root = getLabDocDir()
  const out: string[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (e: any) {
      if (e.code === 'ENOENT') return
      throw e
    }
    for (const en of entries) {
      const r = rel ? `${rel}/${en.name}` : en.name
      if (en.isDirectory()) {
        await walk(path.join(dir, en.name), r)
      } else if (en.isFile() && (en.name.endsWith('.bin') || en.name.endsWith('.bin.tmp'))) {
        out.push(r)
      }
    }
  }
  await walk(root, '')
  return out
}

async function loadDbStorageKeys(): Promise<string[]> {
  // 延遲 import 防 cycle（prisma 單例）
  const { prisma } = await import('@/lib/prisma')
  const files = await prisma.labFile.findMany({ select: { storageKey: true, pagesJson: true } })
  const keys = new Set<string>()
  for (const f of files) {
    keys.add(f.storageKey)
    const pages = (f.pagesJson ?? []) as Array<{ displayKey?: string; thumbKey?: string }>
    for (const p of pages) {
      if (p.displayKey) keys.add(p.displayKey)
      if (p.thumbKey) keys.add(p.thumbKey)
    }
  }
  return [...keys]
}
