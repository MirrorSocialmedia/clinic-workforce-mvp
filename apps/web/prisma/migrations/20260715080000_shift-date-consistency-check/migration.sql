ALTER TABLE "Shift" ADD CONSTRAINT "shift_date_start_same_hk_day" CHECK (
  (((("date" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Hong_Kong')::date))
  = (((("startTime" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Hong_Kong')::date))
);
