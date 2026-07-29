#!/usr/bin/env bash
set -euo pipefail

# Rehearse the finance hardening migrations against historical data, not only
# an empty final-schema database. The target database name is fixed and the
# host is restricted to loopback to make accidental production use impossible.

cd "$(dirname "$0")/.."

rehearsal_host="${PGHOST:-localhost}"
rehearsal_port="${PGPORT:-5432}"
rehearsal_user="${PGUSER:-guestpost}"
rehearsal_password="${PGPASSWORD:-guestpost}"
rehearsal_database="guestpost_finance_migration_rehearsal"
hardening_start="20260729085000_payment_provider_event_quarantine"
migration_root="packages/database/prisma/migrations"

case "${rehearsal_host}" in
  localhost | 127.0.0.1 | ::1) ;;
  *)
    echo "Refusing finance migration rehearsal against non-loopback host: ${rehearsal_host}" >&2
    exit 64
    ;;
esac

export PGPASSWORD="${rehearsal_password}"

use_local_docker=false
if command -v docker >/dev/null 2>&1 \
  && docker inspect gp-postgres >/dev/null 2>&1; then
  use_local_docker=true
fi

run_admin_sql() {
  local statement="$1"
  if [[ "${use_local_docker}" == true ]]; then
    docker exec gp-postgres \
      psql -U "${rehearsal_user}" -d postgres -v ON_ERROR_STOP=1 -X \
      -c "${statement}"
    return
  fi
  psql \
    -h "${rehearsal_host}" \
    -p "${rehearsal_port}" \
    -U "${rehearsal_user}" \
    -d postgres \
    -v ON_ERROR_STOP=1 \
    -X \
    -c "${statement}"
}

run_rehearsal_file() {
  local sql_file="$1"
  shift
  if [[ "${use_local_docker}" == true ]]; then
    docker exec -i gp-postgres \
      psql \
      -U "${rehearsal_user}" \
      -d "${rehearsal_database}" \
      -v ON_ERROR_STOP=1 \
      -X \
      "$@" < "${sql_file}"
    return
  fi
  psql \
    -h "${rehearsal_host}" \
    -p "${rehearsal_port}" \
    -U "${rehearsal_user}" \
    -d "${rehearsal_database}" \
    -v ON_ERROR_STOP=1 \
    -X \
    "$@" \
    -f "${sql_file}"
}

cleanup() {
  run_admin_sql \
    "DROP DATABASE IF EXISTS \"${rehearsal_database}\" WITH (FORCE)" \
    >/dev/null
}
trap cleanup EXIT

cleanup
run_admin_sql "CREATE DATABASE \"${rehearsal_database}\"" >/dev/null

found_hardening_start=false
for migration_file in "${migration_root}"/*/migration.sql; do
  migration_name="$(basename "$(dirname "${migration_file}")")"
  if [[ "${migration_name}" == "${hardening_start}" ]]; then
    found_hardening_start=true
    break
  fi
  echo "Applying pre-hardening migration ${migration_name}"
  run_rehearsal_file "${migration_file}" >/dev/null
done

if [[ "${found_hardening_start}" != true ]]; then
  echo "Finance hardening migration boundary was not found" >&2
  exit 65
fi

echo "Loading populated historical finance fixture"
run_rehearsal_file scripts/fixtures/pre-finance-hardening-history.sql \
  >/dev/null

apply_hardening=false
for migration_file in "${migration_root}"/*/migration.sql; do
  migration_name="$(basename "$(dirname "${migration_file}")")"
  if [[ "${migration_name}" == "${hardening_start}" ]]; then
    apply_hardening=true
  fi
  if [[ "${apply_hardening}" == true ]]; then
    echo "Applying hardening migration ${migration_name}"
    if [[ "${migration_name}" == "20260729100000_payout_completion_evidence" ]]; then
      echo "Proving payout migration rejects conflicting historical actors"
      run_rehearsal_file \
        scripts/fixtures/pre-payout-hardening-conflicting-actors.sql \
        >/dev/null
      if conflict_output="$(run_rehearsal_file "${migration_file}" 2>&1)"; then
        echo "Payout migration unexpectedly accepted conflicting actors" >&2
        exit 66
      fi
      if [[ "${conflict_output}" != *"withdrawal provenance audits contain conflicting actors"* ]]; then
        echo "Payout migration failed for an unexpected reason:" >&2
        echo "${conflict_output}" >&2
        exit 67
      fi
      run_rehearsal_file \
        scripts/fixtures/pre-payout-hardening-conflicting-actors-cleanup.sql \
        >/dev/null
      echo "Conflicting-actor preflight rejection passed"
    fi
    if [[ "${migration_name}" == "20260729120000_provision_finance_aggregates" ]]; then
      for aggregate_case in \
        paid_order \
        order_transaction \
        settlement \
        platform_revenue \
        cancellation_refund \
        status_drift \
        active_personal_wallet
      do
        echo "Proving aggregate migration rejects ${aggregate_case} history without a Wallet"
        run_rehearsal_file \
          scripts/fixtures/pre-aggregate-hardening-missing-wallet-history.sql \
          -v "aggregate_case=${aggregate_case}" \
          >/dev/null
        if aggregate_output="$(run_rehearsal_file "${migration_file}" 2>&1)"; then
          echo "Aggregate migration unexpectedly accepted ${aggregate_case} missing-wallet history" >&2
          exit 68
        fi
        if [[ "${aggregate_output}" != *"organization history exists without Wallet"* ]]; then
          echo "Aggregate migration failed for an unexpected reason in ${aggregate_case}:" >&2
          echo "${aggregate_output}" >&2
          exit 69
        fi
        run_rehearsal_file \
          scripts/fixtures/pre-aggregate-hardening-missing-wallet-history-cleanup.sql \
          >/dev/null
        echo "Missing-wallet ${aggregate_case} preflight rejection passed"
      done
      echo "Proving a PENDING invitee's personal-wallet history is not attributed to the organization"
      run_rehearsal_file \
        scripts/fixtures/pre-aggregate-hardening-missing-wallet-history.sql \
        -v "aggregate_case=pending_personal_wallet" \
        >/dev/null
    fi
    migration_started_at="$(date +%s)"
    run_rehearsal_file "${migration_file}" >/dev/null
    migration_finished_at="$(date +%s)"
    echo "Applied ${migration_name} in $((migration_finished_at - migration_started_at))s"
    if [[ "${migration_name}" == "20260729120000_provision_finance_aggregates" ]]; then
      run_rehearsal_file \
        scripts/fixtures/pre-aggregate-hardening-missing-wallet-history-cleanup.sql \
        >/dev/null
      echo "PENDING invitee personal-wallet non-attribution passed"
    fi
  fi
done

echo "Checking populated migration classifications, constraints, and triggers"
run_rehearsal_file scripts/fixtures/post-finance-hardening-assertions.sql \
  >/dev/null

echo "Finance populated-data migration rehearsal passed"
