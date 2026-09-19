/** Internal escape hatch for wrappers that install an explicit RLS context. */
export const RLS_RAW_CLIENT = Symbol.for("@guestpost/database/rls-raw-client")
