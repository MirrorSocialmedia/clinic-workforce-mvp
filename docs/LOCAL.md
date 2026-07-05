# 本地開發指南

## 環境要求

- Node.js >= 20（推薦 22 LTS）
- pnpm >= 9
- Git

## 快速開始

```bash
# 1. 克隆倉庫
git clone <repo-url> clinic-workforce-mvp
cd clinic-workforce-mvp

# 2. 安裝依賴
pnpm install

# 3. 配置環境變數
cd apps/web
cp .env.example .env

# 4. 資料庫迁移
npx prisma migrate dev

# 5. 填充種子數據
npx prisma db seed

# 6. 啟動開發服務器
pnpm dev
```

訪問 http://localhost:3000/login

## 測試帳號

| 角色 | 手機號碼 | 密碼 |
|------|---------|------|
| Owner | 91000001 | demo1234 |
| Manager | 91000002 | demo1234 |
| Accountant | 91000003 | demo1234 |
| Employee | 91000004 | demo1234 |

## 專案結構

```
apps/web/
├── prisma/
│   ├── schema.prisma      # 資料庫 Schema
│   ├── migrations/        # 遷移文件
│   └── seed.ts            # 種子數據
├── src/
│   ├── app/
│   │   ├── api/           # API Routes (後端)
│   │   │   ├── auth/      # 認證相關
│   │   │   ├── employees/ # 員工管理
│   │   │   ├── shifts/    # 排班
│   │   │   ├── punches/   # 考勤
│   │   │   ├── leave-requests/ # 假期
│   │   │   ├── payroll-runs/   # 計糧
│   │   │   └── ...
│   │   ├── (protected)/   # 需要登入的頁面
│   │   ├── login/         # 登入頁
│   │   ├── layout.tsx     # 根佈局
│   │   └── globals.css    # 全域樣式
│   └── lib/
│       ├── auth.ts        # JWT 認證
│       ├── rbac.ts        # 權限檢查
│       ├── config.ts      # 配置
│       ├── prisma.ts      # DB 連接
│       ├── audit-context.ts  # 審計上下文
│       └── ...
└── public/                # 靜態資源
docs/
├── specs/                 # 階段規格
└── rules/                 # 規則配置
scripts/                   # 工具腳本
```

## 開發命令

```bash
# 開發模式（熱重載）
cd apps/web && pnpm dev

# 生產構建
pnpm build

# 生產預覽
pnpm start

# 資料庫相關
npx prisma studio              # 資料庫 GUI
npx prisma migrate dev         # 創建並應用 migration
npx prisma migrate reset       # 重置資料庫（刪除所有數據）
npx prisma generate            # 生成 Prisma Client

# 格式化和類型檢查
npx tsc --noEmit               # 類型檢查
```

## 資料庫

開發環境使用 SQLite，生產環境使用 PostgreSQL。

### 切換到 PostgreSQL（本地）

```bash
# 1. 啟動本地 PostgreSQL
docker run --name clinic-postgres -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:16

# 2. 修改 .env
DATABASE_URL="postgresql://postgres:dev@localhost:5432/clinic_mvp"

# 3. 修改 schema.prisma
# provider = "postgresql"

# 4. 執行 migration
npx prisma migrate dev
```

## 開發規範

1. **分支策略**
   - `main` — 穩定發布
   - `phase-N/xxx` — 功能開發
   - PR 合併到 `main`

2. **API 開發**
   - 所有 API 端點必須有 RBAC 檢查
   - 錯誤返回 JSON 格式 `{ error: "message" }`
   - 寫操作記錄審計日誌

3. **前端開發**
   - 使用 Next.js App Router
   - 響應式設計（手機優先）
   - 全域 loading 狀態

4. **提交信息**
   - `feat: 新增功能`
   - `fix: 修復錯誤`
   - `docs: 文件更新`
   - `refactor: 代碼重構`
   - `chore: 日常維護`
