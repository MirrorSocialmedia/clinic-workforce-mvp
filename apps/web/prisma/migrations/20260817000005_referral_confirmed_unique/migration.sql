-- MD-V: partial unique index for confirmed referrals
-- Prevents duplicate confirmed referrals for same bill item + provider

-- 先清乾淨現有重複（如果有的話）
DELETE FROM "ProviderReferral"
WHERE ctid NOT IN (
  SELECT min(ctid)
  FROM "ProviderReferral"
  WHERE status = 'CONFIRMED' AND "billItemEleId" IS NOT NULL
  GROUP BY "billItemEleId", "fromProviderId"
);

-- 建立 partial unique index
CREATE UNIQUE INDEX "ProviderReferral_confirmed_item_key"
  ON "ProviderReferral"("billItemEleId", "fromProviderId")
  WHERE "status" = 'CONFIRMED' AND "billItemEleId" IS NOT NULL;
