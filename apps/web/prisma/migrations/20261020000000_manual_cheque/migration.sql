-- ★ cwm-chequemanual-20261013：手動開票
CREATE TABLE "ManualCheque" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "payeeName" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "purpose" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualCheque_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ManualCheque_amount_positive" CHECK ("amount" > 0)
);

CREATE INDEX "ManualCheque_periodMonth_clinicId_idx" ON "ManualCheque"("periodMonth", "clinicId");
