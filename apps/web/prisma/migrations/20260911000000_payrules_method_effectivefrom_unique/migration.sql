-- cwm-reconkiosk-20260910 S5：PaymentMethodRule 防重複（D1 清理後先加）
CREATE UNIQUE INDEX "PaymentMethodRule_method_effectiveFrom_key" ON "PaymentMethodRule"("method", "effectiveFrom");
