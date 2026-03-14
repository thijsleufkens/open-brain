#!/usr/bin/env bash
set -euo pipefail

# Open Brain — SQLite backup script
# Run via cron: 0 3 * * * /opt/open-brain/docker/backup.sh
#
# Uses SQLite's .backup command for a safe, consistent backup
# even while the database is being written to (WAL mode).

BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
DB_PATH="${DB_PATH:-/data/brain.db}"
KEEP_DAYS="${KEEP_DAYS:-14}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/brain_${TIMESTAMP}.db"

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

# Perform atomic backup via SQLite CLI
echo "[$(date -Iseconds)] Starting backup: ${DB_PATH} → ${BACKUP_FILE}"

if command -v sqlite3 &> /dev/null; then
  sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"
else
  # Fallback: copy (safe with WAL mode if no active writers)
  cp "${DB_PATH}" "${BACKUP_FILE}"
  # Also copy WAL and SHM if they exist
  [ -f "${DB_PATH}-wal" ] && cp "${DB_PATH}-wal" "${BACKUP_FILE}-wal"
  [ -f "${DB_PATH}-shm" ] && cp "${DB_PATH}-shm" "${BACKUP_FILE}-shm"
fi

# Compress
gzip "${BACKUP_FILE}"
echo "[$(date -Iseconds)] Backup complete: ${BACKUP_FILE}.gz ($(du -h "${BACKUP_FILE}.gz" | cut -f1))"

# Rotate old backups
if [ "${KEEP_DAYS}" -gt 0 ]; then
  DELETED=$(find "${BACKUP_DIR}" -name "brain_*.db.gz" -mtime +"${KEEP_DAYS}" -delete -print | wc -l)
  if [ "${DELETED}" -gt 0 ]; then
    echo "[$(date -Iseconds)] Rotated ${DELETED} old backup(s)"
  fi
fi
