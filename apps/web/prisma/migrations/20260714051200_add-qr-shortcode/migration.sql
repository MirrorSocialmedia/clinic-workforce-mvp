-- Add shortCode column to QRToken table
ALTER TABLE "QRToken" ADD COLUMN "shortCode" TEXT;

-- Add index on shortCode
CREATE INDEX "QRToken_shortCode_idx" ON "QRToken"("shortCode");
