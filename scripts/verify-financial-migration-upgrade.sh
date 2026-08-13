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
negative_rehearsal_database="guestpost_finance_migration_negative"
runtime_rehearsal_role="guestpost_migration_fence_runtime"
serializable_rehearsal_log=""
serializable_rehearsal_fifo=""
serializable_rehearsal_fifo_dir=""
serializable_reader_fd_open=false
serializable_reader_pid=""
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

run_rehearsal_file_in_database() {
  local target_database="$1"
  local sql_file="$2"
  shift 2
  if [[ "${use_local_docker}" == true ]]; then
    docker exec -i gp-postgres \
      psql \
      -U "${rehearsal_user}" \
      -d "${target_database}" \
      -v ON_ERROR_STOP=1 \
      -X \
      "$@" < "${sql_file}"
    return
  fi
  psql \
    -h "${rehearsal_host}" \
    -p "${rehearsal_port}" \
    -U "${rehearsal_user}" \
    -d "${target_database}" \
    -v ON_ERROR_STOP=1 \
    -X \
    "$@" \
    -f "${sql_file}"
}

run_rehearsal_file() {
  local sql_file="$1"
  shift
  run_rehearsal_file_in_database \
    "${rehearsal_database}" \
    "${sql_file}" \
    "$@"
}

