#!/bin/sh
# Nightly logical backup of the Compose PostgreSQL database.
#
#   deploy/backup.sh                 # writes backups/bomber-YYYYmmdd-HHMMSS.dump
#   BACKUP_DIR=/srv/backups KEEP_DAYS=30 deploy/backup.sh
#
# Restore into an empty database (stop the server first):
#   docker compose exec -T postgres pg_restore -U bomber -d bomber --clean --if-exists < backups/<file>.dump
#
# Cron example (03:15 every night):
#   15 3 * * * cd /srv/bomber-arena && deploy/backup.sh >> backups/backup.log 2>&1
set -eu

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TARGET="$BACKUP_DIR/bomber-$STAMP.dump"

mkdir -p "$BACKUP_DIR"
umask 077
docker compose exec -T postgres pg_dump -U bomber -d bomber --format=custom --compress=9 > "$TARGET.partial"
mv "$TARGET.partial" "$TARGET"
echo "$(date -u +%FT%TZ) wrote $TARGET ($(du -h "$TARGET" | cut -f1))"

find "$BACKUP_DIR" -name 'bomber-*.dump' -type f -mtime +"$KEEP_DAYS" -print -delete
