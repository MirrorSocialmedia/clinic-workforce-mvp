/**
 * cwm-labdoc P4 CHUNK 2 — alias 類型常量（§11 alias 管理）。
 *
 * 放 lib 唔放 route 檔：Next 15 route type generation（.next/types）只允許
 * route module export handler（GET/POST/…）— 額外 named export 會令
 * `tsc --noEmit` 對 .next/types 報 TS2344（2026-10-06 實測）。
 */
export const ALIAS_TYPES = ['LabAlias', 'LabCustomerNo', 'ClinicNameAlias', 'ProviderNameAlias'] as const
export type AliasType = (typeof ALIAS_TYPES)[number]
