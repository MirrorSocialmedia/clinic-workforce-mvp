-- MD-Q: ApricotSyncJob — async sync progress tracking

CREATE TABLE "ApricotSyncJob" (
    "id" TEXT NOT NULL,
    "clinicExtId" TEXT,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "totalClinics" INTEGER NOT NULL DEFAULT 1,
    "doneClinics" INTEGER NOT NULL DEFAULT 0,
    "paymentsSynced" INTEGER NOT NULL DEFAULT 0,
    "billsChecked" INTEGER NOT NULL DEFAULT 0,
    "allocRows" INTEGER NOT NULL DEFAULT 0,
    "currentStep" TEXT,
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "ApricotSyncJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ApricotSyncJob_status_idx" ON "ApricotSyncJob"("status");
