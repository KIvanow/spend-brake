#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into a Compose install, replacing its data:
#   scripts/restore.sh backups/20261030T120000Z
# Spend recorded after the backup was taken is not in it: live counters go back to that time.
# Services start again at the end; NO_START=1 leaves them stopped (Postgres and Valkey stay up),
# for example to start a different release on the restored data yourself.
set -euo pipefail
COMPOSE_FILES="${COMPOSE_FILES:--f infra/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-infra/.env}"
dir="${1:?usage: scripts/restore.sh <backup-dir>}"
test -s "$dir/postgres.dump" && test -s "$dir/valkey.rdb"
compose() { docker compose --env-file "$ENV_FILE" $COMPOSE_FILES "$@"; }

# Nothing may write while the data is swapped.
services="$(compose config --services | grep -vxE 'postgres|valkey')"
compose stop $services

# Into a fresh database: dropping objects one by one trips over partitions and dependencies.
compose exec -T postgres dropdb -U brake --if-exists --force brake
compose exec -T postgres createdb -U brake -O brake brake
compose exec -T postgres pg_restore -U brake -d brake --no-owner --exit-on-error \
  < "$dir/postgres.dump"

# Valkey with append-only files on ignores a snapshot when no AOF exists, so load it once with
# AOF off, turn AOF on (Valkey rewrites it from memory) and shut down cleanly.
compose stop valkey
volume="$(compose ps -a -q valkey | xargs docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
docker run --rm -v "$volume:/data" -v "$(cd "$dir" && pwd):/backup:ro" valkey/valkey:8 sh -ec '
  rm -rf /data/appendonlydir /data/appendonly.aof /data/dump.rdb
  cp /backup/valkey.rdb /data/dump.rdb
  valkey-server --dir /data --appendonly no --save "" --port 6399 --daemonize yes
  until valkey-cli -p 6399 ping >/dev/null 2>&1; do sleep 0.2; done
  valkey-cli -p 6399 config set appendonly yes >/dev/null
  until valkey-cli -p 6399 info persistence | grep -q aof_enabled:1 &&
    valkey-cli -p 6399 info persistence | grep -q aof_rewrite_in_progress:0 &&
    valkey-cli -p 6399 info persistence | grep -q aof_rewrite_scheduled:0; do sleep 0.2; done
  echo "Valkey keys restored: $(valkey-cli -p 6399 dbsize)"
  valkey-cli -p 6399 shutdown
  while valkey-cli -p 6399 ping >/dev/null 2>&1; do sleep 0.2; done
  chown -R valkey:valkey /data'
if [ "${NO_START:-}" = 1 ]; then
  echo "Restored from $dir. Services left stopped: start them with docker compose ... up -d --wait."
  exit 0
fi
compose up -d --wait
echo "Restored from $dir."
