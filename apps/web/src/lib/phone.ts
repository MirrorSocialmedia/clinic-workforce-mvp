// ============================================================
// HK 電話正規化 + 多號 hash（cwi-followup-p0-20260915 — MD §1.2 逐字）
//
// 背景：Apricot `phoneNum` 格式唔統一（實測 8 位本地號、19 字多號／帶區號）。
// follow-up 配對靠 phoneHash（HMAC-SHA256，key = PHONE_HASH_KEY）；格式唔一致
// → hash 唔同 → 配對唔到 → follow-up 發唔出。喺 workforce 側做（原始號碼唔過界 —
// 只回 phoneHashes[]）。
//
// 同 src/lib/phone-hash.ts 嘅關係：舊 `phoneHash`（單數，normalizePhone 852-11 位
// 取尾 8）係 read-chain／availability 既有行為，照用；本檔 `normalizeHkPhones` /
// `phoneHashes`（多號）係 follow-up 索引新規格。
// ============================================================

import { createHmac } from 'node:crypto';

/** Apricot 原始電話 → E.164 陣列（一個欄位可能有多個號）。 */
export function normalizeHkPhones(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\/,;、\s]+/) // 「9123 4567 / 6123 4567」
    .map((s) => s.replace(/[^\d+]/g, ''))
    .flatMap((s) => {
      if (/^\+852\d{8}$/.test(s)) return [s];
      if (/^852\d{8}$/.test(s)) return [`+${s}`];
      if (/^\d{8}$/.test(s) && /^[2-9]/.test(s)) return [`+852${s}`]; // 香港本地 8 位
      if (/^\+\d{8,15}$/.test(s)) return [s]; // 其他國家保留
      return []; // 唔合法 → 丟
    })
    .filter((v, i, a) => a.indexOf(v) === i);
}

/** 多號 hash（follow-up 索引 phoneHashes String[] — wa-inbox 用 hasSome 配對）。 */
export function phoneHashes(raw: string | null | undefined, key: string): string[] {
  return normalizeHkPhones(raw).map((p) => createHmac('sha256', key).update(p).digest('hex'));
}
