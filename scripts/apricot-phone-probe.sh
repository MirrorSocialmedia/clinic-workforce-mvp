#!/usr/bin/env bash
# ============================================================
# cwi-patient-identify-probe-20261017：Apricot「用電話搵唔搵到病人」一次性探測（唯讀）
#
# 喺生產【host】跑（同 sync-availability.sh 一樣經 docker exec 入 container 打內部 API）：
#   bash scripts/apricot-phone-probe.sh
# 會問你輸入電話（唔會顯示、唔會留喺 shell history）；任何寫法都得：
#   91234567 ／ +852 9123 4567 ／ 13812345678 ／ +86 138 1234 5678
# 輸出只有筆數同格式形狀（數字變 d）— 冇病人資料，可以直接貼返俾開發者。
# ============================================================
set -euo pipefail
export PATH="/home/clinicapp/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
CONTAINER="${CONTAINER:-clinic-prod-app}"

read -r -s -p "輸入要測試嘅電話（唔會顯示）：" PROBE_PHONE
echo
[ -n "$PROBE_PHONE" ] || { echo "冇輸入"; exit 1; }

docker exec -e PROBE_PHONE="$PROBE_PHONE" "$CONTAINER" node -e '
fetch("http://localhost:3000/api/internal/apricot-phone-probe", {
  method: "POST",
  headers: { "content-type": "application/json", "x-cron-key": process.env.APRICOT_CRON_KEY || "" },
  body: JSON.stringify({ phone: process.env.PROBE_PHONE }),
})
  .then(async (r) => { console.log("HTTP", r.status); console.log(JSON.stringify(await r.json(), null, 2)); })
  .catch((e) => { console.error("失敗：", e.message); process.exit(1); });
'
