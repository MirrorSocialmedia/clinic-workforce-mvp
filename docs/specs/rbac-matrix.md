# RBAC 權限矩陣

> **Clinic Workforce MVP — Role-Based Access Control**
>
> 4 個角色：`OWNER` / `MANAGER` / `ACCOUNTANT` / `EMPLOYEE`
>
> 每個操作的權限級別定義。所有權限通過 middleware 統一檢查。

## 角色定義

| 角色 | 說明 | 數據範圍 |
|------|------|----------|
| `OWNER` | 診所擁有者 / 最高管理層 | 全部診所全部數據 |
| `MANAGER` | 診所經理 / 主管 | 所屬診所全部數據 |
| `ACCOUNTANT` | 會計 / 財務 | 所屬診所 — 薪酬唯讀 + 審計日誌 |
| `EMPLOYEE` | 一般員工 | 僅本人數據 |

## 權限符號說明

| 符號 | 含義 |
|------|------|
| ✅ | 完全權限（讀/寫/刪） |
| 📖 | 唯讀 |
| ✏️ | 可寫入（新增/更新） |
| ⚠️ | 需審批（提交後需 OWNER/MANAGER 審批） |
| ❌ | 無權限 |

---

## 權限矩陣

### 1. 診所管理 (Clinic)

| 操作 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|------|:-----:|:-------:|:----------:|:--------:|
| 查看所有診所 | ✅ | 📖 (所屬) | 📖 (所屬) | 📖 (所屬) |
| 新增診所 | ✅ | ❌ | ❌ | ❌ |
| 編輯診所資料 | ✅ | ✏️ (所屬) | ❌ | ❌ |
| 停用診所 | ✅ | ❌ | ❌ | ❌ |

### 2. 用戶管理 (User)

| 操作 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|------|:-----:|:-------:|:----------:|:--------:|
| 查看用戶列表 | ✅ | 📖 (所屬診所) | ❌ | ❌ |
| 新增用戶 | ✅ | ✏️ (EMPLOYEE 角色) | ❌ | ❌ |
| 編輯用戶資料 | ✅ | ✏️ (所屬, 不含 role) | ❌ | ✏️ (個人資料) |
| 修改用戶角色 | ✅ | ❌ | ❌ | ❌ |
| 停用用戶 | ✅ | ✏️ (EMPLOYEE 角色) | ❌ | ❌ |
| 重置用戶密碼 | ✅ | ❌ | ❌ | ✏️ (改自己密碼) |

### 3. 員工管理 (Employee)

| 操作 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|------|:-----:|:-------:|:----------:|:--------:|
| 查看員工列表 | ✅ | 📖 (所屬診所) | 📖 (所屬診所) | ❌ |
| 新增員工 | ✅ | ✏️ (所屬診所) | ❌ | ❌ |
| 編輯員工資料 | ✅ | ✏️ (所屬診所) | ❌ | ✏️ (個人資料) |
| 設置員工診所 | ✅ | ✏️ (所屬診所) | ❌ | ❌ |
| 終止員工合約 | ✅ | ⚠️ | ❌ | ❌ |

### 4. 排班管理 (Shift)

| 操作 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|------|:-----:|:-------:|:----------:|:--------:|
| 查看排班表 | ✅ | 📖 (所屬診所) | 📖 (所屬診所) | 📖 (自己) |
| 創建班次 | ✅ | ✏️ (所屬診所) | ❌ | ❌ |
| 修改班次 | ✅ | ✏️ (所屬診所) | ❌ | ❌ |
| 取消班次 | ✅ | ✏️ (所屬診所) | ❌ | ❌ |
| 申請調班 | ❌ | ❌ | ❌ | ⚠️ |
| 批准調班 | ✅ | ✅ | ❌ | ❌ |
| 代班 (Swap) | ❌ | ❌ | ❌ | ⚠️ |

### 5. 考勤管理 (Punch Record)

> ⚠️ **核心鐵律**：原始考勤記錄 (PunchRecord) 一旦寫入即不可改，修正用疊加。

| 操作 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|------|:-----:|:-------:|:----------:|:--------:|
| 查看考勤記錄 | ✅ | 📖 (所屬診所) | 📖 (所屬診所) | 📖 (自己) |
| 打卡 (Clock In/Out) | ❌ | ❌ | ❌ | ✅ |
| 申請補打卡 | ❌ | ❌ | ❌ | ⚠️ |
| 批准補打卡 | ✅ | ✅ | ❌ | ❌ |
| 創建補打卡記錄 (CORRECTION) | ✅ | ✅ | ❌ | ❌ |
| 直接修改考勤記錄 | ❌ | ❌ | ❌ | ❌ |
| 匯出考勤報告 | ✅ | ✅ | ✅ | ❌ |

