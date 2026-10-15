/**
 * List of available providers, independent of the database engine.
 *
 * A provider exists as soon as it has storage space in the database; its display
 * name comes from the registry, which it populates itself. A provider with no
 * registry entry — not started yet, or no registry at all — falls back to its
 * capitalized name.
 */

import type { DataStore } from './port.js'

export interface Provider {
  name: string
  displayName: string
  /** `auto` (flux added immediately) or `manual` (request an admin must approve). */
  flux_approval: 'auto' | 'manual'
  /** Content retention override, in days, set by an admin. Absent = the provider
   *  follows the instance-wide global default (see /ui/maintenance). */
  retention_days?: number
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export async function listProviders(store: DataStore): Promise<Provider[]> {
  const names = await store.listProviderNames()
  if (names.length === 0) return []

  const registry = await store.readRegistry(names)
  const meta = new Map(registry.map((r) => [r.name, r]))

  return names
    .map((name) => ({
      name,
      displayName: meta.get(name)?.display_name ?? capitalize(name),
      sortOrder: meta.get(name)?.sort_order ?? 999,
      flux_approval: meta.get(name)?.flux_approval ?? 'auto',
      retention_days: meta.get(name)?.retention_days,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map(({ name, displayName, flux_approval, retention_days }) => {
      const p: Provider = { name, displayName, flux_approval }
      if (retention_days != null) p.retention_days = retention_days
      return p
    })
}
