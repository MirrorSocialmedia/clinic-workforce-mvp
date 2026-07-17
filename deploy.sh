#!/usr/bin/env bash
set -euo pipefail

# Clinic Workforce MVP — Production Deploy
# Usage: ./deploy.sh

DC="docker compose -f docker-compose.yml"

echo "🔧 Building app..."
$DC build app

echo "🚀 Starting services..."
$DC up -d

echo "🗄️ Running database migrations..."
$DC exec -T app npx prisma migrate deploy --schema apps/web/prisma/schema.prisma

echo "✅ Deploy complete"
