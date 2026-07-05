# 診所垂直勞動力管理系統 MVP

> 小型連鎖診所入職/編更/考勤/假期/計糧系統，核心賣點：**防竄改記錄**。

## 技術棧

- **前端**: Next.js 14+ (App Router, PWA)
- **後端**: Next.js API Routes + Server Actions
- **資料庫**: PostgreSQL (Prisma ORM) / SQLite (開發)
- **部署**: VPS (Docker Compose + Nginx)
- **認證**: JWT (jsonwebtoken + bcryptjs)

## 專案架構 (Monorepo)

```
apps/
  web/              # Next.js 主應用 (管理端 + 員工 PWA)
    app/            # App Router (API + Pages)
    components/     # UI 組件
    lib/            # 共享邏輯 (auth, rbac, config)
    prisma/         # 資料庫 Schema + Migrations
    public/         # 靜態資源 (PWA icons, manifest, sw)
packages/           # (future) 共享包
docs/               # 規格文件、部署指南
scripts/            # 備份、恢復腳本
docker-compose.yml  # 生產部署
Dockerfile          # Next.js 生產構建
nginx/              # Nginx 反向代理配置
```

## 核心鐵律

1. **每個節點都用院長的真實數據驗證**
2. **所有規則做成可配置參數，絕不寫死**
3. **原始考勤記錄一旦寫入即不可改；修正用疊加**

## 功能總覽

### 🔐 帳號與權限 (Phase 1)
- 四層 RBAC：OWNER → MANAGER → ACCOUNTANT → EMPLOYEE
- JWT 認證 + bcrypt 密碼加密
- 診所級別資料隔離
- 審計日誌（Append-only）

### 👥 入職與員工檔案 (Phase 2)
- 員工檔案管理（CRUD）
- 多診所支援
- 薪資規則設定
- CSV 匯入

### 📅 編更/排班 (Phase 3)
- Shift 模板管理
- 排班創建與分配
- 班次變更申請（Swap/Cover/Report）
- 排班規則驗證（最大工時、休息間隔）

### 📋 考勤（防竄改核心）(Phase 4)
- QR Code 打卡（動態令牌）
- Append-only 考勤記錄
- 打卡修正（Overlay 模式，不修改原紀錄）
- 每日 SHA-256 雜湊鏈
- 審計日誌追蹤所有操作

### 🏖️ 假期管理 (Phase 5)
- 假期類型配置（年假/病假/無薪假）
- 假期申請與審批流程
- 假期額度追蹤
- 員工假期自助門戶

### 💰 計糧管理 (Phase 6)
- 計糧周期管理
- 自動計算（工時、加班、假期、扣款）
- 拆帳支援（醫生）
- CSV/PDF 匯出
- 考勤異常報告

### 🔧 系統功能 (Phase 7)
- Docker Compose 部署（Next.js + PostgreSQL + Nginx）
- PWA 支援（離線可用、加到主畫面）
- 密碼重置（Email/SMS Token）
- 自動備份（每日 + 異地）
- PDPO 合規（資料加密、存取控制、保留期限）
- 響應式設計（手機/平板/桌面）

## 開發流程

- `main` — 穩定發布分支
- `phase-N/xxx` — 各階段開發分支
- PR 從 `phase-N/xxx` → `main`

## 快速開始

### 本地開發

```bash
# 安裝依賴
pnpm install

# 開發模式
cd apps/web
cp .env.example .env
pnpm dev

# 資料庫迁移
npx prisma migrate dev

# 填充種子數據
npx prisma db seed
```

訪問 http://localhost:3000/login

### 測試帳號

| 角色 | 手機號碼 | 密碼 |
|------|---------|------|
| 👑 Owner | 91000001 | demo1234 |
| 📋 Manager | 91000002 | demo1234 |
| 💰 Accountant | 91000003 | demo1234 |
| 👤 Employee | 91000004 | demo1234 |

### 生產部署

```bash
# 1. 配置環境
cp .env.production.example .env.production
# 編輯 .env.production（填寫所有必填項）

# 2. 準備 SSL 憑證
mkdir -p nginx/ssl
# 放入 fullchain.pem 和 privkey.pem

# 3. 啟動
export $(cat .env.production | xargs)
docker compose up -d --build

# 4. 資料庫迁移
docker compose exec web npx prisma migrate deploy
```

詳細部署指南請參考 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## 階段狀態

| 階段 | 內容 | 狀態 |
|---|---|---|
| 0 | 規格固化 | ✅ 完成 |
| 1 | 帳號與權限地基 | ✅ 完成 |
| 2 | 入職與員工檔案 | ✅ 完成 |
| 3 | 編更/排班 | ✅ 完成 |
| 4 | 考勤（防竄改核心） | ✅ 完成 |
| 5 | 假期 | ✅ 完成 |
| 5.5 | 員工自助門戶 | ✅ 完成 |
| 6 | 計糧 | ✅ 完成 |
| 7 | 收尾與交付 | ✅ 完成 |

## 文檔

- [本地開發指南](docs/LOCAL.md) — 開發環境設置
- [VPS 部署指南](docs/DEPLOYMENT.md) — 生產部署步驟
- [配置參數說明](docs/CONFIG.md) — 所有可配置參數
- [PDPO 合規聲明](docs/PDPO.md) — 私隱條例合規
- [階段規格](docs/specs/) — 各階段詳細規格

## 注意事項

- ❌ 不做 MPF / 報稅 / 法定精算
- ❌ 不做自動發薪（需要 MSO 牌照）
- ❌ 不做區塊鏈（append-only + hash 已足夠）

## License

Internal use only.
