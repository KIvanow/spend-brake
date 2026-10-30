#!/usr/bin/env bash
# Back up a running Compose install: Postgres (config, ledger, audit log) and Valkey (live
# spend counters, reservations, kill switches). Run from the repository root:
#   scripts/backup.sh [backup-dir]        (default: backups/<UTC timestamp>)
# Pass the same compose files as for `up` in COMPOSE_FILES, e.g.
#   COMPOSE_FILES="-f infra/docker-compose.yml -f infra/docker-compose.tls.yml" scripts/backup.sh
set -euo pipefail
COMPOSE_FILES="${COMPOSE_FILES:--f infra/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-infra/.env}"
dir="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
compose() { docker compose --env-file "$ENV_FILE" $COMPOSE_FILES "$@"; }

mkdir -p "$dir"
chmod 700 "$dir"
# A consistent snapshot of the database (custom format, restorable with pg_restore).
compose exec -T postgres pg_dump -U brake -d brake -Fc > "$dir/postgres.dump"
# A point-in-time copy of Valkey's dataset.
compose exec -T valkey sh -c 'valkey-cli --no-auth-warning -a "$REDISCLI_AUTH" --rdb -' \
  > "$dir/valkey.rdb"
test -s "$dir/postgres.dump" && test -s "$dir/valkey.rdb"
echo "Backed up to $dir ($(du -sh "$dir" | cut -f1)). It holds encrypted credentials; keep"
echo "BRAKE_MASTER_KEY (infra/.env) separately: without it they cannot be decrypted."
