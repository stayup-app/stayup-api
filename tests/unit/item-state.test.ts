import { sign } from 'hono/jwt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { PostgresStore } from '../../src/db/postgres.js'
import { newItemsMessage, notifyNewItems } from '../../src/push.js'
import { TEST_ENV, createSqlMock, json, mockSql } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))

async function selfHeaders(userId = '1') {
  const token = await sign(
    { sub: userId, role: 'user', exp: Math.floor(Date.now() / 1000) + 3600 },
    TEST_ENV.JWT_SECRET,
    'HS256',
  )
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

function call(
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  return app.request(
    path,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    TEST_ENV,
  )
}

beforeEach(() => vi.clearAllMocks())

describe('GET /ui/users/:id/state', () => {
  it('returns read and saved items as provider:id keys', async () => {
    mockSql([
      [
        { item_id: 1, provider: 'rss', read: true, saved: false },
        { item_id: 2, provider: 'youtube', read: true, saved: true },
        { item_id: 3, provider: 'rss', read: false, saved: true },
      ],
    ])
    const res = await call('/ui/users/1/state', 'GET', await selfHeaders())
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      read: ['rss:1', 'youtube:2'],
      saved: ['youtube:2', 'rss:3'],
    })
  })

  it("refuses another user's state", async () => {
    mockSql([])
    const res = await call('/ui/users/2/state', 'GET', await selfHeaders('1'))
    expect(res.status).toBe(403)
  })
})

describe('POST /ui/users/:id/items/read', () => {
  it('marks the items read', async () => {
    const sql = mockSql([[]])
    const res = await call(
      '/ui/users/1/items/read',
      'POST',
      await selfHeaders(),
      {
        ids: [1, 2],
      },
    )
    expect(res.status).toBe(200)
    expect(sql).toHaveBeenCalledTimes(1)
  })

  it('rejects ids that are not integers', async () => {
    const sql = mockSql([])
    const res = await call(
      '/ui/users/1/items/read',
      'POST',
      await selfHeaders(),
      {
        ids: ['1; DROP TABLE'],
      },
    )
    expect(res.status).toBe(400)
    expect(sql).not.toHaveBeenCalled()
  })

  it('does nothing for an empty list', async () => {
    const sql = mockSql([])
    const res = await call(
      '/ui/users/1/items/read',
      'POST',
      await selfHeaders(),
      {
        ids: [],
      },
    )
    expect(res.status).toBe(200)
    expect(sql).not.toHaveBeenCalled()
  })
})

describe('PUT /ui/users/:id/items/:itemId/saved', () => {
  it('saves an item', async () => {
    mockSql([[]])
    const res = await call(
      '/ui/users/1/items/5/saved',
      'PUT',
      await selfHeaders(),
      {
        saved: true,
      },
    )
    expect(res.status).toBe(200)
  })

  it('requires a boolean', async () => {
    mockSql([])
    const res = await call(
      '/ui/users/1/items/5/saved',
      'PUT',
      await selfHeaders(),
      {
        saved: 'yes',
      },
    )
    expect(res.status).toBe(400)
  })
})

describe('GET /ui/users/:id/saved and /search', () => {
  it('lists saved items', async () => {
    mockSql([[{ id: 5, provider: 'rss', content: '{}' }]])
    const res = await call('/ui/users/1/saved', 'GET', await selfHeaders())
    expect((await json(res)).items).toHaveLength(1)
  })

  it('searches with LIKE wildcards escaped', async () => {
    const sql = mockSql([[{ id: 7 }]])
    const res = await call(
      '/ui/users/1/search?q=100%25_x',
      'GET',
      await selfHeaders(),
    )
    expect(res.status).toBe(200)
    expect(sql.mock.calls[0]).toContain('%100\\%\\_x%')
  })

  it('refuses a query shorter than 2 characters', async () => {
    mockSql([])
    const res = await call('/ui/users/1/search?q=a', 'GET', await selfHeaders())
    expect(res.status).toBe(400)
  })
})

