-- cwi-followup-p1-20260915 S0: 索引管道（MD §2.2）— ClinicalRecordIndex + ClinicalIndexJob

-- CreateTable
CREATE TABLE "ClinicalRecordIndex" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "patientApricotId" TEXT NOT NULL,
    "patientCode" TEXT,
    "phoneHashes" TEXT[],
    "visitDate" DATE NOT NULL,
    "apricotApptId" TEXT,
    "apricotNoteId" TEXT,
    "bookingStatus" INTEGER NOT NULL,
    "visitReasonCodes" TEXT[],
    "providerCode" TEXT,
    "hasNote" BOOLEAN NOT NULL DEFAULT false,
    "noteKind" TEXT,
    "noteJson" JSONB,
    "quotedItems" JSONB,
    "rxCodes" TEXT[],
    "billTtlAmt" INTEGER,
    "billOsAmt" INTEGER,
    "syncedAt" TIMESTAMP(3) NOT NULL,
    "parseVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ClinicalRecordIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalIndexJob" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rangeFrom" DATE NOT NULL,
    "rangeTo" DATE NOT NULL,
    "cursorDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "patients" INTEGER NOT NULL DEFAULT 0,
    "apiCalls" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ClinicalIndexJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClinicalRecordIndex_clinicId_visitDate_idx" ON "ClinicalRecordIndex"("clinicId", "visitDate");

-- CreateIndex
CREATE INDEX "ClinicalRecordIndex_clinicId_bookingStatus_visitDate_idx" ON "ClinicalRecordIndex"("clinicId", "bookingStatus", "visitDate");

-- CreateIndex
CREATE UNIQUE INDEX "ClinicalRecordIndex_patientApricotId_visitDate_apricotApptI_key" ON "ClinicalRecordIndex"("patientApricotId", "visitDate", "apricotApptId");

