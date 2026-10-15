/**
 * PostgreSQL adapter — the reference implementation of the `DataStore` contract.
 *
 * The queries are the ones that used to be written directly in the routes: at
 * equal behavior, nothing should change for a Postgres deployment. This is also
 * the file to read when writing an adapter for another engine.
 */

import type postgres from 'postgres'
import { normalizeConfigObject } from './configShape.js'
import type {
  AdminRow,
  ConnectorKeyRow,
  ContentItemInput,
  ContentRow,
  DataStore,
  ErrorLogRow,
  FluxRequestRow,
  ItemStateKeys,
  NewAdmin,
  NewConnectorKey,
  NewUser,
  ProviderRegistration,
  PushTarget,
  RegistryEntry,
  Source,
  SourceHealth,
  SourceSubscriberRow,
  SubscriptionRow,
  UserRow,
} from './port.js'

/**
 * Repairs a doubly-serialized config.
 *
 * Writes used to pass a string followed by `::jsonb`: postgres.js inferred the
 * parameter type from it and serialized it a second time, so the database
 * stored a jsonb of type `string` instead of `object`. Writes are fixed, but
 * the rows already in the database stayed that way — we make them readable here
 * rather than through a migration no self-hoster would think to run.
 */
function repairConfig<T extends { config?: unknown }>(row: T): T {
  if (typeof row.config !== 'string') return row
  try {
    return { ...row, config: JSON.parse(row.config) }
  } catch {
    return row
  }
}

function normalizeRegistryRow(row: RegistryEntry): RegistryEntry {
  const base: RegistryEntry = {
    name: row.name,
    display_name: row.display_name,
    sort_order: row.sort_order,
    flux_approval: row.flux_approval === 'manual' ? 'manual' : 'auto',
  }
  // `retention_days` only shows up if an admin set one: otherwise the provider
  // follows the global default, and the key stays absent.
  const retention = Number(row.retention_days)
  if (Number.isFinite(retention) && row.retention_days != null) {
    base.retention_days = retention
  }
  return base
}

export class PostgresStore implements DataStore {
  constructor(private readonly sql: postgres.Sql) {}

  // ── Discovery ─────────────────────────────────────────────────────────────

  /** Self-healing: the table can be missing on a Workers deployment where the
   *  SQL schema is never applied and no connector has ever called
   *  `registerProvider` yet. */
  private async ensureProviderRegistryTable(): Promise<void> {
    await this.sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS provider_registry (
           name TEXT PRIMARY KEY, display_name TEXT NOT NULL,
           sort_order INTEGER NOT NULL DEFAULT 100,
           flux_approval TEXT NOT NULL DEFAULT 'auto',
           retention_days INTEGER,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
      )
      .catch(() => {})
    // Registry created by an earlier version: the column can be missing.
    await this.sql
      .unsafe(
        'ALTER TABLE provider_registry ADD COLUMN IF NOT EXISTS retention_days INTEGER',
      )
      .catch(() => {})
  }

  /** Names from `provider_registry`, tolerating the table's absence. */
  private async registeredNames(): Promise<string[]> {
    try {
      const rows = await this.sql<{ name: string }[]>`
        SELECT name FROM provider_registry
      `
      return rows.map((r) => r.name)
    } catch {
      return []
    }
  }

  /** Distinct names that have content, tolerating the table's absence — either
   *  of the two sources can be missing independently of the other. */
  private async namesWithContent(): Promise<string[]> {
    try {
      const rows = await this.sql<{ provider: string }[]>`
        SELECT DISTINCT provider FROM connector_item
      `
      return rows.map((r) => r.provider)
    } catch {
      return []
    }
  }

  async listProviderNames(): Promise<string[]> {
    const names = new Set([
      ...(await this.registeredNames()),
      ...(await this.namesWithContent()),
    ])
    return [...names].sort()
  }

  async providerExists(name: string): Promise<boolean> {
    try {
      const [row] = await this.sql<{ name: string }[]>`
        SELECT name FROM provider_registry WHERE name = ${name}
      `
      if (row) return true
    } catch {
      // table missing: fall back to the second source
    }
    try {
      const [row] = await this.sql<{ provider: string }[]>`
        SELECT provider FROM connector_item WHERE provider = ${name} LIMIT 1
      `
      return Boolean(row)
    } catch {
      return false
    }
  }