describe('folders', () => {
  it('sets a folder', async () => {
    mockSql([{ count: 1 }])
    const res = await call(
      '/ui/users/1/repositories/abc',
      'PATCH',
      await selfHeaders(),
      {
        folder: ' AI ',
      },
    )
    expect(res.status).toBe(200)
  })

  it('clears a folder with null', async () => {
    const sql = mockSql([{ count: 1 }])
    const res = await call(
      '/ui/users/1/repositories/abc',
      'PATCH',
      await selfHeaders(),
      {
        folder: null,
      },
    )
    expect(res.status).toBe(200)
    expect(sql.mock.calls[0]).toContain(null)
  })

  it('404s on a subscription the user does not have', async () => {
    mockSql([{ count: 0 }])
    const res = await call(
      '/ui/users/1/repositories/abc',
      'PATCH',
      await selfHeaders(),
      {
        folder: 'x',
      },
    )
    expect(res.status).toBe(404)
  })

  it('rejects a non-string folder', async () => {
    mockSql([])
    const res = await call(
      '/ui/users/1/repositories/abc',
      'PATCH',
      await selfHeaders(),
      {
        folder: 3,
      },
    )
    expect(res.status).toBe(400)
  })
})

describe('push tokens', () => {
  it('registers a token', async () => {
    const sql = mockSql([[]])
    const res = await call(
      '/ui/users/1/push-tokens',
      'PUT',
      await selfHeaders(),
      {
        token: 'ExponentPushToken[abc]',
        lang: 'fr',
      },
    )
    expect(res.status).toBe(200)
    expect(sql.mock.calls[0]).toContain('fr')
  })

  it('requires a token', async () => {
    mockSql([])
    const res = await call(
      '/ui/users/1/push-tokens',
      'PUT',
      await selfHeaders(),
      {},
    )
    expect(res.status).toBe(400)
  })

  it('unregisters a token', async () => {
    mockSql([{ count: 1 }])
    const res = await call(
      '/ui/users/1/push-tokens',
      'DELETE',
      await selfHeaders(),
      {
        token: 'ExponentPushToken[abc]',
      },
    )
    expect(res.status).toBe(200)
  })
})

describe('notifyNewItems', () => {
  function store(sql = createSqlMock()) {
    return { sql, store: new PostgresStore(sql as never) }
  }

  it('localizes the message', () => {
    expect(newItemsMessage('fr', 1)).toBe('1 nouvel élément')
    expect(newItemsMessage('fr', 3)).toBe('3 nouveaux éléments')
    expect(newItemsMessage('xx', 2)).toBe('2 new items')
  })

  it('sends one push per device with the unread badge, and drops dead tokens', async () => {
    const { sql, store: s } = store()
    sql
      .mockResolvedValueOnce([
        { token: 'T1', user_id: 'u1', lang: 'fr', repository_id: 4 },
        { token: 'T2', user_id: 'u1', lang: 'en', repository_id: 4 },
      ]) // listPushTargets
      .mockResolvedValueOnce([
        {
          id: 4,
          url: 'https://blog.example/feed',
          type: 'rss',
          config: { title: 'Blog' },
        },
      ]) // getSource
      .mockResolvedValueOnce([{ count: 9 }]) // countUnread
      .mockResolvedValueOnce([]) // removePushTokens
    const send = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { status: 'ok' },
          { status: 'error', details: { error: 'DeviceNotRegistered' } },
        ],
      }),
    })

    await notifyNewItems(
      s,
      [
        { repositoryId: 4, success: true },
        { repositoryId: 4, success: true },
        { repositoryId: 4, success: false },
      ],
      send as never,
    )

    const sent = JSON.parse(send.mock.calls[0][1].body)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({
      to: 'T1',
      title: 'Blog',
      body: '2 nouveaux éléments',
      badge: 9,
    })
    expect(sent[1].body).toBe('2 new items')
    // the last SQL call removes the token Expo rejected
    expect(sql.mock.calls.at(-1)?.slice(1)).toEqual([['T2']])
  })

  it('does not call Expo when nobody is subscribed with a device', async () => {
    const { sql, store: s } = store()
    sql.mockResolvedValueOnce([])
    const send = vi.fn()
    await notifyNewItems(s, [{ repositoryId: 4, success: true }], send as never)
    expect(send).not.toHaveBeenCalled()
  })
})
