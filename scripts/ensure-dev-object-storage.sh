#!/usr/bin/env bash
set -euo pipefail

# Provision only the fixed local Docker Compose MinIO service. Production R2/S3
# buckets remain operator-owned and are never created by application startup.

cd "$(dirname "$0")/.."

compose_command=(
  docker compose
  --env-file .env.development
  -f infrastructure/docker/docker-compose.yml
)

container_id="$("${compose_command[@]}" ps -q minio)"
if [[ -z "${container_id}" ]]; then
  echo "Local object-storage bootstrap failed: MinIO container is missing" >&2
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
  echo "Local object-storage bootstrap failed: MinIO did not become healthy" >&2
  "${compose_command[@]}" ps minio >&2
  exit 70
fi

"${compose_command[@]}" exec -T minio sh -eu -c '
  bucket="${MINIO_BUCKET:-guestpost}"

  if [ "${MINIO_ROOT_USER}" != "${GUESTPOST_MINIO_ACCESS_KEY}" ] ||
     [ "${MINIO_ROOT_PASSWORD}" != "${GUESTPOST_MINIO_SECRET_KEY}" ]; then
    echo "Local object-storage bootstrap failed: app and MinIO credentials differ" >&2
    exit 65
  fi

  bucket_length=${#bucket}
  if [ "${bucket_length}" -lt 3 ] || [ "${bucket_length}" -gt 63 ]; then
    echo "Local object-storage bootstrap failed: invalid bucket name length" >&2
    exit 64
  fi
  case "${bucket}" in
    [a-z0-9]*[a-z0-9])
      ;;
    *)
      echo "Local object-storage bootstrap failed: invalid bucket name" >&2
      exit 64
      ;;
  esac
  case "${bucket}" in
    *[!a-z0-9.-]* | *..* | xn--* | sthree-* | amzn-s3-demo-* | *-s3alias | *--ol-s3 | *.mrap | *--x-s3 | *--table-s3)
      echo "Local object-storage bootstrap failed: invalid bucket name" >&2
      exit 64
      ;;
  esac

  old_ifs=${IFS}
  IFS=.
  set -- ${bucket}
  IFS=${old_ifs}
  if [ "$#" -eq 4 ]; then
    ipv4_shaped=true
    for octet in "$@"; do
      case "${octet}" in
        "" | *[!0-9]*) ipv4_shaped=false ;;
      esac
      if [ "${#octet}" -gt 3 ]; then
        ipv4_shaped=false
      fi
    done
    if [ "${ipv4_shaped}" = true ]; then
      echo "Local object-storage bootstrap failed: invalid bucket name" >&2
      exit 64
    fi
  fi

  mc_config_dir=$(mktemp -d)
  cleanup_mc_config() {
    rm -rf -- "${mc_config_dir}"
  }
  trap cleanup_mc_config EXIT

  mc --config-dir "${mc_config_dir}" alias set \
    guestpost-local \
    http://127.0.0.1:9000 \
    "${MINIO_ROOT_USER}" \
    "${MINIO_ROOT_PASSWORD}" \
    >/dev/null
  mc --config-dir "${mc_config_dir}" mb --ignore-existing \
    "guestpost-local/${bucket}" \
    >/dev/null
  sentinel_key=".guestpost/evidence-storage-ready-v1"
  if ! mc --config-dir "${mc_config_dir}" stat \
    "guestpost-local/${bucket}/${sentinel_key}" \
    >/dev/null 2>&1; then
    printf "GuestPost local evidence storage readiness\n" | \
      mc --config-dir "${mc_config_dir}" pipe \
        "guestpost-local/${bucket}/${sentinel_key}" \
        >/dev/null
  fi
  mc --config-dir "${mc_config_dir}" stat \
    "guestpost-local/${bucket}/${sentinel_key}" \
    >/dev/null
  printf "Local object-storage bucket ready: %s\n" "${bucket}"
'