  async readRegistry(names: string[]): Promise<RegistryEntry[]> {
    // `provider_registry` does not belong to the API: the first collector to
    // start is the one that creates it. Its absence is not an error, just an
    // empty registry.
    //
    // We degrade column by column on `42703` (missing column): first without
    // `retention_days` (registry not migrated by a recent write yet — above all
    // do not lose `flux_approval` in the process), then down to the bare minimum.
    const isMissingColumn = (err: unknown) =>
      (err as { code?: string }).code === '42703'

    try {
      return (
        await this.sql<RegistryEntry[]>`
          SELECT name, display_name, sort_order, flux_approval, retention_days
          FROM provider_registry
          WHERE name = ANY(${names})
        `
      ).map(normalizeRegistryRow)
    } catch (err) {
      if (!isMissingColumn(err)) return []
    }

    try {
      return (
        await this.sql<RegistryEntry[]>`
          SELECT name, display_name, sort_order, flux_approval
          FROM provider_registry
          WHERE name = ANY(${names})
        `
      ).map(normalizeRegistryRow)
    } catch (err) {
      if (!isMissingColumn(err)) return []
    }

    return this.sql<RegistryEntry[]>`
      SELECT name, display_name, sort_order
      FROM provider_registry
      WHERE name = ANY(${names})
    `
      .then((rows) => rows.map(normalizeRegistryRow))
      .catch(() => [])
  }

  async setProviderApproval(
    name: string,
    approval: 'auto' | 'manual',
  ): Promise<void> {
    // Self-healing: the column can be missing on a Workers deployment where the
    // SQL schema is never applied. The first admin setting creates it.
    await this.sql
      .unsafe(
        `ALTER TABLE provider_registry ADD COLUMN IF NOT EXISTS flux_approval TEXT NOT NULL DEFAULT 'auto'`,
      )
      .catch(() => {})
    await this.sql`
      UPDATE provider_registry SET flux_approval = ${approval} WHERE name = ${name}
    `
  }

  // ── Content ───────────────────────────────────────────────────────────────
  // A single `connector_item` table, shared by every provider (`provider`
  // filtered by value — no longer by an interpolated table name).

