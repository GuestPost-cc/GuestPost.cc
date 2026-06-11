export const QUEUES = {
  EMAIL: "email",
  REPORT: "report",
  NOTIFICATION: "notification",
  IMPORT: "import",
  AI: "ai",
  VERIFICATION: "verification",
  PAYOUT: "payout",
  RECONCILIATION: "reconciliation",
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
  [QUEUES.PAYOUT]: {
    EXECUTE: "payout-execute",
    CHECK_STATUS: "payout-check-status",
    WEBHOOK: "payout-webhook",
  },
  [QUEUES.RECONCILIATION]: {
    RUN: "reconciliation-run",
  },
} as const
