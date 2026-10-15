import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import {
  TEST_ENV,
  authHeaders,
  createSqlMock,
  json,
  mockSql,
} from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))
import { getSql } from '../../src/db/client.js'

beforeEach(() => vi.clearAllMocks())

describe('POST /ui/maintenance/cleanup', () => {
  it('rejects an unknown token', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/maintenance/cleanup',
      { method: 'POST', headers: { Authorization: 'Bearer nope' } },
      TEST_ENV,
    )
    expect(res.status).toBe(401)
  })

  it('rejects a regular user', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/maintenance/cleanup',
      { method: 'POST', headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('runs the purge for the CLEANUP_SECRET bearer and reports per provider', async () => {
    mockSql([
      [{ value: '30' }], // getContentRetentionDefault
      [{ name: 'rss' }, { name: 'youtube' }], // registeredNames
      [], // namesWithContent
      [
        // readRegistry — youtube overrides retention, rss follows the default
        {
          name: 'rss',
          display_name: 'RSS',
          sort_order: 30,
          flux_approval: 'auto',
        },
        {
          name: 'youtube',
          display_name: 'YouTube',
          sort_order: 20,
          flux_approval: 'auto',
          retention_days: 7,
        },
      ],
      { count: 4 }, // DELETE for rss (30d default)
      { count: 1 }, // DELETE for youtube (7d override)
    ])

    const res = await app.request(
      '/ui/maintenance/cleanup',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_ENV.CLEANUP_SECRET}` },
      },
      TEST_ENV,
    )

    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.total).toBe(5)
    expect(body.purged).toEqual([
      { provider: 'rss', deleted: 4 },
      { provider: 'youtube', deleted: 1 },
    ])
  })

  it('purges nothing when the global default is off and no provider overrides it', async () => {
    mockSql([
      [{ value: 'off' }], // getContentRetentionDefault → null
      [{ name: 'rss' }], // registeredNames
      [], // namesWithContent
      [
        {
          name: 'rss',
          display_name: 'RSS',
          sort_order: 30,
          flux_approval: 'auto',
        },
      ],
    ])

    const res = await app.request(
      '/ui/maintenance/cleanup',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_ENV.CLEANUP_SECRET}` },
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).purged).toEqual([])
  })
})

describe('GET /ui/maintenance/retention', () => {
  it('is admin-only', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/maintenance/retention',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('returns the global default and each provider’s override', async () => {
    mockSql([
      [{ value: '45' }], // getContentRetentionDefault
      [{ name: 'rss' }], // listProviders → registeredNames
      [], // namesWithContent
      [
        {
          name: 'rss',
          display_name: 'RSS',
          sort_order: 30,
          flux_approval: 'auto',
          retention_days: 10,
        },
      ], // readRegistry
    ])

    const res = await app.request(
      '/ui/maintenance/retention',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.default).toBe(45)
    expect(body.providers).toEqual([
      { name: 'rss', displayName: 'RSS', retention_days: 10 },
    ])
  })
})

describe('PATCH /ui/maintenance/retention', () => {
  it('rejects a non-integer or zero default', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/maintenance/retention',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ default: 0 }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(400)
  })

  it('accepts null to disable the global default', async () => {
    mockSql([[], []]) // ensureAppSettingTable + INSERT
    const res = await app.request(
      '/ui/maintenance/retention',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ default: null }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
  })

  it('404s a per-provider override for an unknown provider', async () => {
    mockSql([[], []]) // providerExists: provider_registry empty, connector_item empty
    const res = await app.request(
      '/ui/maintenance/retention',
      {
        method: 'PATCH',
        headers: {
          ...(await authHeaders('admin')),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ providers: { ghost: 14 } }),
      },
      TEST_ENV,
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /ui/maintenance/logs', () => {
  const LOG = {
    id: 3,
    repository_id: 7,
    url: 'https://blog.dev/feed.xml',
    provider: 'rss',
    error: 'HTTP 500',
    executed_at: '2026-10-15T08:00:00Z',
  }

  it('rejects a regular user', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/maintenance/logs',
      { headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('lists the latest failures for an admin', async () => {
    mockSql([[LOG]])
    const res = await app.request(
      '/ui/maintenance/logs',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).logs).toEqual([LOG])
  })

  it.each([
    ['', 100],
    ['?limit=20', 20],
    ['?limit=9999', 500],
    ['?limit=0', 1],
    ['?limit=abc', 100],
  ])('clamps the limit (%s → %i)', async (query, expected) => {
    const sql = mockSql([[]])
    await app.request(
      `/ui/maintenance/logs${query}`,
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(sql.mock.calls[0]).toContain(expected)
  })

  it('returns an empty list while no failure was ever reported', async () => {
    const sql = createSqlMock()
    sql.mockRejectedValue(
      Object.assign(new Error('no such table'), { code: '42P01' }),
    )
    vi.mocked(getSql).mockReturnValue(sql as never)
    const res = await app.request(
      '/ui/maintenance/logs',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect((await json(res)).logs).toEqual([])
  })

  it('does not hide other database errors', async () => {
    const sql = createSqlMock()
    sql.mockRejectedValue(new Error('connection lost'))
    vi.mocked(getSql).mockReturnValue(sql as never)
    const res = await app.request(
      '/ui/maintenance/logs',
      { headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(500)
  })
})

describe('DELETE /ui/maintenance/logs', () => {
  it('rejects a regular user', async () => {
    mockSql([])
    const res = await app.request(
      '/ui/maintenance/logs',
      { method: 'DELETE', headers: await authHeaders('user') },
      TEST_ENV,
    )
    expect(res.status).toBe(403)
  })

  it('empties the log for an admin and reports how many rows went', async () => {
    mockSql([{ count: 12 }])
    const res = await app.request(
      '/ui/maintenance/logs',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ deleted: 12 })
  })

  it('reports 0 while no failure was ever reported', async () => {
    const sql = createSqlMock()
    sql.mockRejectedValue(
      Object.assign(new Error('no such table'), { code: '42P01' }),
    )
    vi.mocked(getSql).mockReturnValue(sql as never)
    const res = await app.request(
      '/ui/maintenance/logs',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(await json(res)).toEqual({ deleted: 0 })
  })

  it('does not hide other database errors', async () => {
    const sql = createSqlMock()
    sql.mockRejectedValue(new Error('connection lost'))
    vi.mocked(getSql).mockReturnValue(sql as never)
    const res = await app.request(
      '/ui/maintenance/logs',
      { method: 'DELETE', headers: await authHeaders('admin') },
      TEST_ENV,
    )
    expect(res.status).toBe(500)
  })
})
