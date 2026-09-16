-- CreateTable
CREATE TABLE "QuotedItem" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientApricotId" TEXT NOT NULL,
    "sourceVisitId" TEXT,
    "sourceVisitDate" DATE NOT NULL,
    "text" TEXT NOT NULL,
    "termShorthand" TEXT,
    "nameCn" TEXT,
    "amountMin" INTEGER,
    "amountMax" INTEGER,
    "perUnit" BOOLEAN NOT NULL DEFAULT false,
    "fdiTeeth" TEXT[],
    "intent" TEXT NOT NULL DEFAULT 'unknown',
    "certainty" TEXT NOT NULL DEFAULT 'low',
    "source" TEXT NOT NULL DEFAULT 'parser',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "correctionNote" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotedItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuotedItem_patientApricotId_status_idx" ON "QuotedItem"("patientApricotId", "status");

-- CreateIndex
CREATE INDEX "QuotedItem_clinicId_sourceVisitDate_idx" ON "QuotedItem"("clinicId", "sourceVisitDate");

-- CreateIndex
CREATE INDEX "QuotedItem_status_sourceVisitDate_idx" ON "QuotedItem"("status", "sourceVisitDate");
