export const integrationKeys = {
  all: ["integrations"] as const,
  lists: () => [...integrationKeys.all, "list"] as const,
  list: (filters?: Record<string, unknown>) =>
    [...integrationKeys.lists(), filters] as const,
  details: () => [...integrationKeys.all, "detail"] as const,
  detail: (id: string) => [...integrationKeys.details(), id] as const,
  resources: (id: string) => [...integrationKeys.all, "resources", id] as const,
  syncs: () => [...integrationKeys.all, "syncs"] as const,
  sync: (syncId: string) => [...integrationKeys.syncs(), syncId] as const,
  syncHistory: (integrationId: string) =>
    [...integrationKeys.all, "syncHistory", integrationId] as const,
}
