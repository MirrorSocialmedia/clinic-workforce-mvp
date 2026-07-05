-- CreateTable
CREATE TABLE "PunchCorrection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "punchRecordId" TEXT,
    "employeeId" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "correctedTime" DATETIME NOT NULL,
    "punchType" TEXT NOT NULL,
    "reason" TEXT,
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PunchCorrection_punchRecordId_fkey" FOREIGN KEY ("punchRecordId") REFERENCES "PunchRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PunchCorrection_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QRToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "issuedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedBy" TEXT,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QRToken_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DailyHash" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "hash" TEXT NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailyHash_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "Clinic" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PunchCorrection_employeeId_createdAt_idx" ON "PunchCorrection"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "PunchCorrection_status_idx" ON "PunchCorrection"("status");

-- CreateIndex
CREATE UNIQUE INDEX "QRToken_token_key" ON "QRToken"("token");

-- CreateIndex
CREATE INDEX "QRToken_clinicId_expiresAt_idx" ON "QRToken"("clinicId", "expiresAt");

-- CreateIndex
CREATE INDEX "QRToken_token_idx" ON "QRToken"("token");

-- CreateIndex
CREATE INDEX "DailyHash_clinicId_date_idx" ON "DailyHash"("clinicId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyHash_clinicId_date_key" ON "DailyHash"("clinicId", "date");
