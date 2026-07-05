# 診所垂直勞動力管理系統 MVP

> 小型連鎖診所入職/編更/考勤/假期/計糧系統，核心賣點：防竄改記錄。

## 技術棧

- **前端**: Next.js 14+ (App Router, PWA)
- **後端**: Next.js API Routes + Server Actions
- **資料庫**: PostgreSQL (Prisma ORM)
- **部署**: VPS (Docker Compose)

## 專案架構 (Monorepo)

```
apps/
  web/              # Next.js 主應用 (管理端 + 員工 PWA)
    app/            # App Router
    components/     # UI 組件
    lib/            # 共享邏輯
    prisma/         # 資料庫 Schema + Migrations
packages/
  shared/           # 共享類型, 工具函數, 常數
  rules/            # 可配置規則引擎 (排班/計薪/假期)
  audit/            # 審計日誌 + 防竄改層
docs/
  specs/            # 各階段規格文件
  rules/            # 計薪規則清單
scripts/            # 部署, 備份, 工具腳本
```

## 核心鐵律

1. **每個節點都用院長的真實數據驗證**
2. **所有規則做成可配置參數，絕不寫死**
3. **原始考勤記錄一旦寫入即不可改；修正用疊加**

## 開發流程

- `main` — 穩定發布分支
- `develop` — 整合測試分支
- `phase-N/xxx` — 各階段開發分支
- PR 從 `phase-N/xxx` → `develop` → `main`

## 階段總覽

| 階段 | 內容 | 狀態 |
|---|---|---|
| 0 | 規格固化 | ⏳ 待開始 |
| 1 | 帳號與權限地基 | ⏳ 待開始 |
| 2 | 入職與員工檔案 | ⏳ 待開始 |
| 3 | 編更/排班 | ⏳ 待開始 |
| 4 | 考勤（防竄改核心） | ⏳ 待開始 |
| 5 | 假期 | ⏳ 待開始 |
| 5.5 | 員工自助門戶 | ⏳ 待開始 |
| 6 | 計糧 | ⏳ 待開始 |
| 7 | 收尾與交付 | ⏳ 待開始 |

## 快速開始

```bash
# 安裝依賴
pnpm install

# 開發模式
cd apps/web
pnpm dev

# 資料庫迁移
npx prisma migrate dev
```
