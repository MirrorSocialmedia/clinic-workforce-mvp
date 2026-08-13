-- MD-C: Apricot Data Layer — Payment / Bill Sync

-- ApricotPayment
CREATE TABLE "ApricotPayment" (
    "id" TEXT NOT NULL,
    "extId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "clinicExtId" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "totalAmt" DECIMAL(12,2) NOT NULL,
    "isVoid" BOOLEAN NOT NULL DEFAULT false,
    "payerType" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApricotPayment_pkey" PRIMARY KEY ("id")
);

-- ApricotPaymentMethod
CREATE TABLE "ApricotPaymentMethod" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "methodRaw" TEXT NOT NULL,
    "methodNorm" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "payType" TEXT NOT NULL,

    CONSTRAINT "ApricotPaymentMethod_pkey" PRIMARY KEY ("id")
);

-- ApricotPaymentRef
CREATE TABLE "ApricotPaymentRef" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "billExtId" TEXT NOT NULL,
    "billCode" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "ApricotPaymentRef_pkey" PRIMARY KEY ("id")
);

-- ApricotBill
CREATE TABLE "ApricotBill" (
    "id" TEXT NOT NULL,
    "extId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "billTime" TIMESTAMP(3) NOT NULL,
    "providerExtId" TEXT,
    "clinicExtId" TEXT NOT NULL,
    "amt" DECIMAL(12,2) NOT NULL,
    "ttlAmt" DECIMAL(12,2) NOT NULL,
    "paidAmt" DECIMAL(12,2) NOT NULL,
    "osAmt" DECIMAL(12,2) NOT NULL,
    "isVoid" BOOLEAN NOT NULL DEFAULT false,
    "isRefunded" BOOLEAN NOT NULL DEFAULT false,
    "refundRefId" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApricotBill_pkey" PRIMARY KEY ("id")
);

-- ApricotBillItem
CREATE TABLE "ApricotBillItem" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "eleId" TEXT NOT NULL,
    "feeItemCode" TEXT NOT NULL,
    "feeItemDes" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "discPer" DECIMAL(5,2) NOT NULL,
    "discAmt" DECIMAL(12,2) NOT NULL,
    "ttlDisc" DECIMAL(12,2) NOT NULL,
    "amt" DECIMAL(12,2) NOT NULL,
    "ttlAmt" DECIMAL(12,2) NOT NULL,
    "reconJson" JSONB NOT NULL,

    CONSTRAINT "ApricotBillItem_pkey" PRIMARY KEY ("id")
);

-- PaymentAllocation
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "paymentExtId" TEXT NOT NULL,
    "billExtId" TEXT NOT NULL,
    "providerExtId" TEXT,
    "clinicExtId" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "methodNorm" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "feePercentUsed" DECIMAL(5,3) NOT NULL,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "countAsIncome" BOOLEAN NOT NULL,
    "allocationMode" TEXT NOT NULL,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "isVoid" BOOLEAN NOT NULL DEFAULT false,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- PaymentMethodRule
CREATE TABLE "PaymentMethodRule" (
    "id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "feePercent" DECIMAL(5,3) NOT NULL DEFAULT 0,
    "countAsIncome" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "PaymentMethodRule_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "ApricotPaymentMethod" ADD CONSTRAINT "ApricotPaymentMethod_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "ApricotPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApricotPaymentRef" ADD CONSTRAINT "ApricotPaymentRef_paymentId_fkey"
    FOREIGN KEY ("paymentId") REFERENCES "ApricotPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ApricotBillItem" ADD CONSTRAINT "ApricotBillItem_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "ApricotBill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique constraints
CREATE UNIQUE INDEX "ApricotPayment_extId_key" ON "ApricotPayment"("extId");
CREATE UNIQUE INDEX "ApricotBill_extId_key" ON "ApricotBill"("extId");
CREATE UNIQUE INDEX "ApricotBillItem_billId_eleId_key" ON "ApricotBillItem"("billId", "eleId");
CREATE UNIQUE INDEX "PaymentAllocation_paymentExtId_billExtId_methodNorm_key"
    ON "PaymentAllocation"("paymentExtId", "billExtId", "methodNorm");

-- Indexes
CREATE INDEX "ApricotPayment_clinicExtId_paidAt_idx" ON "ApricotPayment"("clinicExtId", "paidAt");
CREATE INDEX "ApricotPayment_paidAt_idx" ON "ApricotPayment"("paidAt");
CREATE INDEX "ApricotPaymentMethod_paymentId_idx" ON "ApricotPaymentMethod"("paymentId");
CREATE INDEX "ApricotPaymentRef_paymentId_idx" ON "ApricotPaymentRef"("paymentId");
CREATE INDEX "ApricotPaymentRef_billExtId_idx" ON "ApricotPaymentRef"("billExtId");
CREATE INDEX "ApricotBill_providerExtId_billTime_idx" ON "ApricotBill"("providerExtId", "billTime");
CREATE INDEX "ApricotBill_clinicExtId_billTime_idx" ON "ApricotBill"("clinicExtId", "billTime");
CREATE INDEX "ApricotBillItem_feeItemDes_idx" ON "ApricotBillItem"("feeItemDes");
CREATE INDEX "PaymentAllocation_providerExtId_periodMonth_idx" ON "PaymentAllocation"("providerExtId", "periodMonth");
CREATE INDEX "PaymentAllocation_needsReview_idx" ON "PaymentAllocation"("needsReview");
CREATE INDEX "PaymentMethodRule_method_effectiveFrom_idx" ON "PaymentMethodRule"("method", "effectiveFrom");
