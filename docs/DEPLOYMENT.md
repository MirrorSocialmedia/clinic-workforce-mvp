# VPS 部署指南

## 前置條件

- 一台 Linux VPS（推薦 Ubuntu 22.04 / Debian 12）
- 最少 2 CPU / 4GB RAM / 20GB SSD
- 已綁定域名，DNS 指向 VPS IP
- Docker + Docker Compose 已安裝

## 快速部署（15 分鐘）

### 1. 安裝 Docker

```bash
# Ubuntu / Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

# 驗證
docker --version
docker compose version
```

### 2. 克隆程式碼

```bash
git clone <repo-url> clinic-workforce-mvp
cd clinic-workforce-mvp
```

### 3. 配置環境變數

```bash
cp .env.production.example .env.production

# 生成強密碼
openssl rand -base64 32  # JWT_SECRET
openssl rand -base64 32  # NEXTAUTH_SECRET

# 編輯 .env.production
nano .env.production
```

**必填項：**
- `DB_PASSWORD` — 資料庫密碼
- `JWT_SECRET` — JWT 簽名金鑰（必須隨機）
- `NEXTAUTH_SECRET` — NextAuth 密钥
- `NEXTAUTH_URL` — 你的域名（如 `https://clinic.your-domain.com`）

### 4. 準備 SSL 憑證

```bash
# 創建 SSL 目錄
mkdir -p nginx/ssl

# 選項 A: 使用 Let's Encrypt（推薦）
sudo apt install certbot
sudo certbot certonly --standalone -d your-domain.com
sudo cp /etc/letsencrypt/live/your-domain.com/fullchain.pem nginx/ssl/
sudo cp /etc/letsencrypt/live/your-domain.com/privkey.pem nginx/ssl/
sudo chmod 600 nginx/ssl/*

# 選項 B: 使用自簽憑證（測試用）
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout nginx/ssl/privkey.pem \
  -out nginx/ssl/fullchain.pem \
  -subj "/CN=your-domain.com"
```

### 5. 啟動服務

```bash
# 使用 production 環境變數
export $(cat .env.production | xargs)

# 構建並啟動
docker compose up -d --build

# 查看日誌
docker compose logs -f
```

### 6. 資料庫迁移

```bash
# 等待資料庫就緒
docker compose exec db pg_isready

# 執行 Prisma migration
docker compose exec web npx prisma migrate deploy

# 填充種子數據（首次部署）
docker compose exec web npx prisma db seed
```

### 7. 驗證部署

```bash
# 檢查服務狀態
docker compose ps

# 測試 API
curl -I https://your-domain.com/health
curl https://your-domain.com/api/me

# 訪問瀏覽器
# https://your-domain.com/login
```

## 備份配置

### 設定每日自動備份

```bash
# 創建備份目錄
mkdir -p /backups/clinic-mvp/offsite

# 複製備份腳本
cp scripts/backup.sh /usr/local/bin/
cp scripts/backup-audit.sh /usr/local/bin/
chmod +x /usr/local/bin/backup.sh /usr/local/bin/backup-audit.sh

# 設定 cron（每天凌晨 2 點備份數據庫，3 點備份審計日誌）
(crontab -l 2>/dev/null; echo "0 2 * * * /usr/local/bin/backup.sh /backups/clinic-mvp"; echo "0 3 * * * /usr/local/bin/backup-audit.sh /backups/clinic-mvp/audit") | crontab -

# 驗證 cron
crontab -l
```

### 異地備份（選用）

將 `/backups/clinic-mvp/offsite` 掛載到遠端存儲：

```bash
# 選項 A: rsync 到另一台伺服器
0 4 * * * rsync -avz /backups/clinic-mvp/offsite/ backup@remote-server:/backups/clinic/

# 選項 B: rclone 到雲端（S3 / GCS / Drive）
0 4 * * * rclone sync /backups/clinic-mvp/offsite/ remote:clinic-backups/
```

## 日誌管理

```bash
# 查看應用日誌
docker compose logs -f web

# 查看資料庫日誌
docker compose logs -f db

# 查看 Nginx 日誌
docker compose logs -f nginx

# 設定日誌輪轉（在 docker-compose.yml 中添加）
# logging:
#   driver: "json-file"
#   options:
#     max-size: "10m"
#     max-file: "5"
```

## 監控

### 基礎監控腳本

```bash
#!/bin/bash
# /usr/local/bin/clinic-healthcheck.sh

# 檢查 Docker 容器
if ! docker compose -f /path/to/clinic-workforce-mvp/docker-compose.yml ps | grep -q "Up"; then
  echo "ALERT: One or more containers are down!"
  # Send notification (email/Telegram/etc.)
fi

# 檢查資料庫連接
if ! docker compose -f /path/to/clinic-workforce-mvp/docker-compose.yml exec -T db pg_isready; then
  echo "ALERT: Database is not ready!"
fi

# 檢查 SSL 憑證過期
if [ -f /path/to/nginx/ssl/fullchain.pem ]; then
  EXPIRY=$(openssl x509 -in /path/to/nginx/ssl/fullchain.pem -noout -enddate | cut -d= -f2)
  DAYS_LEFT=$(( ( $(date -d "$EXPIRY" +%s) - $(date +%s) ) / 86400 ))
  if [ $DAYS_LEFT -lt 30 ]; then
    echo "WARNING: SSL certificate expires in $DAYS_LEFT days"
  fi
fi
```

## 故障排除

### 常見問題

| 問題 | 解決方案 |
|------|---------|
| 容器無法啟動 | `docker compose logs` 查看錯誤 |
| 資料庫連接失敗 | 檢查 `DATABASE_URL` 格式 |
| SSL 錯誤 | 確認憑證路徑和權限 |
| 413 Request Entity Too Large | 在 nginx.conf 添加 `client_max_body_size 10m;` |
| 构建失敗 | 檢查 Node.js 版本和 pnpm lockfile |

### 重啟服務

```bash
# 重啟所有服務
docker compose restart

# 重啟單一服務
docker compose restart web

# 停止並清理
docker compose down
docker compose down -v  # 注意：會刪除數據卷！
```

## 更新部署

```bash
cd /path/to/clinic-workforce-mvp
git pull origin main

# 重新構建並啟動
docker compose up -d --build

# 執行新的 migration（如有）
docker compose exec web npx prisma migrate deploy
```
