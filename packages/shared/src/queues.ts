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
  SETTLEMENT_RELEASE: "settlement-release",
  AUTO_ACCEPT: "auto-accept",
  INTEGRATION_SYNC: "integration-sync",
  INTEGRATION_DISCOVERY: "integration-discovery",
  DOMAIN_METRICS: "domain-metrics",
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

export const QUEUE_JOBS = {
  [QUEUES.EMAIL]: {
    SEND_WELCOME: "send-welcome",
    SEND_INVOICE: "send-invoice",
    SEND_NOTIFICATION: "send-notification",
    SEND_MAGIC_LINK: "send-magic-link",
    SEND_REMINDER_EMAIL: "send-reminder-email",
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
    CHECK_STATUS: "payout-check-status",
    WEBHOOK: "payout-webhook",
  },
  [QUEUES.RECONCILIATION]: {
    RUN: "reconciliation-run",
  },
  [QUEUES.SETTLEMENT]: {
    // Phase 7.3 — the only job on this queue. Repeatable; jobId
    // "settlement-auto-approve" dedups cluster-wide so only one instance
    // runs per cadence regardless of pod count.
    AUTO_APPROVE: "settlement-auto-approve",
  },
  [QUEUES.SETTLEMENT_RELEASE]: {
    // Phase 6 — auto-release sweep. Finds CUSTOMER_APPROVED settlements
    // with releasePolicy=AUTO and releases them (balance + order complete).
    AUTO_RELEASE: "settlement-auto-release",
  },
  [QUEUES.AUTO_ACCEPT]: {
    SWEEP: "auto-accept-sweep",
    REMINDER_SWEEP: "review-reminder-sweep",
    CANCELLATION_TIMEOUT_SWEEP: "cancellation-response-timeout-sweep",
    ACCEPTANCE_TIMEOUT_SWEEP: "order-acceptance-timeout-sweep",
  },
  [QUEUES.INTEGRATION_SYNC]: {
    SYNC: "sync",
  },
  [QUEUES.INTEGRATION_DISCOVERY]: {
    DISCOVER: "discover",
  },
  [QUEUES.DOMAIN_METRICS]: {
    SYNC: "domain-metrics-sync",
  },
} as const
