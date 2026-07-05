# 配置參數說明

## 環境變數

### 必填項

| 變數 | 說明 | 範例 |
|------|------|------|
| `DATABASE_URL` | 資料庫連接字符串 | `postgresql://user:pass@host:5432/db` |
| `JWT_SECRET` | JWT 簽名金鑰（必須隨機） | `openssl rand -base64 32` |
| `NEXTAUTH_SECRET` | NextAuth 密钥 | `openssl rand -base64 32` |

### 可選項

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `NEXTAUTH_URL` | `http://localhost:3000` | 應用訪問 URL |
| `SMTP_HOST` | — | SMTP 服務器地址 |
| `SMTP_PORT` | `587` | SMTP 端口 |
| `SMTP_USER` | — | SMTP 用戶名 |
| `SMTP_PASS` | — | SMTP 密碼 |
| `SMTP_FROM` | `noreply@localhost` | 發件人邮箱 |
| `DATA_RETENTION_DAYS` | `365` | 數據保留期限（天） |

### Docker 專用

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `DB_USER` | `clinic` | PostgreSQL 用戶名 |
| `DB_PASSWORD` | `change-me-in-production` | PostgreSQL 密碼 |

## 應用配置（config.ts）

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `SESSION_MAX_AGE_DAYS` | `30` | JWT 令牌有效期（天） |
| `DEMO_CLINIC_COUNT` | `6` | 種子數據中的診所數量 |
| `DEMO_PASSWORD` | `demo1234` | 種子用戶的預設密碼 |

## RBAC 權限矩陣

| 路由 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|------|:-----:|:-------:|:----------:|:--------:|
| 診所管理 | CRUD | Read | Read | Read |
| 用戶管理 | CRUD | — | — | — |
| 員工管理 | CRUD | CRUD(R) | Read | — |
| 排班管理 | CRUD | CRUD | Read | Read |
| 考勤記錄 | CRUD | CRUD | Read | 自己的 |
| 假期管理 | CRUD | Approve | Read | 申請/自己的 |
| 計糧管理 | CRUD | Read | Read | — |
| 審計日誌 | Read | Read | Read | — |
| 每日雜湊 | Write/Read | Write/Read | Read | — |

## 排班規則（shift-rules.json）

| 規則 | 預設值 | 說明 |
|------|--------|------|
| `maxHoursPerDay` | `12` | 每日最大工作時數 |
| `minRestBetweenShifts` | `10` | 班次間最小休息時數 |
| `maxConsecutiveDays` | `7` | 最大連續工作天數 |
| `overtimeMultiplier` | `1.5` | 加班費倍率 |
| `nightShiftStart` | `22` | 夜班開始時間（24h） |
| `nightShiftMultiplier` | `1.5` | 夜班費倍率 |
| `holidayMultiplier` | `2.0` | 假日費倍率 |

## 假期規則

| 假期類型 | 年度額度 | 說明 |
|---------|---------|------|
| 年假 | 12 天 | 根據年資可調整 |
| 病假 | 12 天 | 有薪病假 |
| 無薪假 | 無限 | 需主管批准 |
| 產假 | 按法定 | 根據性別和年資 |

## 計糧規則（pay-rules.json）

| 規則 | 預設值 | 說明 |
|------|--------|------|
| `min Wage` | `4250` | 最低時薪（港幣/月） |
| `overtimeThreshold` | `44` | 每週標準工時上限 |
| `restDayPayableDays` | `5` | 休息日補薪計算基準 |

## 備份配置

| 參數 | 預設值 | 說明 |
|------|--------|------|
| 數據庫備份頻率 | 每日 02:00 | 完整備份 |
| 審計日誌備份頻率 | 每日 03:00 | 單獨備份 |
| 備份保留期 | 30 天 | 數據庫 |
| 審計保留期 | 730 天（2年） | 審計日誌 |
| 異地備份 | 開啟 | 備份複製到 offsite 目錄 |
