import { compare, hash } from 'bcryptjs'
import { Hono } from 'hono'
import type { DataStore } from '../db/port.js'
import { listProviders } from '../db/providers.js'
import { getStore } from '../db/store.js'
import { normalizeEmail } from '../db/users.js'
import {
  authMiddleware,
  requireAdmin,
  requireSelfOrAdmin,
} from '../middleware/auth.js'
import type { Bindings } from '../types.js'

export const uiUsersRoute = new Hono<{ Bindings: Bindings }>()

uiUsersRoute.use('*', authMiddleware)

type UserRepo = {
  id: string
  repository_id: number
  created_at: string
  url: string
  provider: string
  config: Record<string, unknown>
}

async function getFeedForUser(
  store: DataStore,
  userId: string,
): Promise<{
  repositories: UserRepo[]
  connectors: Record<string, unknown[]>
}> {
  const [repositories, providers] = await Promise.all([
    store.listSubscriptions(userId),
    listProviders(store),
  ])

  const connectors: Record<string, unknown[]> = Object.fromEntries(
    providers.map((p) => [p.name, [] as unknown[]]),
  )
  const ids = repositories.map((r) => r.repository_id)
  if (ids.length > 0) {
    await Promise.all(
      providers.map(async (p) => {
        connectors[p.name] = await store.latestForSources(p.name, ids, 10)
      }),
    )
  }

  return { repositories, connectors }
}

// ─── Admin-only: user management ────────────────────────────────────────────

// GET /ui/users — list all users
uiUsersRoute.get('/', requireAdmin, async (c) => {
  const users = await (await getStore(c.env.DATABASE_URL)).listUsers()
  return c.json({ users })
})

// POST /ui/users — create a user
uiUsersRoute.post('/', requireAdmin, async (c) => {
  const body = await c.req.json<{
    name: string
    email: string
    password: string
  }>()

  if (!body.name || !body.email || !body.password) {
    return c.json({ error: 'name, email and password are required' }, 400)
  }

  const store = await getStore(c.env.DATABASE_URL)
  const created = await store.createCredentialUser({
    name: body.name,
    email: normalizeEmail(body.email),
    passwordHash: await hash(body.password, 10),
  })

  if (!created) {
    return c.json({ error: 'Email already in use' }, 409)
  }

  return c.json(
    { user: { id: created.id, name: body.name, email: body.email } },
    201,
  )
})

// GET /ui/users/:userId — get user profile (self or admin)
uiUsersRoute.get('/:userId', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const user = await (await getStore(c.env.DATABASE_URL)).getUser(userId)

  if (!user) return c.json({ error: 'User not found' }, 404)

  return c.json({ user })
})

// PATCH /ui/users/:userId — update a user (self or admin)
uiUsersRoute.patch('/:userId', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const body = await c.req.json<{
    name?: string
    email?: string
    password?: string
    currentPassword?: string
  }>()

  const store = await getStore(c.env.DATABASE_URL)
  const isAdmin = (c.get('jwtPayload') as { role?: string })?.role === 'admin'

  // Upfront check: a body containing only `password` must 404 too
  if (!(await store.userExists(userId))) {
    return c.json({ error: 'User not found' }, 404)
  }

  // Changing your own password requires knowing the current one: otherwise a
  // stolen token is enough to lock the owner out of their account. An admin
  // keeps proof-free reset — that is the point of the role.
  if (body.password && !isAdmin) {
    if (!body.currentPassword) {
      return c.json({ error: 'currentPassword is required' }, 400)
    }
    const currentHash = await store.getCredentialHash(userId)
    if (!currentHash) {
      return c.json({ error: 'No password set for this account' }, 409)
    }
    if (!(await compare(body.currentPassword, currentHash))) {
      return c.json({ error: 'Invalid credentials' }, 401)
    }
  }

  if (body.name !== undefined || body.email !== undefined) {
    const name: string | null = body.name ?? null
    const email: string | null =
      body.email === undefined ? null : normalizeEmail(body.email)
    try {
      // The adapter keeps `account.account_id` aligned with the new address.
      await store.updateUser(userId, {
        name: name ?? undefined,
        email: email ?? undefined,
      })
    } catch (err) {
      // Without this, an already-taken e-mail surfaces as a 500 instead of a
      // readable conflict.
      if ((err as { code?: string }).code === '23505') {
        return c.json({ error: 'Email already in use' }, 409)
      }
      throw err
    }
  }

  if (body.password) {
    await store.updateCredentialPassword(userId, await hash(body.password, 10))
  }

  return c.json({ success: true })
})

