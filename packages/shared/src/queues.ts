export const QUEUES = {
  EMAIL: "email",
  REPORT: "report",
  NOTIFICATION: "notification",
  IMPORT: "import",
  AI: "ai",
  VERIFICATION: "verification",
  WEBSITE_VERIFICATION: "website-verification",
  DELIVERY_VERIFICATION: "delivery-verification",
  PUBLISHER_TRUST: "publisher-trust",
  PAYOUT: "payout",
  RECONCILIATION: "reconciliation",
  SETTLEMENT: "settlement",
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

export const QUEUE_JOBS = {
  [QUEUES.EMAIL]: {
    SEND_WELCOME: "send-welcome",
    SEND_INVOICE: "send-invoice",
    SEND_NOTIFICATION: "send-notification",
    SEND_MAGIC_LINK: "send-magic-link",
  },
  [QUEUES.REPORT]: {
    GENERATE_PDF: "generate-pdf",
    GENERATE_CSV: "generate-csv",
    EXPORT_REPORT: "export-report",
  },
  [QUEUES.NOTIFICATION]: {
    PUSH_IN_APP: "push-in-app",
    PUSH_EMAIL: "push-email",
  },
  [QUEUES.IMPORT]: {
    BULK_ORDERS: "bulk-orders",
    BULK_PUBLISHERS: "bulk-publishers",
  },
  [QUEUES.AI]: {
    GENERATE_CONTENT: "generate-content",
    SUGGEST_ANCHORS: "suggest-anchors",
    MATCH_PUBLISHER: "match-publisher",
  },
  [QUEUES.VERIFICATION]: {
    VERIFY_LINK: "verify-link",
  },
  [QUEUES.WEBSITE_VERIFICATION]: {
    VERIFY: "website-verify",
    REVERIFY_SWEEP: "website-reverify-sweep",
  },
  [QUEUES.DELIVERY_VERIFICATION]: {
    VERIFY: "delivery-verify",
    HOLD_LINK_SWEEP: "settlement-hold-sweep",
  },
  [QUEUES.PUBLISHER_TRUST]: {
    RECOMPUTE: "publisher-trust-recompute",
  },
  [QUEUES.PAYOUT]: {
    EXECUTE: "payout-execute",
    CHECK_STATUS: "payout-check-status",
    WEBHOOK: "payout-webhook",
  },
  [QUEUES.RECONCILIATION]: {
    RUN: "reconciliation-run",
  },
  [QUEUES.SETTLEMENT]: {
    // Phase 7.3 — the only job on this queue today. Repeatable; jobId
    // "settlement-auto-approve" dedups cluster-wide so only one instance
    // runs per cadence regardless of pod count.
    AUTO_APPROVE: "settlement-auto-approve",
  },
} as const
