-- ★ cwm-consistency Stage 1.10（D4）：更表交換停用
-- ① 未處理嘅申請全部結案（功能停用後冇人可以批）
UPDATE "ShiftChangeRequest" SET "status" = 'REJECTED', "updatedAt" = NOW() WHERE "status" = 'PENDING';
-- ② FK 由 RESTRICT 改 SET NULL：有申請記錄嘅更都刪得，歷史申請保留（shiftId 變 NULL）
ALTER TABLE "ShiftChangeRequest" ALTER COLUMN "shiftId" DROP NOT NULL;
ALTER TABLE "ShiftChangeRequest" DROP CONSTRAINT "ShiftChangeRequest_shiftId_fkey";
ALTER TABLE "ShiftChangeRequest" ADD CONSTRAINT "ShiftChangeRequest_shiftId_fkey"
  FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