  /** Self-healing, same reason as `ensureProviderRegistryTable`. */
  private async ensureConnectorItemTable(): Promise<void> {
    await this.sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS connector_item (
           id SERIAL PRIMARY KEY, provider TEXT NOT NULL,
           repository_id INTEGER NOT NULL REFERENCES repository(id),
           version TEXT, content TEXT NOT NULL, params JSONB,
           datetime TIMESTAMPTZ, executed_at TIMESTAMPTZ NOT NULL,
           success BOOLEAN NOT NULL);
         CREATE INDEX IF NOT EXISTS connector_item_provider_repo_idx
           ON connector_item (provider, repository_id, executed_at DESC)`,
      )
      .catch(() => {})
  }

  async allContent(provider: string): Promise<ContentRow[]> {
    return this.sql<ContentRow[]>`
      SELECT * FROM connector_item WHERE provider = ${provider} ORDER BY id
    `
  }

  async latestPerSource(provider: string): Promise<ContentRow[]> {
    return this.sql<ContentRow[]>`
      SELECT DISTINCT ON (repository_id) *
      FROM connector_item
      WHERE provider = ${provider}
      ORDER BY repository_id, COALESCE(datetime, executed_at) DESC
    `
  }

  async latestForSources(
    provider: string,
    sourceIds: number[],
    limit: number,
  ): Promise<ContentRow[]> {
    if (sourceIds.length === 0) return []
    try {
      return await this.sql<ContentRow[]>`
        SELECT * FROM (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY repository_id ORDER BY executed_at DESC
            ) AS _rn
          FROM connector_item
          WHERE provider = ${provider} AND repository_id = ANY(${sourceIds})
        ) ranked
        WHERE _rn <= ${limit}
        ORDER BY repository_id, executed_at DESC
      `
    } catch (err) {
      // A failed read must not break the whole feed, but swallowing it silently
      // gave an inexplicable empty feed.
      console.error(`Failed to read provider "${provider}":`, err)
      return []
    }
  }

  async deleteContentForSource(
    provider: string,
    sourceId: number,
  ): Promise<void> {
    await this.sql`
      DELETE FROM connector_item
      WHERE provider = ${provider} AND repository_id = ${sourceId}
    `
  }

  // ── Collected content (writes, reserved for connectors) ──────────────────

  async insertContentItems(
    provider: string,
    items: ContentItemInput[],
  ): Promise<void> {
    if (items.length === 0) return
    await this.ensureConnectorItemTable()
    await this.sql.begin(async (transaction) => {
      const tx = transaction as unknown as postgres.Sql
      for (const item of items) {
        const paramsValue =
          item.params == null
            ? null
            : (tx.json(item.params as postgres.JSONValue) as never)
        await tx`
          INSERT INTO connector_item
            (provider, repository_id, version, content, params, datetime, executed_at, success)
          VALUES (${provider}, ${item.repositoryId}, ${item.version ?? null},
                  ${item.content}, ${paramsValue}, ${item.datetime ?? null},
                  ${item.executedAt}, ${item.success})
        `
      }
    })
  }

  async getLastKnownVersion(
    provider: string,
    repositoryId: number,
  ): Promise<string | null> {
    const [row] = await this.sql<{ version: string | null }[]>`
      SELECT version FROM connector_item
      WHERE provider = ${provider} AND repository_id = ${repositoryId} AND success = true
      ORDER BY executed_at DESC
      LIMIT 1
    `
    return row?.version ?? null
  }

  async listKnownVersions(
    provider: string,
    repositoryId: number,
  ): Promise<string[]> {
    const rows = await this.sql<{ version: string }[]>`
      SELECT version FROM connector_item
      WHERE provider = ${provider} AND repository_id = ${repositoryId}
        AND version IS NOT NULL
    `
    return rows.map((r) => r.version)
  }

  async listSourcesForProvider(provider: string): Promise<Source[]> {
    const rows = await this.sql<Source[]>`
      SELECT id, url, type, config, created_at FROM repository
      WHERE type = ${provider}
      ORDER BY id
    `
    // Normalized (configShape.ts), not just repaired (repairConfig, which only
    // handles double serialization): a connector must never receive a `config`
    // that is not an object, or it would call `config.get(...)` on it without
    // thinking.
    return rows.map((r) => ({ ...r, config: normalizeConfigObject(r.config) }))
  }

  async mergeSourceConfig(
    id: number,
    partial: Record<string, unknown>,
  ): Promise<void> {
    // Read-normalized-merged-rewritten rather than a `config || $1`: some
    // production rows have a corrupted `config` (array, string — see
    // configShape.ts), on which `||` would compound the corruption instead of
    // merging. This path repairs the row along the way.
    const [row] = await this.sql<{ config: unknown }[]>`
      SELECT config FROM repository WHERE id = ${id}
    `
    if (!row) return
    const merged = { ...normalizeConfigObject(row.config), ...partial }
    await this.sql`
      UPDATE repository
      SET config = ${this.sql.json(merged as postgres.JSONValue) as never}
      WHERE id = ${id}
    `
  }

  /** `log` has no `provider` column: it is derived from `repository_id` (via
   *  `repository.type`) everywhere else. The parameter is kept for symmetry with
   *  the route-side call, where an error can occur with no identified source. */
  async logConnectorError(
    _provider: string,
    repositoryId: number | null,
    error: string,
    executedAt: string,
  ): Promise<void> {
    await this.sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS log (
           id SERIAL PRIMARY KEY, repository_id INTEGER,
           error TEXT NOT NULL, executed_at TIMESTAMPTZ NOT NULL)`,
      )
      .catch(() => {})
    await this.sql`
      INSERT INTO log (repository_id, error, executed_at)
      VALUES (${repositoryId}, ${error}, ${executedAt})
    `
  }

  async listErrorLogs(limit: number): Promise<ErrorLogRow[]> {
    try {
      return await this.sql<ErrorLogRow[]>`
        SELECT l.id, l.repository_id, r.url, r.type AS provider, l.error, l.executed_at
        FROM log l
        LEFT JOIN repository r ON r.id = l.repository_id
        ORDER BY l.executed_at DESC, l.id DESC
        LIMIT ${limit}
      `
    } catch (err) {
      // The table is created by the first failure a connector reports: none yet.
      if ((err as { code?: string }).code === '42P01') return []
      throw err
    }
  }

  async clearErrorLogs(): Promise<number> {
    try {
      const res = await this.sql`DELETE FROM log`
      return res.count
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') return 0
      throw err
    }
  }

  async deleteOldContent(
    provider: string,
    repositoryId: number,
    retentionDays: number,
  ): Promise<void> {
    await this.sql`
      DELETE FROM connector_item
      WHERE provider = ${provider} AND repository_id = ${repositoryId}
        AND executed_at < NOW() - ${retentionDays} * INTERVAL '1 day'
        AND NOT EXISTS (
          SELECT 1 FROM item_state s
          WHERE s.item_id = connector_item.id AND s.saved_at IS NOT NULL
        )
    `
  }

  // ── Maintenance: content retention ───────────────────────────────────────

  private async ensureAppSettingTable(): Promise<void> {
    await this.sql
      .unsafe(
        'CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      )
      .catch(() => {})
  }

  async getContentRetentionDefault(): Promise<number | null> {
    const rows = await this.sql<{ value: string }[]>`
      SELECT value FROM app_setting WHERE key = 'content_retention_days'
    `.catch(() => [] as { value: string }[])
    if (rows.length === 0) return 30 // built-in default
    const n = Number(rows[0].value)
    return Number.isFinite(n) && n > 0 ? n : null // '', 'off', 0… → no purge
  }

  async setContentRetentionDefault(days: number | null): Promise<void> {
    await this.ensureAppSettingTable()
    await this.sql`
      INSERT INTO app_setting (key, value)
      VALUES ('content_retention_days', ${days === null ? 'off' : String(days)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `
  }

  async setProviderRetention(name: string, days: number | null): Promise<void> {
    await this.sql
      .unsafe(
        'ALTER TABLE provider_registry ADD COLUMN IF NOT EXISTS retention_days INTEGER',
      )
      .catch(() => {})
    await this.sql`
      UPDATE provider_registry SET retention_days = ${days} WHERE name = ${name}
    `
  }

  async purgeExpiredContent(): Promise<
    { provider: string; deleted: number }[]
  > {
    const globalDefault = await this.getContentRetentionDefault()
    const names = await this.listProviderNames()
    if (names.length === 0) return []

    const overrides = new Map(
      (await this.readRegistry(names)).map((r) => [r.name, r.retention_days]),
    )

    const report: { provider: string; deleted: number }[] = []
    for (const provider of names) {
      const override = overrides.get(provider)
      const days = override != null ? override : globalDefault
      if (days == null || days <= 0) continue

      const res = await this.sql`
        DELETE FROM connector_item
        WHERE provider = ${provider}
          AND executed_at < NOW() - ${days} * INTERVAL '1 day'
          AND NOT EXISTS (
            SELECT 1 FROM item_state s
            WHERE s.item_id = connector_item.id AND s.saved_at IS NOT NULL
          )
      `
      report.push({ provider, deleted: res.count })
    }
    return report
  }

  async registerProvider(entry: ProviderRegistration): Promise<void> {
    await this.ensureProviderRegistryTable()
    await this.sql`
      INSERT INTO provider_registry (name, display_name, sort_order)
      VALUES (${entry.name}, ${entry.displayName}, ${entry.sortOrder ?? 100})
      ON CONFLICT (name) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        updated_at = NOW()
    `
  }

  // ── Connector API keys ─────────────────────────────────────────────────────

  private async ensureConnectorKeyTable(): Promise<void> {
    await this.sql
      .unsafe(
        `CREATE TABLE IF NOT EXISTS connector_key (
           id TEXT PRIMARY KEY, provider TEXT NOT NULL, name TEXT NOT NULL,
           key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ)`,
      )
      .catch(() => {})
  }

  async createConnectorKey(input: NewConnectorKey): Promise<{ id: string }> {
    await this.ensureConnectorKeyTable()
    const id = crypto.randomUUID()
    await this.sql`
      INSERT INTO connector_key (id, provider, name, key_hash, key_prefix)
      VALUES (${id}, ${input.provider}, ${input.name}, ${input.keyHash}, ${input.keyPrefix})
    `
    return { id }
  }

  async listConnectorKeys(): Promise<ConnectorKeyRow[]> {
    await this.ensureConnectorKeyTable()
    return this.sql<ConnectorKeyRow[]>`
      SELECT id, provider, name, key_prefix, created_at, last_used_at, revoked_at
      FROM connector_key
      ORDER BY created_at DESC
    `
  }

  async revokeConnectorKey(id: string): Promise<boolean> {
    await this.ensureConnectorKeyTable()
    const rows = await this.sql<{ id: string }[]>`
      UPDATE connector_key SET revoked_at = NOW()
      WHERE id = ${id} AND revoked_at IS NULL
      RETURNING id
    `
    return rows.length > 0
  }

  async findConnectorKeyByHash(
    keyHash: string,
  ): Promise<{ id: string; provider: string } | null> {
    await this.ensureConnectorKeyTable()
    const [row] = await this.sql<{ id: string; provider: string }[]>`
      SELECT id, provider FROM connector_key
      WHERE key_hash = ${keyHash} AND revoked_at IS NULL
    `
    return row ?? null
  }

  async touchConnectorKeyUsage(id: string): Promise<void> {
    await this.sql`
      UPDATE connector_key SET last_used_at = NOW() WHERE id = ${id}
    `.catch(() => {})
  }

  // ── Sources ───────────────────────────────────────────────────────────────

  async findSourceByUrl(url: string): Promise<Source | null> {
    const [row] = await this.sql<Source[]>`
      SELECT id, url, type, config FROM repository WHERE url = ${url}
    `
    return row ? repairConfig(row) : null
  }

  async getSource(id: number): Promise<Source | null> {
    const [row] = await this.sql<Source[]>`
      SELECT id, url, type, config FROM repository WHERE id = ${id}
    `
    return row ? repairConfig(row) : null
  }

  async createSource(input: {
    url: string
    type: string
    config: Record<string, unknown>
  }): Promise<Source> {
    const [row] = await this.sql<Source[]>`
      INSERT INTO repository (url, type, config)
      VALUES (${input.url}, ${input.type}, ${this.sql.json((input.config ?? {}) as postgres.JSONValue) as never})
      ON CONFLICT (url) DO UPDATE SET url = EXCLUDED.url
      RETURNING id, url, type, config
    `
    return repairConfig(row)
  }

  async updateSourceConfig(
    id: number,
    config: Record<string, unknown>,
  ): Promise<void> {
    await this.sql`
      UPDATE repository SET config = ${this.sql.json((config ?? {}) as postgres.JSONValue) as never} WHERE id = ${id}
    `
  }

  async updateSourceUrl(id: number, url: string): Promise<void> {
    // Native Postgres uniqueness violation: already '23505', no need to
    // re-synthesize it like on the other engines.
    await this.sql`UPDATE repository SET url = ${url} WHERE id = ${id}`
  }

  async deleteSource(id: number): Promise<void> {
    await this.sql`DELETE FROM repository WHERE id = ${id}`
  }

  async listSourcesWithSubscriberCount(): Promise<
    (Source & { subscriber_count: string } & SourceHealth)[]
  > {
    type Row = Source & { subscriber_count: string } & SourceHealth
    try {
      const rows = await this.sql<Row[]>`
        WITH last_item AS (
          SELECT repository_id, MAX(executed_at) AS at
          FROM connector_item WHERE success GROUP BY repository_id
        ),
        last_err AS (
          SELECT DISTINCT ON (repository_id) repository_id, error, executed_at
          FROM log WHERE repository_id IS NOT NULL
          ORDER BY repository_id, executed_at DESC, id DESC
        )
        SELECT r.id, r.url, r.type, r.config,
          COUNT(ur.id)::text AS subscriber_count,
          li.at AS last_item_at,
          le.error AS last_error,
          le.executed_at AS last_error_at,
          (
            SELECT COUNT(*)::int FROM log l
            WHERE l.repository_id = r.id
              AND (li.at IS NULL OR l.executed_at > li.at)
          ) AS failures_since_item
        FROM repository r
        LEFT JOIN user_repository ur ON ur.repository_id = r.id
        LEFT JOIN last_item li ON li.repository_id = r.id
        LEFT JOIN last_err le ON le.repository_id = r.id
        GROUP BY r.id, li.at, le.error, le.executed_at
        ORDER BY r.id
      `
      return rows.map(repairConfig)
    } catch (err) {
      // No failure has been logged on this database yet: no `log` table.
      if ((err as { code?: string }).code !== '42P01') throw err
      const rows = await this.sql<(Source & { subscriber_count: string })[]>`
        SELECT r.id, r.url, r.type, r.config,
          COUNT(ur.id)::text AS subscriber_count
        FROM repository r
        LEFT JOIN user_repository ur ON ur.repository_id = r.id
        GROUP BY r.id
        ORDER BY r.id
      `
      return rows.map((r) =>
        repairConfig({
          ...r,
          last_item_at: null,
          failures_since_item: 0,
          last_error: null,
          last_error_at: null,
        }),
      )
    }
  }

  async listSourcesOfType(
    type: string,
    userId: string,
  ): Promise<(Source & { is_subscribed: boolean })[]> {
    const rows = await this.sql<(Source & { is_subscribed: boolean })[]>`
      SELECT
        r.id, r.url, r.type, r.config, r.created_at,
        EXISTS (
          SELECT 1 FROM user_repository ur
          WHERE ur.repository_id = r.id AND ur.user_id = ${userId}
        ) AS is_subscribed
      FROM repository r
      WHERE r.type = ${type}
      ORDER BY r.id
    `
    return rows.map(repairConfig)
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  async listSubscriptions(userId: string): Promise<SubscriptionRow[]> {
    const rows = await this.sql<SubscriptionRow[]>`
      SELECT ur.id, ur.repository_id, ur.created_at, ur.folder, r.url, r.type AS provider, r.config
      FROM user_repository ur
      JOIN repository r ON r.id = ur.repository_id
      WHERE ur.user_id = ${userId}
      ORDER BY ur.created_at
    `
    return rows.map(repairConfig)
  }

  async listSubscribedSourceIds(
    userId: string,
    type: string,
  ): Promise<number[]> {
    const rows = await this.sql<{ repository_id: number }[]>`
      SELECT ur.repository_id
      FROM user_repository ur
      JOIN repository r ON r.id = ur.repository_id
      WHERE ur.user_id = ${userId} AND r.type = ${type}
    `
    return rows.map((r) => r.repository_id)
  }

  async findSubscription(
    linkId: string,
    userId: string,
  ): Promise<{ repository_id: number; type: string } | null> {
    const [row] = await this.sql<{ repository_id: number; type: string }[]>`
      SELECT ur.repository_id, r.type
      FROM user_repository ur
      JOIN repository r ON r.id = ur.repository_id
      WHERE ur.id = ${linkId} AND ur.user_id = ${userId}
    `
    return row ?? null
  }

  async subscribe(
    userId: string,
    sourceId: number,
  ): Promise<SubscriptionRow | null> {
    try {
      const [row] = await this.sql<SubscriptionRow[]>`
        INSERT INTO user_repository (id, user_id, repository_id)
        VALUES (${crypto.randomUUID()}, ${userId}, ${sourceId})
        RETURNING id, repository_id, created_at
      `
      return row
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null
      throw err
    }
  }

  async unsubscribeById(linkId: string): Promise<void> {
    await this.sql`DELETE FROM user_repository WHERE id = ${linkId}`
  }

  async unsubscribe(userId: string, sourceId: number): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM user_repository
      WHERE user_id = ${userId} AND repository_id = ${sourceId}
      RETURNING id
    `
    return rows.length > 0
  }

  async deleteSubscriptionsForSource(sourceId: number): Promise<void> {
    await this
      .sql`DELETE FROM user_repository WHERE repository_id = ${sourceId}`
  }

  async countSubscribers(sourceId: number): Promise<number> {
    const [row] = await this.sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM user_repository WHERE repository_id = ${sourceId}
    `
    return Number.parseInt(row.count, 10)
  }

  async listSourceSubscribers(
    sourceId: number,
  ): Promise<SourceSubscriberRow[]> {
    return this.sql<SourceSubscriberRow[]>`
      SELECT u.id, u.name, u.email, ur.created_at AS subscribed_at
      FROM user_repository ur
      JOIN "user" u ON u.id = ur.user_id
      WHERE ur.repository_id = ${sourceId}
      ORDER BY ur.created_at, u.email
    `
  }

  async setSubscriptionFolder(
    linkId: string,
    userId: string,
    folder: string | null,
  ): Promise<boolean> {
    const res = await this.sql`
      UPDATE user_repository SET folder = ${folder}
      WHERE id = ${linkId} AND user_id = ${userId}
    `
    return res.count > 0
  }

  // ── Per-user item state ───────────────────────────────────────────────────

  async getItemState(userId: string): Promise<ItemStateKeys> {
    const rows = await this.sql<
      { item_id: number; provider: string; read: boolean; saved: boolean }[]
    >`
      SELECT s.item_id, ci.provider,
        s.read_at IS NOT NULL AS read, s.saved_at IS NOT NULL AS saved
      FROM item_state s
      JOIN connector_item ci ON ci.id = s.item_id
      WHERE s.user_id = ${userId}
    `
    const key = (r: { provider: string; item_id: number }) =>
      `${r.provider}:${r.item_id}`
    return {
      read: rows.filter((r) => r.read).map(key),
      saved: rows.filter((r) => r.saved).map(key),
    }
  }

  async setItemsRead(
    userId: string,
    itemIds: number[],
    read: boolean,
  ): Promise<void> {
    if (itemIds.length === 0) return
    if (read) {
      await this.sql`
        INSERT INTO item_state (user_id, item_id, read_at)
        SELECT ${userId}, id, NOW() FROM connector_item WHERE id = ANY(${itemIds})
        ON CONFLICT (user_id, item_id)
        DO UPDATE SET read_at = COALESCE(item_state.read_at, NOW())
      `
    } else {
      await this.sql`
        UPDATE item_state SET read_at = NULL
        WHERE user_id = ${userId} AND item_id = ANY(${itemIds})
      `
    }
  }

  async setItemSaved(
    userId: string,
    itemId: number,
    saved: boolean,
  ): Promise<void> {
    if (saved) {
      await this.sql`
        INSERT INTO item_state (user_id, item_id, saved_at)
        SELECT ${userId}, id, NOW() FROM connector_item WHERE id = ${itemId}
        ON CONFLICT (user_id, item_id)
        DO UPDATE SET saved_at = COALESCE(item_state.saved_at, NOW())
      `
    } else {
      await this.sql`
        UPDATE item_state SET saved_at = NULL
        WHERE user_id = ${userId} AND item_id = ${itemId}
      `
    }
  }

  async listSavedItems(userId: string): Promise<ContentRow[]> {
    return this.sql<ContentRow[]>`
      SELECT ci.*
      FROM item_state s
      JOIN connector_item ci ON ci.id = s.item_id
      WHERE s.user_id = ${userId} AND s.saved_at IS NOT NULL
      ORDER BY s.saved_at DESC
    `
  }

  async searchItems(
    userId: string,
    query: string,
    limit: number,
  ): Promise<ContentRow[]> {
    // `\`, `%` and `_` are LIKE wildcards: searched literally.
    const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`
    return this.sql<ContentRow[]>`
      SELECT ci.*
      FROM connector_item ci
      JOIN user_repository ur
        ON ur.repository_id = ci.repository_id AND ur.user_id = ${userId}
      WHERE ci.content ILIKE ${pattern}
      ORDER BY ci.executed_at DESC
      LIMIT ${limit}
    `
  }

  async countUnread(userId: string): Promise<number> {
    const [row] = await this.sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM (
        SELECT ci.id,
          ROW_NUMBER() OVER (
            PARTITION BY ci.repository_id ORDER BY ci.executed_at DESC
          ) AS rn
        FROM connector_item ci
        JOIN user_repository ur
          ON ur.repository_id = ci.repository_id AND ur.user_id = ${userId}
      ) ranked
      WHERE rn <= 10 AND NOT EXISTS (
        SELECT 1 FROM item_state s
        WHERE s.user_id = ${userId} AND s.item_id = ranked.id
          AND s.read_at IS NOT NULL
      )
    `
    return row?.count ?? 0
  }

  // ── Push notifications ───────────────────────────────────────────────────

  async savePushToken(
    userId: string,
    token: string,
    lang: string,
  ): Promise<void> {
    await this.sql`
      INSERT INTO push_token (token, user_id, lang)
      VALUES (${token}, ${userId}, ${lang})
      ON CONFLICT (token) DO UPDATE SET user_id = ${userId}, lang = ${lang}
    `
  }

  async deletePushToken(userId: string, token: string): Promise<boolean> {
    const res = await this.sql`
      DELETE FROM push_token WHERE token = ${token} AND user_id = ${userId}
    `
    return res.count > 0
  }

  async removePushTokens(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return
    await this.sql`DELETE FROM push_token WHERE token = ANY(${tokens})`
  }

  async listPushTargets(sourceIds: number[]): Promise<PushTarget[]> {
    if (sourceIds.length === 0) return []
    return this.sql<PushTarget[]>`
      SELECT p.token, p.user_id, p.lang, ur.repository_id
      FROM push_token p
      JOIN user_repository ur ON ur.user_id = p.user_id
      WHERE ur.repository_id = ANY(${sourceIds})
    `
  }

  // ── Users and accounts ───────────────────────────────────────────────────

  async createCredentialUser(user: NewUser): Promise<{ id: string } | null> {
    const userId = crypto.randomUUID()
    const accountId = crypto.randomUUID()
    const now = new Date().toISOString()

    try {
      // Both inserts must succeed or fail together: otherwise a failure on
      // `account` leaves an orphan user whose e-mail stays taken.
      await this.sql.begin(async (transaction) => {
        // `TransactionSql` is declared as Omit<Sql, …>: it loses the SQL tag's
        // call signature, hence this retyping.
        const tx = transaction as unknown as postgres.Sql
        await tx`
          INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
          VALUES (${userId}, ${user.name}, ${user.email}, ${now}, ${now}, false)
        `
        await tx`
          INSERT INTO account (id, user_id, provider_id, account_id, password, created_at, updated_at)
          VALUES (${accountId}, ${userId}, 'credential', ${user.email}, ${user.passwordHash}, ${now}, ${now})
        `
      })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null
      throw err
    }
    return { id: userId }
  }

  async findCredentialByEmail(email: string) {
    const [row] = await this.sql<
      { id: string; name: string; email: string; password: string }[]
    >`
      SELECT u.id, u.name, u.email, a.password
      FROM "user" u
      JOIN account a ON a.user_id = u.id
      WHERE LOWER(u.email) = ${email} AND a.provider_id = 'credential'
      LIMIT 1
    `
    return row ?? null
  }

  async getCredentialHash(userId: string): Promise<string | null> {
    const [row] = await this.sql<{ password: string | null }[]>`
      SELECT password FROM account
      WHERE user_id = ${userId} AND provider_id = 'credential'
      LIMIT 1
    `
    return row?.password ?? null
  }

  async listUsers(): Promise<UserRow[]> {
    return this.sql<UserRow[]>`
      SELECT id, name, email, created_at FROM "user" ORDER BY created_at
    `
  }

  async getUser(userId: string): Promise<UserRow | null> {
    const [row] = await this.sql<UserRow[]>`
      SELECT id, name, email, created_at FROM "user" WHERE id = ${userId}
    `
    return row ?? null
  }

  async userExists(userId: string): Promise<boolean> {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM "user" WHERE id = ${userId}
    `
    return Boolean(row)
  }

  async updateUser(
    userId: string,
    patch: { name?: string; email?: string },
  ): Promise<void> {
    const name = patch.name ?? null
    const email = patch.email ?? null
    const now = new Date().toISOString()

    await this.sql`
      UPDATE "user"
      SET name = COALESCE(${name}, name),
          email = COALESCE(${email}, email),
          updated_at = ${now}
      WHERE id = ${userId}
    `
    // `account.account_id` carries the account's e-mail: leaving it behind would
    // make the two tables diverge on every address change.
    if (email !== null) {
      await this.sql`
        UPDATE account SET account_id = ${email}, updated_at = ${now}
        WHERE user_id = ${userId} AND provider_id = 'credential'
      `
    }
  }

  async updateCredentialPassword(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    await this.sql`
      UPDATE account SET password = ${passwordHash}, updated_at = ${new Date().toISOString()}
      WHERE user_id = ${userId} AND provider_id = 'credential'
    `
  }

  async deleteUser(userId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM "user" WHERE id = ${userId} RETURNING id
    `
    return rows.length > 0
  }

  async findOAuthAccount(provider: string, accountId: string) {
    const [row] = await this.sql<{ user_id: string }[]>`
      SELECT user_id FROM account
      WHERE provider_id = ${provider} AND account_id = ${accountId}
      LIMIT 1
    `
    return row ?? null
  }

  async findUserByEmail(email: string) {
    const [row] = await this.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM "user" WHERE LOWER(email) = ${email} LIMIT 1
    `
    return row ?? null
  }

  async createOAuthUser(user: {
    name: string
    email: string
    emailVerified: boolean
  }): Promise<{ id: string }> {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    await this.sql`
      INSERT INTO "user" (id, name, email, created_at, updated_at, email_verified)
      VALUES (${id}, ${user.name}, ${user.email}, ${now}, ${now}, ${user.emailVerified})
    `
    return { id }
  }

  async linkOAuthAccount(
    userId: string,
    provider: string,
    accountId: string,
  ): Promise<void> {
    const now = new Date().toISOString()
    await this.sql`
      INSERT INTO account (id, user_id, provider_id, account_id, created_at, updated_at)
      VALUES (${crypto.randomUUID()}, ${userId}, ${provider}, ${accountId}, ${now}, ${now})
    `
  }

  async getUserIdentity(userId: string) {
    const [row] = await this.sql<{ name: string; email: string }[]>`
      SELECT name, email FROM "user" WHERE id = ${userId}
    `
    return row ?? null
  }

  // ── Administrators ────────────────────────────────────────────────────────

  async findAdminByEmail(email: string) {
    const [row] = await this.sql<
      {
        id: string
        email: string
        name: string
        password_hash: string
        is_super: boolean
      }[]
    >`
      SELECT id, email, name, password_hash, is_super
      FROM admin WHERE LOWER(email) = ${email} LIMIT 1
    `
    return row ?? null
  }

  async getAdmin(id: string): Promise<AdminRow | null> {
    const [row] = await this.sql<AdminRow[]>`
      SELECT id, email, name, is_super, created_at FROM admin WHERE id = ${id}
    `
    return row ?? null
  }

  async listAdmins(): Promise<AdminRow[]> {
    return this.sql<AdminRow[]>`
      SELECT id, email, name, is_super, created_at FROM admin ORDER BY email
    `
  }

  async createAdmin(admin: NewAdmin): Promise<{ id: string } | null> {
    const id = crypto.randomUUID()
    try {
      await this.sql`
        INSERT INTO admin (id, email, name, password_hash, is_super)
        VALUES (${id}, ${admin.email}, ${admin.name}, ${admin.passwordHash}, ${admin.isSuper})
      `
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return null
      throw err
    }
    return { id }
  }

  async updateAdmin(
    id: string,
    patch: { name?: string; email?: string; passwordHash?: string },
  ): Promise<void> {
    const name = patch.name ?? null
    const email = patch.email ?? null
    const passwordHash = patch.passwordHash ?? null
    await this.sql`
      UPDATE admin
      SET name = COALESCE(${name}, name),
          email = COALESCE(${email}, email),
          password_hash = COALESCE(${passwordHash}, password_hash)
      WHERE id = ${id}
    `
  }

  async deleteAdmin(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM admin WHERE id = ${id} RETURNING id
    `
    return rows.length > 0
  }

  async countSuperAdmins(): Promise<number> {
    const [row] = await this.sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM admin WHERE is_super = true
    `
    return Number.parseInt(row.count, 10)
  }

  // ── Flux requests (approval queue) ───────────────────────────────────────

  async findPendingFluxRequest(userId: string, provider: string, url: string) {
    const [row] = await this.sql<{ id: string }[]>`
      SELECT id FROM flux_request
      WHERE user_id = ${userId} AND provider = ${provider}
        AND url = ${url} AND status = 'pending'
    `
    return row ?? null
  }

  async createFluxRequest(
    userId: string,
    provider: string,
    url: string,
  ): Promise<FluxRequestRow> {
    const [row] = await this.sql<FluxRequestRow[]>`
      INSERT INTO flux_request (id, user_id, provider, url)
      VALUES (${crypto.randomUUID()}, ${userId}, ${provider}, ${url})
      RETURNING id, user_id, provider, url, status, created_at
    `
    return row
  }

  async listFluxRequests(): Promise<FluxRequestRow[]> {
    return this.sql<FluxRequestRow[]>`
      SELECT fr.id, fr.user_id, u.email AS user_email, fr.provider, fr.url, fr.status, fr.created_at
      FROM flux_request fr
      JOIN "user" u ON u.id = fr.user_id
      ORDER BY fr.created_at DESC
    `
  }

  async getFluxRequest(id: string) {
    const [row] = await this.sql<
      {
        id: string
        user_id: string
        provider: string
        url: string
        status: string
      }[]
    >`
      SELECT id, user_id, provider, url, status FROM flux_request WHERE id = ${id}
    `
    return row ?? null
  }

  async setFluxRequestStatus(id: string, status: string): Promise<void> {
    await this.sql`UPDATE flux_request SET status = ${status} WHERE id = ${id}`
  }
}
