-- ★ cwm-consistency hotfix（20260922）：TimeBankDirty 兩個問題
--   ① trg_tb_dirty_template：DISTINCT 連 nextval 一齊做 → 冇去重 → 同一員工同月 ≥2 更就
--      "ON CONFLICT DO UPDATE command cannot affect row a second time" → 改扣飯鐘 PUT 必 500
--   ② 長 tx（payroll finalize）寫 ROSTER_DIFF 會一路揸住 TimeBankDirty(emp, ym) row lock 到 commit
--      → 同員工同月打卡／批假／改更 trigger upsert 排隊 → 超 5s interactive tx timeout → P2028 → 500
--      解法：tx 可以 set_config('cwm.tb_defer_dirty','on',true) 暫停 trigger 標記，commit 前一次過補標

CREATE OR REPLACE FUNCTION tb_mark_dirty(p_emp TEXT, p_ym TEXT) RETURNS void AS $$
BEGIN
  IF p_emp IS NULL OR p_ym IS NULL THEN RETURN; END IF;
  IF current_setting('cwm.tb_defer_dirty', true) = 'on' THEN RETURN; END IF;   -- ★ ② 延後標記（只影響 set 咗嘅 tx）
  INSERT INTO "TimeBankDirty"("employeeId","ym","seq") VALUES (p_emp, p_ym, nextval('tb_dirty_seq'))
  ON CONFLICT ("employeeId","ym") DO UPDATE SET "seq" = EXCLUDED."seq";
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_tb_dirty_template() RETURNS trigger AS $$
BEGIN
  IF NEW."deductLunch" IS DISTINCT FROM OLD."deductLunch" THEN
    INSERT INTO "TimeBankDirty"("employeeId","ym","seq")
      SELECT d."employeeId", d.ym, nextval('tb_dirty_seq')          -- ★ ① nextval 喺 DISTINCT 之外
        FROM (SELECT DISTINCT s."employeeId", hk_ym(s."date") AS ym
                FROM "Shift" s WHERE s."templateId" = NEW.id) d
       ORDER BY d."employeeId", d.ym                                   -- 固定鎖序，減 deadlock
    ON CONFLICT ("employeeId","ym") DO UPDATE SET "seq" = EXCLUDED."seq";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
