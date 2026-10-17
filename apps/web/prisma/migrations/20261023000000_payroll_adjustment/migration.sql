-- CreateTable
-- ★ cwm-payadj-20261017 ②：計糧調整（MD §2.2 逐字 + raw SQL CHECK 4 條）
CREATE TABLE "PayrollAdjustment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "mpfTiming" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,

    CONSTRAINT "PayrollAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollAdjustment_employeeId_periodMonth_idx" ON "PayrollAdjustment"("employeeId", "periodMonth");

-- AddForeignKey
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MD §2.2：raw SQL 補（Prisma 表達唔到）
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_amount_nonzero" CHECK ("amount" <> 0);
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_timing" CHECK ("mpfTiming" IN ('PRE_MPF','POST_MPF'));
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_reason" CHECK (char_length(btrim("reason")) BETWEEN 1 AND 200);
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_month" CHECK ("periodMonth" ~ '^\d{4}-(0[1-9]|1[0-2])$');
