#!/bin/bash
# Clean face frames older than 30 days
# Run via crontab: 0 4 * * * /path/to/clean-face-frames.sh

# Delete frame files older than 30 days
docker exec $(docker ps -qf name=face) find /data/frames -mtime +30 -delete 2>/dev/null

# Clear faceFramePath in DB for old records
docker exec clinic-prod-db psql -U clinic clinic_prod -c \
  "UPDATE \"PunchRecord\" SET \"faceFramePath\" = NULL WHERE \"faceFramePath\" IS NOT NULL AND \"punchTime\" < now() - interval '30 days';" 2>/dev/null

echo "$(date '+%Y-%m-%d %H:%M:%S') Face frame cleanup completed" >> /tmp/face-cleanup.log