### 6. 薪酬管理 (Pay Rule)

| 操作 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|------|:-----:|:-------:|:----------:|:--------:|
| 查看薪酬規則 | ✅ | 📖 | 📖 | ❌ |
| 設置薪酬規則 | ✅ | ❌ | ❌ | ❌ |
| 修改薪酬規則 | ✅ | ❌ | ❌ | ❌ |
| 查看個人薪酬 | ❌ | ❌ | ❌ | 📖 (自己) |
| 查看員工薪酬 | ✅ | ❌ | 📖 (所屬診所) | ❌ |
| 生成薪資單 | ✅ | ❌ | ⚠️ | ❌ |
| 審批薪資單 | ✅ | ❌ | ❌ | ❌ |

### 7. 假期管理 (Leave)

| 操作 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|------|:-----:|:-------:|:----------:|:--------:|
| 查看假期餘額 | ✅ | 📖 (所屬診所) | ❌ | 📖 (自己) |
| 申請假期 | ❌ | ❌ | ❌ | ⚠️ |
| 批准假期 | ✅ | ✅ | ❌ | ❌ |
| 拒絕假期 | ✅ | ✅ | ❌ | ❌ |
| 設置假期額度 | ✅ | ❌ | ❌ | ❌ |
| 調整假期餘額 | ✅ | ❌ | ❌ | ❌ |

### 8. 審計日誌 (Audit Log)

| 操作 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|------|:-----:|:-------:|:----------:|:--------:|
| 查看審計日誌 | ✅ | 📖 (所屬診所) | 📖 (所屬診所) | ❌ |
| 篩選審計日誌 | ✅ | ✅ | ✅ | ❌ |
| 匯出審計日誌 | ✅ | ✅ | ✅ | ❌ |
| 刪除審計日誌 | ❌ | ❌ | ❌ | ❌ |

> ⚠️ **審計日誌永不刪除** — 這是防竄改核心。即使 OWNER 也無權刪除。

### 9. 系統管理 (Settings)

| 操作 | OWNER | MANAGER | ACCOUNTANT | EMPLOYEE |
|------|:-----:|:-------:|:----------:|:--------:|
| 設定計薪規則 | ✅ | ❌ | ❌ | ❌ |
| 設定排班規則 | ✅ | ❌ | ❌ | ❌ |
| 設定考勤規則 | ✅ | ❌ | ❌ | ❌ |
| 系統配置 | ✅ | ❌ | ❌ | ❌ |
| 查看系統日誌 | ✅ | ❌ | ❌ | ❌ |

---

## 數據隔離規則

| 角色 | 數據可見範圍 |
|------|-------------|
| `OWNER` | 全部診所全部數據 |
| `MANAGER` | 僅所屬 `UserClinic` 關聯的診所 |
| `ACCOUNTANT` | 僅所屬 `UserClinic` 關聯的診所（薪酬唯讀 + 審計日誌） |
| `EMPLOYEE` | 僅 `Employee.userId == User.id` 的本人數據 |

## 中間件實現邏輯（Phase 1 參考）

```typescript
// 權限檢查偽碼
async function checkPermission(userId, action, targetClinicId?, targetEmployeeId?) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== 'ACTIVE') throw new ForbiddenError();

  // OWNER bypass (全部權限)
  if (user.role === 'OWNER') return true;

  // 數據範圍檢查
  const allowedClinics = await getUserClinicIds(userId);
  if (targetClinicId && !allowedClinics.includes(targetClinicId)) {
    throw new ForbiddenError(' Clinic not in scope');
  }

  // 角色 + 操作矩陣
  const { hasPermission } = await resolvePermissionMatrix(user.role, action, targetEmployeeId);
  return hasPermission;
}
```

## 審批流程

| 審批項目 | 申請者 | 審批者 | 審批層級 |
|---------|--------|--------|---------|
| 調班 | EMPLOYEE | MANAGER → OWNER | 一級 |
| 補打卡 | EMPLOYEE | MANAGER | 一級 |
| 假期 | EMPLOYEE | MANAGER → OWNER | 可雙層 |
| 薪資單草稿 | ACCOUNTANT | OWNER | 一級 |
| 終止員工合約 | MANAGER | OWNER | 一級 |
