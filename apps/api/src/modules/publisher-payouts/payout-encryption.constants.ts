/**
 * Database value identifying the ciphertext envelope format. Key identity is
 * deliberately carried inside the v2 envelope and is not this number.
 */
export const CURRENT_PAYOUT_KEY_VERSION = 2
export const PAYOUT_ENCRYPTION_ENVELOPE_PREFIX = "p2"
export const MAX_PAYOUT_ENCRYPTION_KEYS = 16
export const MAX_PAYOUT_ENCRYPTION_KEY_ID_LENGTH = 64
export const MAX_PAYOUT_ENCRYPTION_PLAINTEXT_BYTES = 64 * 1024
