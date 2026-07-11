export interface WorkflowConfig {
  reviewWindowDays: number
  verificationRetries: number
  verificationBackoffMinutes: number[]
  verificationSlaHours: number
  reminderDays: number[]
  autoReleaseMaxAmount: number
  enableAutoRelease: boolean
  newPublisherHoldDays: number
}

export const defaultWorkflowConfig: WorkflowConfig = {
  reviewWindowDays: 7,
  verificationRetries: 3,
  verificationBackoffMinutes: [5, 15, 60],
  verificationSlaHours: 48,
  reminderDays: [3, 6],
  autoReleaseMaxAmount: 100_000,
  enableAutoRelease: true,
  newPublisherHoldDays: 30,
}

export function loadWorkflowConfig(
  overrides?: Partial<WorkflowConfig>,
): WorkflowConfig {
  return { ...defaultWorkflowConfig, ...overrides }
}
