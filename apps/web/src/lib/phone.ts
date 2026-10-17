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

/** 一段（已去除空格／符號，只剩數字同 +）→ E.164；唔合法 → null。 */
function classifyPhone(s: string): string | null {
  if (/^\+852\d{8}$/.test(s)) return s;
  if (/^852\d{8}$/.test(s)) return `+${s}`;
  if (/^[2-9]\d{7}$/.test(s)) return `+852${s}`; // 香港本地 8 位
  // ★ cwi-patient-identify-20261017：內地手機 — 86 開頭（無 +）／冇國碼 11 位（1 開頭；香港號只有 8 位唔會撞）
  if (/^861\d{10}$/.test(s)) return `+${s}`;
  if (/^1\d{10}$/.test(s)) return `+86${s}`;
  if (/^\+\d{8,15}$/.test(s)) return s; // 其他國家保留
  return null;
}

/** 一段入面用空格分隔咗幾個號（「85291234567 61234567」「9123 4567 6123 4567」）→ 由左至右，
 *  每次試最長嘅連續幾段合併（最多 4 段）可以成為合法號碼。 */
function splitSpacedNumbers(seg: string): string[] {
  const toks = seg.split(/\s+/).map((t) => t.replace(/[^\d+]/g, '')).filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < toks.length) {
    let used = 0;
    for (let n = Math.min(4, toks.length - i); n >= 1; n--) {
      const c = classifyPhone(toks.slice(i, i + n).join(''));
      if (c) {
        out.push(c);
        used = n;
        break;
      }
    }
    i += used || 1;
  }
  return out;
}

/**
 * Apricot 原始電話 → E.164 陣列（一個欄位可能有多個號）。
 *
 * ★ cwi-patient-identify-20261017（擁有人拍板：多格式都要對得到）：
 *   - 號內空格／橫線／括號照收：「9123 4567」「+852 9123 4567」「(852) 9123-4567」→ +85291234567
 *   - 多號：明確分隔符（/ , ; 、 |）先拆；一段入面再有空格分隔嘅多個號亦拆得出
 *   - 內地手機：+86／86／冇國碼 11 位 → +86…
 *   舊規格入面已合法嘅寫法輸出不變（固定向量照舊）。改呢度必須同步 wa-inbox src/lib/phone-hash.ts。
 */
export function normalizeHkPhones(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const seg of raw.split(/[\/,;、|]+/)) {
    const whole = classifyPhone(seg.replace(/[^\d+]/g, ''));
    if (whole) out.push(whole);
    else out.push(...splitSpacedNumbers(seg));
  }
  return out.filter((v, i, a) => a.indexOf(v) === i);
}

/** 多號 hash（follow-up 索引 phoneHashes String[] — wa-inbox 用 hasSome 配對）。 */
export function phoneHashes(raw: string | null | undefined, key: string): string[] {
  return normalizeHkPhones(raw).map((p) => createHmac('sha256', key).update(p).digest('hex'));
}
