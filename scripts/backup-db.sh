#!/usr/bin/env bash
# Nightly PostgreSQL backup for the GuestPost platform.
#
# Usage:   ./scripts/backup-db.sh [backup_dir]
# Cron:    0 3 * * * /path/to/guestpost-platform/scripts/backup-db.sh /var/backups/guestpost >> /var/log/guestpost-backup.log 2>&1
#
# Behavior:
#   - pg_dump (custom format, compressed) from the gp-postgres container
#   - keeps RETENTION_DAYS days of backups (default 14)
#   - verifies the dump is restorable structure (pg_restore --list)
#   - exits non-zero on any failure so cron mails/alerting can catch it
set -euo pipefail

BACKUP_DIR="${1:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
CONTAINER="${POSTGRES_CONTAINER:-gp-postgres}"
DB_USER="${POSTGRES_USER:-guestpost}"
DB_NAME="${POSTGRES_DB:-guestpost}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="${BACKUP_DIR}/guestpost_${STAMP}.dump"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

# Dumps contain customer PII and financial records — owner-only from creation.
umask 077

echo "[backup] Dumping ${DB_NAME} from container ${CONTAINER} ..."
docker exec "${CONTAINER}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" --format=custom --compress=9 > "${OUT}"

# Sanity check: a dump pg_restore cannot read is not a backup.
echo "[backup] Verifying dump readability ..."
docker exec -i "${CONTAINER}" pg_restore --list < "${OUT}" > /dev/null

SIZE="$(du -h "${OUT}" | cut -f1)"
echo "[backup] OK: ${OUT} (${SIZE})"

echo "[backup] Pruning backups older than ${RETENTION_DAYS} days ..."
find "${BACKUP_DIR}" -name "guestpost_*.dump" -type f -mtime "+${RETENTION_DAYS}" -delete

echo "[backup] Done."
