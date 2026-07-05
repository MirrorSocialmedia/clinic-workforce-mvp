# 階段 1 — 帳號與權限地基（1.5 週）

**Kairo Task**: `mr7meczx9lzzx` | **分支**: `phase1/auth-rbac-audit` (從 main 建立)

## 目標

建立「誰能做什麼、做了留什麼痕」的骨架。這是防竄改賣點的地基。

## 技術架構

- **Next.js 14 App Router** + **Prisma** + **PostgreSQL**
- **認證**: NextAuth.js v5 (credentials provider, 手機+密碼)
- **RBAC**: 自訂 middleware + decorator
- **審計日誌**: 自動攔截所有 mutation，寫入 `AuditLog`

## 功能範圍

### 1. 資料庫 Schema 落地

- 將階段 0 的 Prisma Schema 落到 `apps/web/prisma/schema.prisma`
- 執行 `prisma migrate dev` 建立資料庫
- 種子數據：6 家診所 + 4 個測試用戶（各角色 1 個）

### 2. 認證系統

- 登入頁：手機號碼 + 密碼
- 註冊頁：僅 OWNER 可新增用戶（後續可開放邀請鏈接）
- Session 管理：JWT-based, 30 天有效
- 登出功能

### 3. 多分店結構（6 家店，跨店人員池）

- `Clinic` CRUD（僅 OWNER）
- `UserClinic` 多對多關聯
- 支援同一用戶屬於多家店
- 數據隔離：MANAGER 只看本店，OWNER 看全部

### 4. RBAC 權限系統

- **4 個角色**: `OWNER`, `MANAGER`, `ACCOUNTANT`, `EMPLOYEE`
- Middleware: 每個 API route 檢查角色權限
- Helper: `requireRole(['OWNER', 'MANAGER'])`, `requireClinicAccess(clinicId)`
- 權限矩陣實作（參考階段 0 的 RBAC 文件）

### 5. 審計日誌（Append-Only 核心）

- **自動攔截**: 所有 Prisma `create`/`update`/`delete` 自動寫審計日誌
- **手動標記**: 敏感操作額外標記
- **不可刪改**:
  - API 層: 不提供 AuditLog 的 UPDATE/DELETE route
  - 資料庫層: 触发器拒絕 DELETE/UPDATE（後續加）
  - Prisma 層: 不暴露 AuditLog write 除了 append
- **審計日誌頁面**: 可按員工/時間/操作類型篩查

### 6. 管理端 UI

- Dashboard 首頁（各店概要）
- 診所管理頁（增刪診所）
- 用戶管理頁（增刪用戶、分配診所、設角色）
- 審計日誌頁（篩查 + 查看）
- 側邊欄導航（按角色顯示/隱藏）

## 資料模型（Prisma）

