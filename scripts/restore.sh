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
compose() { docker compose --env-file "$ENV_FILE" $COMPOSE_FILES "$@"; }
fail() { echo "restore: $*; nothing was changed." >&2; exit 1; }

# Check the backup before touching anything: a bad file found after the drop leaves no data.
test -s "$dir/postgres.dump" || fail "$dir/postgres.dump is missing or empty"
test -s "$dir/valkey.rdb" || fail "$dir/valkey.rdb is missing or empty"
case "$(head -c 6 "$dir/valkey.rdb")" in
  REDIS* | VALKEY) ;;
  *) fail "$dir/valkey.rdb is not a Valkey snapshot" ;;
esac
# pg_restore reads the dump's header and table of contents (Postgres stays up throughout).
compose exec -T postgres pg_restore --list < "$dir/postgres.dump" > /dev/null ||
  fail "$dir/postgres.dump is not a pg_dump custom-format archive pg_restore can read"

# Restore into a scratch database first (services keep running on the old one): a dump whose
# data section is corrupt fails here, and the scratch database is all there is to clean up.
# A fresh database also avoids dropping objects one by one, which trips over partitions.
ts="$(date -u +%Y%m%d%H%M%S)"
scratch="brake_restore_$ts"
old="brake_old_$ts"
compose exec -T postgres createdb -U brake -O brake "$scratch" ||
  fail "could not create the scratch database $scratch"
if ! compose exec -T postgres pg_restore -U brake -d "$scratch" --no-owner --exit-on-error \
  < "$dir/postgres.dump"; then
  compose exec -T postgres dropdb -U brake --if-exists --force "$scratch" || true
  fail "$dir/postgres.dump did not restore cleanly"
fi

# Nothing may write while the data is swapped.
services="$(compose config --services | grep -vxE 'postgres|valkey')"
compose stop $services

# Swap the databases in one transaction (from the maintenance database), then drop the old one.
compose exec -T postgres psql -U brake -d postgres -v ON_ERROR_STOP=1 -q -c "
  SELECT pg_terminate_backend(pid, 5000) FROM pg_stat_activity
    WHERE datname IN ('brake', '$scratch') AND pid <> pg_backend_pid();
  ALTER DATABASE brake RENAME TO $old;
  ALTER DATABASE $scratch RENAME TO brake;" > /dev/null
compose exec -T postgres dropdb -U brake --if-exists --force "$old" ||
  echo "restore: could not drop the previous database $old; drop it yourself." >&2

# Valkey with append-only files on ignores a snapshot when no AOF exists, so load it once with
# AOF off, turn AOF on (Valkey rewrites it from memory) and shut down cleanly.
compose stop valkey
volume="$(compose ps -a -q valkey | xargs docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
docker run --rm -v "$volume:/data" -v "$(cd "$dir" && pwd):/backup:ro" valkey/valkey:8@sha256:8f836008e0986c36adf50da714c7060cf689dbb335f61fe077939d90fa650809 sh -ec '
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
compose start valkey
if [ "${NO_START:-}" = 1 ]; then
  echo "Restored from $dir. Services left stopped: start them with docker compose ... up -d --wait."
  exit 0
fi
compose up -d --wait
echo "Restored from $dir."