cleanup() {
  local exit_status=$?
  if [[ "${serializable_reader_fd_open}" == true ]]; then
    exec 9>&- || true
    serializable_reader_fd_open=false
  fi
  if [[ -n "${serializable_reader_pid}" ]] \
      && kill -0 "${serializable_reader_pid}" 2>/dev/null; then
    kill "${serializable_reader_pid}" 2>/dev/null || true
    wait "${serializable_reader_pid}" 2>/dev/null || true
  fi
  if [[ -n "${serializable_rehearsal_fifo}" \
      && -p "${serializable_rehearsal_fifo}" ]]; then
    rm -f "${serializable_rehearsal_fifo}"
  fi
  if [[ -n "${serializable_rehearsal_fifo_dir}" \
      && -d "${serializable_rehearsal_fifo_dir}" ]]; then
    rmdir "${serializable_rehearsal_fifo_dir}" 2>/dev/null || true
  fi
  if [[ -n "${serializable_rehearsal_log}" \
      && -f "${serializable_rehearsal_log}" ]]; then
    rm -f "${serializable_rehearsal_log}"
  fi
  run_admin_sql \
    "DROP DATABASE IF EXISTS \"${negative_rehearsal_database}\" WITH (FORCE)" \
    >/dev/null || true
  run_admin_sql \
    "DROP DATABASE IF EXISTS \"${rehearsal_database}\" WITH (FORCE)" \
    >/dev/null || true
  run_admin_sql \
    "DROP ROLE IF EXISTS \"${runtime_rehearsal_role}\"" \
    >/dev/null || true
  return "${exit_status}"
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
    if [[ "${migration_name}" == "20260802096000_revision_lifecycle_backstop" ]]; then
      echo "Proving revision migration rejects unexplained active duplicates"
      run_rehearsal_file \
        scripts/fixtures/pre-revision-lifecycle-unexplained-duplicates.sql \
        >/dev/null
      if revision_output="$(run_rehearsal_file "${migration_file}" 2>&1)"; then
        echo "Revision migration unexpectedly accepted unexplained duplicates" >&2
        exit 70
      fi
      if [[ "${revision_output}" != *"revision lifecycle migration blocked: an order has multiple active revisions"* ]]; then
        echo "Revision migration failed for an unexpected reason:" >&2
        echo "${revision_output}" >&2
        exit 71
      fi
      run_rehearsal_file \
        scripts/fixtures/pre-revision-lifecycle-unexplained-duplicates-cleanup.sql \
        >/dev/null
      echo "Unexplained-revision preflight rejection passed"
    fi
    if [[ "${migration_name}" == "20260802097000_legacy_withdrawal_reservation_evidence" ]]; then
      for legacy_case in \
        pending_missing_debit \
        rejected_missing_reversal \
        rejected_at_cutover
      do
        echo "Proving legacy withdrawal migration rejects ${legacy_case}"
        run_admin_sql \
          "DROP DATABASE IF EXISTS \"${negative_rehearsal_database}\" WITH (FORCE)" \
          >/dev/null
        run_admin_sql \
          "CREATE DATABASE \"${negative_rehearsal_database}\" TEMPLATE \"${rehearsal_database}\"" \
          >/dev/null
        run_rehearsal_file_in_database \
          "${negative_rehearsal_database}" \
          scripts/fixtures/pre-legacy-withdrawal-reservation-unsafe.sql \
          -v "legacy_case=${legacy_case}" \
          >/dev/null
        if legacy_output="$(
          run_rehearsal_file_in_database \
            "${negative_rehearsal_database}" \
            "${migration_file}" \
            2>&1
        )"; then
          echo "Legacy withdrawal migration unexpectedly accepted ${legacy_case}" >&2
          exit 72
        fi
        expected_legacy_error="pending reservation cannot be reconstructed exactly"
        if [[ "${legacy_case}" != "pending_missing_debit" ]]; then
          expected_legacy_error="rejected reservation cannot be reconstructed exactly"
        fi
        if [[ "${legacy_output}" != *"${expected_legacy_error}"* ]]; then
          echo "Legacy withdrawal migration failed for an unexpected reason in ${legacy_case}:" >&2
          echo "${legacy_output}" >&2
          exit 73
        fi
        run_admin_sql \
          "DROP DATABASE IF EXISTS \"${negative_rehearsal_database}\" WITH (FORCE)" \
          >/dev/null
        echo "Legacy withdrawal ${legacy_case} rejection passed"
      done
    fi
    if [[ "${migration_name}" == "20260811132000_refund_financial_audience_repair" ]]; then
      echo "Loading populated legacy refund-audience fixture"
      run_rehearsal_file \
        scripts/fixtures/pre-refund-audience-repair.sql \
        >/dev/null
      echo "Proving refund audience repair is atomic on a late statement failure"
      run_rehearsal_file \
        scripts/fixtures/inject-refund-audience-repair-failure.sql \
        >/dev/null
      if refund_repair_failure_output="$(run_rehearsal_file "${migration_file}" 2>&1)"; then
        echo "Refund audience repair unexpectedly survived the injected failure" >&2
        exit 74
      fi
      if [[ "${refund_repair_failure_output}" != *"forced refund audience migration failure"* ]]; then
        echo "Refund audience repair failed for an unexpected reason:" >&2
        echo "${refund_repair_failure_output}" >&2
        exit 75
      fi
      run_rehearsal_file \
        scripts/fixtures/post-refund-audience-repair-rollback-assertions.sql \
        >/dev/null
      run_rehearsal_file \
        scripts/fixtures/remove-refund-audience-repair-failure.sql \
        >/dev/null
      echo "Refund audience repair atomic rollback passed"
    fi
    if [[ "${migration_name}" == "20260812102500_validate_delivery_fraud_staff_disposition" ]]; then
      echo "Proving staff-disposition validation rejects unclassified immutable history"
      run_admin_sql \
        "DROP DATABASE IF EXISTS \"${negative_rehearsal_database}\" WITH (FORCE)" \
        >/dev/null
      run_admin_sql \
        "CREATE DATABASE \"${negative_rehearsal_database}\" TEMPLATE \"${rehearsal_database}\"" \
        >/dev/null
      run_rehearsal_file_in_database \
        "${negative_rehearsal_database}" \
        scripts/fixtures/pre-delivery-fraud-disposition-validation-unsafe.sql \
        >/dev/null
      disposition_migration_succeeded=false
      if disposition_output="$(
        run_rehearsal_file_in_database \
          "${negative_rehearsal_database}" \
          "${migration_file}" \
          2>&1
      )"; then
        disposition_migration_succeeded=true
      fi
      # Drop the isolated unsafe history before evaluating the result. The
      # global EXIT trap remains a backstop for fixture/setup failures.
      run_admin_sql \
        "DROP DATABASE IF EXISTS \"${negative_rehearsal_database}\" WITH (FORCE)" \
        >/dev/null
      if [[ "${disposition_migration_succeeded}" == true ]]; then
        echo "Staff-disposition validation unexpectedly accepted unclassified history" >&2
        exit 79
      fi
      if [[ "${disposition_output}" != *"DeliveryFraudFlagResolution_staff_disposition_check"* ]]; then
        echo "Staff-disposition validation failed for an unexpected reason:" >&2
        echo "${disposition_output}" >&2
        exit 80
      fi
      echo "Unclassified staff-disposition validation rejection passed"
    fi
    migration_started_at="$(date +%s)"
    run_rehearsal_file "${migration_file}" >/dev/null
    migration_finished_at="$(date +%s)"
    echo "Applied ${migration_name} in $((migration_finished_at - migration_started_at))s"
    if [[ "${migration_name}" == "20260802097000_legacy_withdrawal_reservation_evidence" ]]; then
      run_rehearsal_file "${migration_file}" >/dev/null
      echo "Legacy withdrawal migration idempotent rerun passed"
    fi
    if [[ "${migration_name}" == "20260729120000_provision_finance_aggregates" ]]; then
      run_rehearsal_file \
        scripts/fixtures/pre-aggregate-hardening-missing-wallet-history-cleanup.sql \
        >/dev/null
      echo "PENDING invitee personal-wallet non-attribution passed"
    fi
    if [[ "${migration_name}" == "20260811132000_refund_financial_audience_repair" ]]; then
      run_rehearsal_file \
        scripts/fixtures/post-refund-audience-repair-assertions.sql \
        >/dev/null
      run_rehearsal_file "${migration_file}" >/dev/null
      run_rehearsal_file \
        scripts/fixtures/post-refund-audience-repair-assertions.sql \
        >/dev/null
      echo "Refund financial-audience populated repair and idempotent rerun passed"
    fi
  fi