```prisma
model Clinic {
  id        String   @id @default(cuid())
  name      String
  address   String?
  config    Json?    // 診所特定配置
  users     UserClinic[]
  employees EmployeeClinic[]
  shifts    Shift[]
  punches   PunchRecord[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model User {
  id        String   @id @default(cuid())
  name      String
  phone     String   @unique
  email     String?
  password  String   // bcrypt hash
  role      UserRole @default(EMPLOYEE)
  status    UserStatus @default(ACTIVE)
  clinics   UserClinic[]
  employee  Employee?
  auditLogs AuditLog[] @relation("ActorLogs")
  approvals AuditLog[] @relation("ApproverLogs")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

enum UserRole { OWNER, MANAGER, ACCOUNTANT, EMPLOYEE }
enum UserStatus { ACTIVE, INACTIVE, RESIGNED, SUSPENDED }

model UserClinic {
  userId   String @unique // 主要所屬診所（用於數據隔離）
  clinicId String
  user     User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  clinic   Clinic @relation(fields: [clinicId], references: [id], onDelete: Cascade)
  isPrimary Boolean @default(true)
  createdAt DateTime @default(now())

  @@id([userId, clinicId])
}

model Employee {
  id         String   @id @default(cuid())
  userId     String   @unique
  user       User     @relation(fields: [userId], references: [id])
  clinics    EmployeeClinic[]
  payRules   PayRule[]
  shifts     Shift[]
  punches    PunchRecord[]
  joinDate   DateTime
  leaveDate  DateTime?
  status     EmployeeStatus @default(ACTIVE)
  notes      String?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
}

enum EmployeeStatus { ACTIVE, ON_LEAVE, RESIGNED, PROBATION }

model EmployeeClinic {
  employeeId String
  clinicId   String
  employee   Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  clinic     Clinic   @relation(fields: [clinicId], references: [id], onDelete: Cascade)
  isPrimary  Boolean  @default(true)
  joinedAt   DateTime @default(now())

  @@id([employeeId, clinicId])
}

model PayRule {
  id            String   @id @default(cuid())
  employeeId    String
  employee      Employee @relation(fields: [employeeId], references: [id], onDelete: Cascade)
  payType       PayType
  baseAmount    Float?
  configJson    Json?    // 可配置參數
  effectiveFrom DateTime
  effectiveTo   DateTime?
  isActive      Boolean  @default(true)
  createdBy     String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

enum PayType { MONTHLY, DAILY, HOURLY, SPLIT }

model Shift {
  id          String      @id @default(cuid())
  employeeId  String
  clinicId    String
  date        DateTime
  startTime   DateTime
  endTime     DateTime
  role        String?     // 當更角色
  status      ShiftStatus @default(CONFIRMED)
  notes       String?
  createdBy   String
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt
  employee    Employee    @relation(fields: [employeeId], references: [id])
  clinic      Clinic      @relation(fields: [clinicId], references: [id])
}

enum ShiftStatus { DRAFT, CONFIRMED, CANCELLED, COMPLETED }

model PunchRecord {
  id          String     @id @default(cuid())
  employeeId  String
  clinicId    String
  punchTime   DateTime
  punchType   PunchType
  source      PunchSource
  tokenValid  Boolean?
  deviceInfo  String?    // 打卡設備信息
  notes       String?
  createdAt   DateTime   @default(now())
  employee    Employee   @relation(fields: [employeeId], references: [id])
  clinic      Clinic     @relation(fields: [clinicId], references: [id])

  @@index([employeeId, punchTime])
}

enum PunchType { CLOCK_IN, CLOCK_OUT }
enum PunchSource { QR_DYNAMIC, QR_STATIC, MANUAL_CORRECTION, SYSTEM }

model AuditLog {
  id          String   @id @default(cuid())
  actorId     String
  action      String   // CREATE, UPDATE, DELETE, CORRECT, APPROVE, REJECT
  entity      String   // 實體名稱
  entityId    String
  clinicId    String?
  beforeJson  Json?
  afterJson   Json?
  notes       String?
  ipAddress   String?
  userAgent   String?
  createdAt   DateTime @default(now())
  actor       User     @relation("ActorLogs", fields: [actorId], references: [id])

  @@index([actorId, createdAt])
  @@index([entity, entityId])
  @@index([clinicId, createdAt])
}
```

## 驗收標準

- [ ] 用 4 種角色分別登入，各自只看得到/做得到權限內的事
- [ ] 隨便做一個修改動作，`audit_log` 立刻多一筆完整記錄
- [ ] 嘗試用任何帳號（含最高權限）刪 audit_log 的一筆 → 失敗
- [ ] 多診所數據隔離：A 店經理看不到 B 店數據
- [ ] 跨店用戶可被排到不同診所
- [ ] 登入/登出流程正常
- [ ] Dashboard 顯示各診所概要

## API Routes

```
POST   /api/auth/login
POST   /api/auth/logout
POST   /api/auth/register        # 僅 OWNER
GET    /api/clinics
POST   /api/clinics              # 僅 OWNER
PUT    /api/clinics/:id          # 僅 OWNER
DELETE /api/clinics/:id          # 僅 OWNER
GET    /api/users
POST   /api/users                # 僅 OWNER
PUT    /api/users/:id            # 僅 OWNER
GET    /api/audit-logs           # OWNER/MANAGER/ACCOUNTANT
GET    /api/dashboard            # 按角色返回不同數據
```

## 開發步驟

1. 建立 `phase1/auth-rbac-audit` 分支
2. 初始化 Next.js 專案 + Prisma + PostgreSQL
3. 落地 Prisma Schema，執行 migration
4. 實作認證系統（NextAuth）
5. 實作 RBAC middleware + helpers
6. 實作審計日誌自動攔截
7. 實作 API routes
8. 實作管理端 UI 頁面
9. 測試所有驗收標準
10. commit → push → 建立 PR

## 注意事項

- 所有配置參數不寫死（診所數量、角色、權限都從配置讀取）
- 審計日誌是核心賣點，必須做穩
- 性能考量：審計日誌量大時需要分頁 + 索引
- 安全：密碼 bcrypt 加密，session 安全設置