// DELETE /ui/users/:userId — delete a user
uiUsersRoute.delete('/:userId', requireAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const deleted = await (await getStore(c.env.DATABASE_URL)).deleteUser(userId)

  if (!deleted) return c.json({ error: 'User not found' }, 404)

  return c.json({ success: true })
})

// ─── User (self or admin): feed & repositories ───────────────────────────────

// GET /ui/users/:userId/feed
uiUsersRoute.get('/:userId/feed', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const data = await getFeedForUser(await getStore(c.env.DATABASE_URL), userId)
  return c.json(data)
})

// GET /ui/users/:userId/feed/:connector
uiUsersRoute.get('/:userId/feed/:connector', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const connector = c.req.param('connector') as string
  const store = await getStore(c.env.DATABASE_URL)

  if (!(await store.providerExists(connector))) {
    return c.json({ error: 'Unknown connector' }, 404)
  }

  const repoIds = await store.listSubscribedSourceIds(userId, connector)
  const data = await store.latestForSources(connector, repoIds, 10)

  return c.json({ connector, data })
})

// POST /ui/users/:userId/repositories
uiUsersRoute.post('/:userId/repositories', requireSelfOrAdmin, async (c) => {
  const userId = c.req.param('userId') as string
  const body = await c.req.json<{
    provider: string
    url: string
    config: Record<string, unknown>
  }>()

  if (!body.provider || !body.url) {
    return c.json({ error: 'provider and url are required' }, 400)
  }

  const jwtPayload = c.get('jwtPayload') as { role?: string }
  const isAdmin = jwtPayload?.role === 'admin'

  const store = await getStore(c.env.DATABASE_URL)

  // `repository` is shared by every subscriber of the same URL. An ON CONFLICT
  // that overwrote `type`/`config` let any user convert someone else's
  // repository (a changelog became an rss, its subscribers lost their flux, and
  // the orphaned connector_* rows then broke its deletion). So we never touch an
  // existing row: we reuse it, or refuse if it belongs to another provider.
  const existing = await store.findSourceByUrl(body.url)

  if (existing && existing.type !== body.provider) {
    return c.json(
      { error: 'This URL is already registered under another provider' },
      409,
    )
  }

  // A brand-new flux for a provider in `manual` mode goes through the approval
  // queue — unless an admin is acting, or the flux already exists (already
  // checked: subscribing to it needs no approval).
  if (!existing && !isAdmin) {
    const [meta] = await store.readRegistry([body.provider])
    if (meta?.flux_approval === 'manual') {
      const pending = await store.findPendingFluxRequest(
        userId,
        body.provider,
        body.url,
      )
      if (pending) {
        return c.json(
          { error: 'A pending request already exists for this flux' },
          409,
        )
      }
      const request = await store.createFluxRequest(
        userId,
        body.provider,
        body.url,
      )
      return c.json({ status: 'pending', request }, 202)
    }
  }

  const repo =
    existing ??
    (await store.createSource({
      url: body.url,
      type: body.provider,
      config: body.config,
    }))

  const link = await store.subscribe(userId, repo.id)
  if (!link) return c.json({ error: 'Already subscribed' }, 409)

  return c.json(
    {
      repository: {
        ...link,
        provider: body.provider,
        url: body.url,
        config: body.config,
      },
    },
    201,
  )
})

// DELETE /ui/users/:userId/repositories/:linkId
uiUsersRoute.delete(
  '/:userId/repositories/:linkId',
  requireSelfOrAdmin,
  async (c) => {
    const userId = c.req.param('userId') as string
    const linkId = c.req.param('linkId') as string
    const store = await getStore(c.env.DATABASE_URL)

    const link = await store.findSubscription(linkId, userId)

    if (!link) return c.json({ error: 'Feed not found' }, 404)

    // Removing a flux from your list = unsubscribing, nothing more. The
    // `repository` source and its `connector_*` content (produced by the
    // collector) are never deleted here: purging as soon as a source has no
    // subscriber destroyed history on a transient state (remove then re-add) and
    // raced the collector still writing into it. Durable deletion of a source
    // stays reserved for the admin endpoints `DELETE /ui/repositories/:id` and
    // `/ui/repositories/:id/data`.
    await store.unsubscribeById(linkId)

    return c.json({ success: true })
  },
)
