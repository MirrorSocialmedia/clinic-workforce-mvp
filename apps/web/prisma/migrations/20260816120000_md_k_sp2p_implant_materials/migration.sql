-- ★ MD-K: 2人SP 偵測 + Implant 材料

-- ApricotBillItem: add isSp2p flag
ALTER TABLE "ApricotBillItem" ADD COLUMN "isSp2p" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "ApricotBillItem_feeItemDes_isSp2p_idx" ON "ApricotBillItem"("feeItemDes", "isSp2p");

-- FeeItemListPrice: new table for standard prices
CREATE TABLE "FeeItemListPrice" (
    "id" TEXT NOT NULL,
    "feeItemCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "listPrice" DECIMAL(12,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "FeeItemListPrice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FeeItemListPrice_feeItemCode_effectiveFrom_idx" ON "FeeItemListPrice"("feeItemCode", "effectiveFrom");

-- SpSubsidy: add needsReview flag
ALTER TABLE "SpSubsidy" ADD COLUMN "needsReview" BOOLEAN NOT NULL DEFAULT false;

-- CostCaseMaterial: add isPriceOverridden flag
ALTER TABLE "CostCaseMaterial" ADD COLUMN "isPriceOverridden" BOOLEAN NOT NULL DEFAULT false;

-- MaterialItem: make unitPrice nullable (some materials like collon plug have no standard price)
ALTER TABLE "MaterialItem" ALTER COLUMN "unitPrice" DROP NOT NULL;