done

echo "Checking populated migration classifications, constraints, and triggers"
run_rehearsal_file scripts/fixtures/post-finance-hardening-assertions.sql \
  >/dev/null

echo "Checking stale SERIALIZABLE URL-claim readers retry after a concurrent writer"
serializable_rehearsal_log="$(mktemp)"
serializable_rehearsal_fifo_dir="$(mktemp -d)"
serializable_rehearsal_fifo="${serializable_rehearsal_fifo_dir}/reader.sql.fifo"
mkfifo "${serializable_rehearsal_fifo}"
run_rehearsal_file "${serializable_rehearsal_fifo}" \
  >"${serializable_rehearsal_log}" 2>&1 &
serializable_reader_pid=$!
exec 9>"${serializable_rehearsal_fifo}"
serializable_reader_fd_open=true
cat scripts/fixtures/delivery-url-fence-serializable-reader.sql \
  >&9
snapshot_ready=false
for _ in {1..80}; do
  if grep -q "SERIALIZABLE_SNAPSHOT_READY" "${serializable_rehearsal_log}"; then
    snapshot_ready=true
    break
  fi
  if ! kill -0 "${serializable_reader_pid}" 2>/dev/null; then
    break
  fi
  sleep 0.05
done
if [[ "${snapshot_ready}" != true ]]; then
  exec 9>&-
  serializable_reader_fd_open=false
  wait "${serializable_reader_pid}" || true
  echo "Serializable URL-fence reader did not establish its snapshot:" >&2
  sed -n '1,120p' "${serializable_rehearsal_log}" >&2
  exit 76
fi
run_rehearsal_file \
  scripts/fixtures/delivery-url-fence-concurrent-writer.sql \
  >/dev/null
cat scripts/fixtures/delivery-url-fence-serializable-reader-release.sql \
  >&9
exec 9>&-
serializable_reader_fd_open=false
if wait "${serializable_reader_pid}"; then
  echo "Stale SERIALIZABLE URL-fence reader unexpectedly committed" >&2
  exit 77
fi
if ! grep -q "ERROR:  40001:" "${serializable_rehearsal_log}"; then
  echo "Stale URL-fence reader failed without SQLSTATE 40001:" >&2
  sed -n '1,120p' "${serializable_rehearsal_log}" >&2
  exit 78
fi
rm -f "${serializable_rehearsal_log}"
serializable_rehearsal_log=""
rm -f "${serializable_rehearsal_fifo}"
serializable_rehearsal_fifo=""
rmdir "${serializable_rehearsal_fifo_dir}"
serializable_rehearsal_fifo_dir=""
serializable_reader_pid=""

echo "Checking restricted delivery URL fence runtime authority"
run_admin_sql \
  "CREATE ROLE \"${runtime_rehearsal_role}\" NOLOGIN; GRANT \"${runtime_rehearsal_role}\" TO \"${rehearsal_user}\"" \
  >/dev/null
run_rehearsal_file \
  scripts/fixtures/grant-delivery-url-fence-runtime.sql \
  -v "runtime_role=${runtime_rehearsal_role}" \
  >/dev/null
run_rehearsal_file \
  scripts/fixtures/post-delivery-url-fence-runtime-assertions.sql \
  -v "runtime_role=${runtime_rehearsal_role}" \
  >/dev/null

echo "Finance populated-data migration rehearsal passed"
