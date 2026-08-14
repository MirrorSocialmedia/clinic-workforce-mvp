-- MD-E: ReconciliationImport — 月報對數

CREATE TABLE "ReconciliationImport" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "reportTotal" DECIMAL(12,2) NOT NULL,
    "systemTotal" DECIMAL(12,2) NOT NULL,
    "difference" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL,
    "detailJson" JSONB NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconciliationImport_pkey" PRIMARY KEY ("id")
);

-- Foreign key
ALTER TABLE "ReconciliationImport" ADD CONSTRAINT "ReconciliationImport_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "ReconciliationImport_providerId_periodMonth_idx"
    ON "ReconciliationImport"("providerId", "periodMonth");
