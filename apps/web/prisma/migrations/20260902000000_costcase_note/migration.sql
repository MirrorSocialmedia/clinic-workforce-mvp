-- cwm-costnote-20260902 T1: CostCase.note 自由備註（例：補做上排、等病人 confirm 色）
-- 可空、無 default — 現有行全部 NULL，零破壞。
-- 注意：CostCaseMaterial.note（2026-08-22「Other」材料名）係另一張表，唔撞。
ALTER TABLE "CostCase" ADD COLUMN "note" TEXT;
