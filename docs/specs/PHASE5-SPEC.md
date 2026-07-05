# 階段 5 — 假期（1.5 週）

**Kairo Task**: `mr7meczx9lzzx` | **分支**: `phase5/leave`

## 目標

把請假納入「申請—審批—留痕」框架，讓工時計算完整。

## 功能範圍

### 1. 假期類型管理
- 可配置：年假、病假、無薪假
- 額度設定（每人每年）
- 法定精算不做（只做額度與流程）

### 2. 假期額度
- 按到職比例計算餘額（簡單比例）
- `LeaveBalance` 表：年度、總額、已用、剩餘

### 3. 申請流程
- 員工申請 → 主管審批 → 扣減餘額 → audit_log
- 狀態：PENDING → APPROVED / REJECTED

### 4. 聯動
- 已批假的日子，計糧時不算缺勤
- 自動同步香港公眾假期

### 5. UI
- 假期類型管理頁（OWNER）
- 假期列表/申請頁
- 假期額度顯示

## API Routes
```
GET    /api/leave-types          # 假期類型列表
POST   /api/leave-types          # 新增類型 (OWNER)
PUT    /api/leave-types/:id      # 編輯類型 (OWNER)
POST   /api/leave-requests       # 請假申請
GET    /api/leave-requests       # 申請列表
PUT    /api/leave-requests/:id   # 審批 (OWNER/MANAGER)
GET    /api/leave-balance        # 假期餘額
GET    /api/hk-public-holidays   # 香港公眾假期
```

## 驗收標準
- [ ] 員工申請年假 → 主管批 → 餘額減 → audit_log 有記錄
- [ ] 已批假在計糧時不計缺勤
- [ ] 公眾假期自動標示
- [ ] `npm run build` 通過
