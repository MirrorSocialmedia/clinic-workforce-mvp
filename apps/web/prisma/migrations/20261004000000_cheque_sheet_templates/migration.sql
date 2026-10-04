-- ★ cwm-chequetpl-20261004：出糧總表自訂模版＋出糧診所（純加表，冇資料遷移；冇 row = 舊格式）
CREATE TABLE "ChequeSheetTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChequeSheetTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChequeSheetPayer" (
    "employeeId" TEXT NOT NULL,
    "payerClinicId" TEXT,
    "sortOrder" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChequeSheetPayer_pkey" PRIMARY KEY ("employeeId")
);
