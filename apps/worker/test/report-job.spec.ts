import assert from "node:assert/strict"
import test from "node:test"
import { QUEUE_JOBS, QUEUES } from "@guestpost/shared"
import { resolveReportJobFormat } from "../src/lib/report-job"

test("executes legacy report jobs using their requested format", () => {
  assert.equal(
    resolveReportJobFormat(QUEUE_JOBS[QUEUES.REPORT].LEGACY_GENERATE, "csv"),
    "csv",
  )
  assert.equal(
    resolveReportJobFormat(QUEUE_JOBS[QUEUES.REPORT].LEGACY_GENERATE, "pdf"),
    "pdf",
  )
})

test("canonical job names control their format and unknown jobs fail closed", () => {
  assert.equal(
    resolveReportJobFormat(QUEUE_JOBS[QUEUES.REPORT].GENERATE_CSV, "pdf"),
    "csv",
  )
  assert.equal(
    resolveReportJobFormat(QUEUE_JOBS[QUEUES.REPORT].GENERATE_PDF, "csv"),
    "pdf",
  )
  assert.throws(
    () => resolveReportJobFormat("unexpected-report-job", "pdf"),
    /Unsupported report job name/,
  )
})
