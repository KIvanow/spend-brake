#!/usr/bin/env bash
# Build the Compose stack from source, start it with throwaway secrets and check every service
# answers. CI runs this on every change and before a release; run it from the repository root:
#   scripts/smoke-stack.sh            (KEEP=1 leaves the stack running afterwards)
# It uses its own Compose project (spend-brake-smoke) but the stack's usual host ports.
set -euo pipefail
PROJECT="${PROJECT:-spend-brake-smoke}"
env_file="$(mktemp)"
compose() { docker compose -p "$PROJECT" --env-file "$env_file" -f infra/docker-compose.yml "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose ps -a || true
    compose logs --no-color --tail 100 || true
  fi
  if [ "${KEEP:-}" != 1 ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  rm -f "$env_file"
  exit "$status"
}
trap cleanup EXIT

cat > "$env_file" <<EOF
BRAKE_MASTER_KEY=$(openssl rand -base64 32)
BRAKE_ACTION_SECRET=$(openssl rand -base64 32)
BRAKE_SETUP_TOKEN=$(openssl rand -hex 24)
VALKEY_PASSWORD=$(openssl rand -hex 24)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EOF

compose up -d --build --wait --wait-timeout 300

check() {
  local name="$1" url="$2"
  if curl -fsS --max-time 5 -o /dev/null "$url"; then
    echo "ok   $name $url"
  else
    echo "FAIL $name $url"
    return 1
  fi
}
check proxy http://127.0.0.1:8080/healthz
check api http://127.0.0.1:8081/healthz
check notifier http://127.0.0.1:8082/healthz
check web http://127.0.0.1:3000/
# The dashboard's nginx forwards /v1 to the API.
check web-to-api http://127.0.0.1:3000/v1/auth/options
# The worker publishes no port: ask from inside its container.
compose exec -T worker node -e \
  "fetch('http://localhost:9464/metrics').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
echo "ok   worker :9464/metrics"
echo "Stack is up and every service answers."
