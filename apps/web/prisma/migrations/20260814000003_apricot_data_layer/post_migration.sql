-- MD-C: PaymentMethodRule seed
-- 喺 migration 之後手動執行，或者由 seed script 插入
-- ★ AMEX / UNIONPAY / WECHAT / PAYME 唔 seed — 逼老細答

INSERT INTO "PaymentMethodRule" ("method", "label", "feePercent", "countAsIncome", "effectiveFrom", "effectiveTo", "createdBy")
VALUES
  ('CASH', 'Cash', 0, true, '2026-01-01T00:00:00+08:00', NULL, 'system'),
  ('HCV', 'Health Care Voucher', 0, true, '2026-01-01T00:00:00+08:00', NULL, 'system'),
  ('FPS', 'FPS (Real-time Payment)', 0, true, '2026-01-01T00:00:00+08:00', NULL, 'system'),
  ('CCF', 'Clinic Cash Flow', 0, true, '2026-01-01T00:00:00+08:00', NULL, 'system'),
  ('VISA', 'VISA Card', 1.5, true, '2026-01-01T00:00:00+08:00', NULL, 'system'),
  ('MASTERCARD', 'MasterCard', 1.5, true, '2026-01-01T00:00:00+08:00', NULL, 'system'),
  ('OCTOPUS', 'Octopus Card', 1.5, true, '2026-01-01T00:00:00+08:00', NULL, 'system'),
  ('ALIPAY', 'Alipay', 1.5, true, '2026-01-01T00:00:00+08:00', NULL, 'system'),
  ('CREDIT', 'Internal Credit', 0, false, '2026-01-01T00:00:00+08:00', NULL, 'system'),
  ('FREE_SP', 'Free / Special', 0, false, '2026-01-01T00:00:00+08:00', NULL, 'system')
ON CONFLICT DO NOTHING;
