#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/web"
npx tsx scripts/test-patient-pii.ts
