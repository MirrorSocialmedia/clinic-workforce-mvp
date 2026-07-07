# UI 元件映射表

本文檔說明現有自訂 CSS 與 Shadcn/UI + Tremor 元件的映射關係，供後續逐頁遷移參考。

## 映射關係

| 現有（自訂 CSS） | Shadcn/UI 取代 | 路徑 |
|---|---|---|
| `<table>` 自訂樣式 | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` | `@/components/ui/table` |
| `.card` CSS class | `Card`, `CardHeader`, `CardTitle`, `CardContent`, `CardFooter` | `@/components/ui/card` |
| 自訂按鈕 class (`.btn`) | `Button` (variants: default, destructive, outline, secondary, ghost, link) | `@/components/ui/button` |
| 自訂 modal/dialog | `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription` | `@/components/ui/dialog` |
| 自訂 input | `Input` + `Label` | `@/components/ui/input`, `@/components/ui/label` |
| 自訂 select | `Select`, `SelectTrigger`, `SelectContent`, `SelectItem` | `@/components/ui/select` |
| 自訂 badge | `Badge` (variants: default, secondary, destructive, outline) | `@/components/ui/badge` |
| 自訂 toast/notification | `sonner` — `<Toaster />` + `toast()` | `@/hooks/use-app-toast` |
| 分隔線 | `Separator` | `@/components/ui/separator` |
| 頭像 | `Avatar`, `AvatarImage`, `AvatarFallback` | `@/components/ui/avatar` |
| 下拉選單 | `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem` | `@/components/ui/dropdown-menu` |
| 彈出層 | `Popover`, `PopoverTrigger`, `PopoverContent` | `@/components/ui/popover` |
| 分頁籤 | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | `@/components/ui/tabs` |
| 警示 | `Alert`, `AlertTitle`, `AlertDescription` | `@/components/ui/alert` |

## Tremor 數據卡片

| 用途 | Tremor 元件 |
|---|---|
| 統計數字卡片 | `MetricCard` from `@tremor/react` |
| 儀表板佈局 | `Card` (shadcn) + `MetricCard` (tremor) 組合 |

## 遷移進度

- [x] 基礎元件安裝（Shadcn + Tremor + Sonner）
- [x] Tailwind 配置 + CSS 變數
- [x] 側欄（Protected Layout）
- [x] Dashboard 管理員頁
- [x] Dashboard 員工頁
- [x] Punch 頁
- [x] Employee Mobile Layout
- [x] Toast 通知系統
- [ ] 其餘頁面孔遷移（後續任務）
