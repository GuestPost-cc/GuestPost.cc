#!/usr/bin/env bash
set -euo pipefail

# Mark only the fixed local Docker Compose database. The privileged development
# seed requires this database-side proof before creating users or money.

cd "$(dirname "$0")/.."

compose_command=(
  docker compose
  --env-file .env.development
  -f infrastructure/docker/docker-compose.yml
)

container_id="$("${compose_command[@]}" ps -q postgres)"
if [[ -z "${container_id}" ]]; then
  echo "Local database sentinel failed: Postgres container is missing" >&2
  exit 69
fi

health_status=""
for ((attempt = 1; attempt <= 45; attempt += 1)); do
  health_status="$(
    docker inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
      "${container_id}" \
      2>/dev/null || true
  )"
  if [[ "${health_status}" == "healthy" ]]; then
    break
  fi
  sleep 1
done

if [[ "${health_status}" != "healthy" ]]; then
  echo "Local database sentinel failed: Postgres did not become healthy" >&2
  "${compose_command[@]}" ps postgres >&2
  exit 70
fi

"${compose_command[@]}" exec -T postgres sh -eu -c '
  database_name="$(
    psql \
      --username "${POSTGRES_USER}" \
      --dbname "${POSTGRES_DB}" \
      --no-align \
      --tuples-only \
      --command "SELECT current_database()"
  )"

  case "${database_name}" in
    "" | *[!a-zA-Z0-9_]* )
      echo "Local database sentinel failed: unsafe database name" >&2
      exit 64
      ;;
  esac

  psql \
    --username "${POSTGRES_USER}" \
    --dbname "${database_name}" \
    --set ON_ERROR_STOP=1 \
    --command "COMMENT ON DATABASE \"${database_name}\" IS '\''guestpost-local-development-v1'\''" \
    >/dev/null

  sentinel="$(
    psql \
      --username "${POSTGRES_USER}" \
      --dbname "${database_name}" \
      --no-align \
      --tuples-only \
      --command "SELECT shobj_description(oid, '\''pg_database'\'') FROM pg_database WHERE datname = current_database()"
  )"
  if [ "${sentinel}" != "guestpost-local-development-v1" ]; then
    echo "Local database sentinel failed: verification mismatch" >&2
    exit 65
  fi

  printf "Local development database sentinel ready\n"
'
