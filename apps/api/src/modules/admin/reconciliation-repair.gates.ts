import type { PrismaService } from "../../common/prisma.service"

export function isStagingSingleActorRepairEnabled() {
  return (
    process.env.DEPLOYMENT_ENVIRONMENT === "staging" &&
    process.env.FINANCE_RUNTIME_MODE === "recovery_only" &&
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED === "true" &&
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS ===
      "true" &&
    process.env
      .FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MAKER_CHECKER_BYPASS === "true"
  )
}


export async function isStagingSingleActorRepairDatabaseEnabled(
  prisma: Pick<PrismaService, "$queryRaw">,
) {
  if (!isStagingSingleActorRepairEnabled()) return false
  const [setting] = await prisma.$queryRaw<Array<{ enabled: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_db_role_setting AS setting
      JOIN pg_catalog.pg_roles AS configured_role
        ON configured_role.oid = setting.setrole
      WHERE setting.setdatabase = (
          SELECT database.oid FROM pg_catalog.pg_database AS database
          WHERE database.datname = current_database()
        )
        AND configured_role.rolname = 'guestpost_financial_repair_staging'
        AND pg_catalog.pg_has_role(
          session_user,
          configured_role.oid,
          'MEMBER'
        )
        AND 'guestpost.financial_repair_single_actor=on' = ANY(setting.setconfig)
    ) AS enabled
  `
  return setting?.enabled === true
}
