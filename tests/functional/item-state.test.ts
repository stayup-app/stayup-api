import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sign } from 'hono/jwt'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { closeSql, getSql, trackOpenConnections } from '../../src/db/client.js'
import { PostgresStore } from '../../src/db/postgres.js'
import type { Bindings } from '../../src/types.js'
import { authHeaders, json } from '../helpers.js'

trackOpenConnections(true)

const __dirname = dirname(fileURLToPath(import.meta.url))

const ENV: Bindings = {
  DATABASE_URL:
    process.env.DATABASE_URL ??
    `postgres://${process.env.DB_USER ?? 'postgres'}:${process.env.DB_PASSWORD ?? 'postgres'}@${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? '5432'}/${process.env.DB_NAME ?? 'stayup_test'}`,
  JWT_SECRET: 'test-secret',
  UI_URL: 'http://localhost:3001',
  GOOGLE_CLIENT_ID: '',
  GOOGLE_CLIENT_SECRET: '',
  GITHUB_CLIENT_ID: '',
  GITHUB_CLIENT_SECRET: '',
}

const sql = getSql(ENV.DATABASE_URL)
const store = new PostgresStore(sql)

const USER = 'func-state-user'
const URL_A = 'https://func-state.example/a'
const URL_B = 'https://func-state.example/b'
let repoA: number
let repoB: number
const ids: number[] = []
let headers: Record<string, string>

