# 階段 0 — 規格固化（1 週）

**Kairo Task**: `mr7meczx9lzzx` | **分支**: `phase0/specs`

## 目標

把診所勞動力管理的規則變成明確的可配置參數，不寫死任何業務邏輯。

## 產出清單

### 1. 資料模型 (Prisma Schema)

```prisma
// 核心實體（階段 0 定義，後面迭代）
model Clinic {
  id        String   @id @default(uuid())
  name      String
  address   String?
  employees Employee[]
  shifts    Shift[]
  punches   PunchRecord[]
  createdAt DateTime @default(now())
}

model User {
  id        String   @id @default(uuid())
  name      String
  phone     String   @unique
  email     String?  @unique
  role      UserRole
  status    UserStatus @default(ACTIVE)
  clinics   UserClinic[]
  auditLogs AuditLog[] @relation("Actor")
  createdAt DateTime @default(now())
}

enum UserRole { OWNER, MANAGER, ACCOUNTANT, EMPLOYEE }
enum UserStatus { ACTIVE, INACTIVE, RESIGNED }

model Employee {
  id          String    @id @default(uuid())
  userId      String    @unique
  user        User      @relation(fields: [userId], references: [id])
  clinics     EmployeeClinic[]
  payRules    PayRule[]
  shifts      Shift[]
  punches     PunchRecord[]
  joinDate    DateTime
  leaveDate   DateTime?
  status      EmployeeStatus @default(ACTIVE)
}

model PayRule {
  id            String   @id @default(uuid())
  employeeId    String
  employee      Employee @relation(fields: [employeeId], references: [id])
  payType       PayType  // MONTHLY, DAILY, HOURLY, SPLIT
  baseAmount    Float?
  otMultiplier  Float?   // 加班倍率
  splitRatio    Float?   // 拆帳比例 (醫生)
  effectiveFrom DateTime
  effectiveTo   DateTime?
  configJson    Json?    // 可擴展參數
}

enum PayType { MONTHLY, DAILY, HOURLY, SPLIT }

model Shift {
  id          String   @id @default(uuid())
  employeeId  String
  clinicId    String
  date        DateTime
  startTime   DateTime
  endTime     DateTime
  role        String   // 當更角色
  status      ShiftStatus @default(CONFIRMED)
  createdBy   String
  createdAt   DateTime @default(now())
}

model PunchRecord {
  id           String   @id @default(uuid())
  employeeId   String
  clinicId     String
  punchTime    DateTime
  punchType    PunchType // CLOCK_IN, CLOCK_OUT
  source       PunchSource // QR_DYNAMIC, QR_STATIC, CORRECTION
  tokenValid   Boolean?
  createdAt    DateTime @default(now())
  /// APPEND ONLY - 永不 UPDATE/DELETE
}

model AuditLog {
  id          String   @id @default(uuid())
  actorId     String
  action      String   // CREATE, UPDATE, DELETE, CORRECT
  entity      String   // 實體名稱
  entityId    String
  beforeJson  Json?
  afterJson   Json?
  createdAt   DateTime @default(now())
  /// APPEND ONLY
}
```

### 2. 計薪規則（可配置參數）

每種角色一條完整 if-then 公式，存於 `pay_rules.config_json`：

```json
{
  "nurse_hourly": {
    "pay_type": "HOURLY",
    "base_rate": 65,
    "ot_threshold": 44,
    "ot_multiplier": 1.5,
    "formula": "min(hours, 44) * base_rate + max(0, hours - 44) * base_rate * 1.5"
  },
  "doctor_split": {
    "pay_type": "SPLIT",
    "split_ratio": 0.3,
    "formula": "consultation_fees * split_ratio"
  },
  "receptionist_monthly": {
    "pay_type": "MONTHLY",
    "base_salary": 18000,
    "absence_deduction_rate": 0.5,
    "formula": "base_salary - absent_days * (base_salary / 26) * deduction_rate"
  }
}
```

### 3. 排班硬規則（可配置）

```json
{
  "min_staff_per_shift": {
    "description": "每時段最少人員",
    "rules": [
      {"clinic_id": "*", "shift_time": "09:00-14:00", "required": {"doctor": 1, "nurse": 1}},
      {"clinic_id": "*", "shift_time": "14:00-19:00", "required": {"doctor": 1, "nurse": 1}}
    ]
  },
  "max_consecutive_hours": 12,
  "min_rest_between_shifts": 8,
  "collision_check": true
}
```

### 4. 權限矩陣

| 操作 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|---|---|---|---|---|
| 看全部數據 | ✅ | 本店 | 計糧唯讀 | 自己 |
| 排班/改班 | ✅ | ✅ | ❌ | ❌ |
| 審批請假 | ✅ | ✅ | ❌ | ❌ |
| 補打卡審批 | ✅ | ✅ | ❌ | ❌ |
| 直接改考勤 | ❌ | ❌ | ❌ | ❌ |
| 補打卡申請 | ❌ | ❌ | ❌ | ✅ |
| 看審計日誌 | ✅ | ✅ | ✅ | ❌ |
| 設定規則 | ✅ | ❌ | ❌ | ❌ |

## 驗收標準

- [ ] Prisma Schema 定義完整（所有核心實體）
- [ ] 計薪規則 JSON 範例可被計薪引擎解析
- [ ] 排班規則 JSON 範例可被校驗引擎解析
- [ ] 權限矩陣文件完成
- [ ] 指揮大神確認「對，就是這樣」

## 開發步驟

1. 建立 `phase0/specs` 分支
2. 寫明 Prisma Schema (`apps/web/prisma/schema.prisma`)
3. 寫明計薪/排班規則 JSON 範例 (`docs/rules/`)
4. 寫明權限矩陣 (`docs/specs/rbac-matrix.md`)
5. commit → push → PR → 指揮大神確認
