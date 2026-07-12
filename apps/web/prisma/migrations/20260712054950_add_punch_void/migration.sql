-- CreateTable
CREATE TABLE "PunchVoid" (
    "id" TEXT NOT NULL,
    "punchRecordId" TEXT NOT NULL,
    "voidedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PunchVoid_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PunchVoid_punchRecordId_key" ON "PunchVoid"("punchRecordId");

-- AddForeignKey
ALTER TABLE "PunchVoid" ADD CONSTRAINT "PunchVoid_punchRecordId_fkey" FOREIGN KEY ("punchRecordId") REFERENCES "PunchRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