async function addItem(repo: number, content: string, ageDays: number) {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO connector_item (provider, repository_id, content, executed_at, success)
    VALUES ('rss', ${repo}, ${content}, NOW() - ${ageDays} * INTERVAL '1 day', true)
    RETURNING id
  `
  ids.push(row.id)
  return row.id
}

async function cleanup() {
  await sql`DELETE FROM push_token WHERE user_id = ${USER}`
  await sql`DELETE FROM "user" WHERE id = ${USER}`
  await sql`DELETE FROM log WHERE error LIKE 'func-state%'`
  await sql`DELETE FROM connector_item WHERE content LIKE 'func-state%'`
  await sql`DELETE FROM repository WHERE url IN (${URL_A}, ${URL_B})`
}

beforeAll(async () => {
  await sql.unsafe(
    readFileSync(join(__dirname, '../../src/db/schema.sql'), 'utf-8'),
  )
  await cleanup()
  await sql`
    INSERT INTO "user" (id, name, email) VALUES (${USER}, 'State', 'func-state@example.com')
  `
  repoA = (
    await store.createSource({
      url: URL_A,
      type: 'rss',
      config: { title: 'A' },
    })
  ).id
  repoB = (await store.createSource({ url: URL_B, type: 'rss', config: {} })).id
  await store.subscribe(USER, repoA)
  headers = {
    Authorization: `Bearer ${await sign(
      { sub: USER, role: 'user', exp: Math.floor(Date.now() / 1000) + 3600 },
      ENV.JWT_SECRET,
      'HS256',
    )}`,
    'Content-Type': 'application/json',
  }
})

afterAll(async () => {
  await cleanup()
  await closeSql()
})

function req(path: string, method = 'GET', body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    ENV,
  )
}

describe('read / saved state', () => {
  it('counts unread, then syncs read state through the API', async () => {
    await addItem(repoA, 'func-state first item', 1)
    await addItem(repoA, 'func-state second item', 2)
    // not subscribed: must not count nor be searchable
    await addItem(repoB, 'func-state foreign item', 1)

    expect(await store.countUnread(USER)).toBe(2)

    const res = await req(`/ui/users/${USER}/items/read`, 'POST', {
      ids: [ids[0], 999999],
    })
    expect(res.status).toBe(200)

    const state = await json(await req(`/ui/users/${USER}/state`))
    expect(state.read).toEqual([`rss:${ids[0]}`])
    expect(await store.countUnread(USER)).toBe(1)

    await req(`/ui/users/${USER}/items/read`, 'POST', {
      ids: [ids[0]],
      read: false,
    })
    expect((await json(await req(`/ui/users/${USER}/state`))).read).toEqual([])
  })

  it('saves an item, lists it, and shields it from the retention purge', async () => {
    const old = await addItem(repoA, 'func-state ancient saved item', 400)
    const doomed = await addItem(repoA, 'func-state ancient doomed item', 400)

    const res = await req(`/ui/users/${USER}/items/${old}/saved`, 'PUT', {
      saved: true,
    })
    expect(res.status).toBe(200)
    expect((await json(await req(`/ui/users/${USER}/state`))).saved).toEqual([
      `rss:${old}`,
    ])

    const saved = (await json(await req(`/ui/users/${USER}/saved`))).items
    expect(saved.map((i: { id: number }) => i.id)).toEqual([old])

    await store.setContentRetentionDefault(30)
    await store.purgeExpiredContent()
    const left = await sql<
      { id: number }[]
    >`SELECT id FROM connector_item WHERE id = ANY(${[old, doomed]})`
    expect(left.map((r) => r.id)).toEqual([old])

    await req(`/ui/users/${USER}/items/${old}/saved`, 'PUT', { saved: false })
    expect((await json(await req(`/ui/users/${USER}/state`))).saved).toEqual([])
  })

  it('cascades the state away when the item is deleted', async () => {
    await store.setItemsRead(USER, [ids[1]], true)
    await sql`DELETE FROM connector_item WHERE id = ${ids[1]}`
    expect((await store.getItemState(USER)).read).toEqual([])
  })
})

describe('search', () => {
  it('finds only items of subscribed flux, literally', async () => {
    await addItem(repoA, 'func-state 100%_literal needle', 0)
    await addItem(repoA, 'func-state 100xxliteral needle', 0)

    const found = (
      await json(
        await req(
          `/ui/users/${USER}/search?q=${encodeURIComponent('100%_literal')}`,
        ),
      )
    ).items
    expect(found).toHaveLength(1)

    const foreign = (
      await json(await req(`/ui/users/${USER}/search?q=foreign`))
    ).items
    expect(foreign).toHaveLength(0)
  })
})

describe('folders', () => {
  it('sets and clears a subscription folder', async () => {
    const [sub] = await store.listSubscriptions(USER)
    const res = await req(`/ui/users/${USER}/repositories/${sub.id}`, 'PATCH', {
      folder: 'AI',
    })
    expect(res.status).toBe(200)
    expect((await store.listSubscriptions(USER))[0].folder).toBe('AI')

    await req(`/ui/users/${USER}/repositories/${sub.id}`, 'PATCH', {
      folder: '  ',
    })
    expect((await store.listSubscriptions(USER))[0].folder).toBeNull()
  })
})

describe('push tokens', () => {
  it('registers, targets subscribers only, then unregisters', async () => {
    await req(`/ui/users/${USER}/push-tokens`, 'PUT', {
      token: 'func-state-token',
      lang: 'fr',
    })
    // re-registering is idempotent
    await req(`/ui/users/${USER}/push-tokens`, 'PUT', {
      token: 'func-state-token',
      lang: 'de',
    })

    const targets = await store.listPushTargets([repoA, repoB])
    expect(targets).toEqual([
      {
        token: 'func-state-token',
        user_id: USER,
        lang: 'de',
        repository_id: repoA,
      },
    ])

    await req(`/ui/users/${USER}/push-tokens`, 'DELETE', {
      token: 'func-state-token',
    })
    expect(await store.listPushTargets([repoA])).toEqual([])
  })
})

describe('source health', () => {
  it('reports last item and failures since it', async () => {
    await sql`INSERT INTO log (repository_id, error, executed_at) VALUES (${repoA}, 'func-state old failure', NOW() - INTERVAL '10 days')`
    await sql`INSERT INTO log (repository_id, error, executed_at) VALUES (${repoA}, 'func-state recent failure', NOW() + INTERVAL '1 minute')`

    const res = await app.request(
      '/ui/repositories',
      { headers: await authHeaders('admin') },
      ENV,
    )
    const repos = (await json(res)).repositories ?? (await json(res))
    const a = repos.find((r: { id: number }) => r.id === repoA)
    const b = repos.find((r: { id: number }) => r.id === repoB)
    expect(a.last_error).toBe('func-state recent failure')
    expect(a.failures_since_item).toBe(1)
    expect(a.last_item_at).not.toBeNull()
    expect(b.last_error).toBeNull()
    expect(b.failures_since_item).toBe(0)
  })
})
