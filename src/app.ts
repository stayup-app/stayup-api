import { apiReference } from '@scalar/hono-api-reference'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { openApiSpec } from './openapi.js'
import { adminConnectorKeysRoute } from './routes/adminConnectorKeys.js'
import { adminProvidersRoute } from './routes/adminProviders.js'
import { adminRepositoriesRoute } from './routes/adminRepositories.js'
import { adminsRoute } from './routes/admins.js'
import { authRoute } from './routes/auth.js'
import { connectorApiRoute } from './routes/connectorApi.js'
import { connectorsRoute } from './routes/connectors.js'
import { fluxRequestsAdminRoute } from './routes/fluxRequests.js'
import { maintenanceRoute } from './routes/maintenance.js'
import { oauthRoute } from './routes/oauth.js'
import { providerFluxesRoute } from './routes/providerFluxes.js'
import { uiUsersRoute } from './routes/uiUsers.js'
import type { Bindings } from './types.js'

const app = new Hono<{ Bindings: Bindings }>()

app.use(cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }))

app.route('/auth', authRoute)
app.route('/auth', oauthRoute)
app.get('/', (c) => c.json({ status: 'ok' }))

// YouTube refuses embeds (error 153) from webviews without an http(s) origin
// (tauri://localhost in production desktop builds): host the player here so it
// is loaded from a real https page.
app.get('/embed/youtube/:id', (c) => {
  const id = c.req.param('id')
  if (!/^[\w-]{4,20}$/.test(id)) return c.text('Invalid video id', 400)
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;background:#000}</style></head><body><iframe src="https://www.youtube-nocookie.com/embed/${id}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>`
  return c.html(html, 200, { 'Cache-Control': 'public, max-age=86400' })
})
app.route('/connectors', connectorsRoute)
app.route('/connector-api', connectorApiRoute)
app.route('/providers', providerFluxesRoute)
app.route('/ui/users', uiUsersRoute)
app.route('/ui/admins', adminsRoute)
app.route('/ui/providers', adminProvidersRoute)
app.route('/ui/repositories', adminRepositoriesRoute)
app.route('/ui/flux-requests', fluxRequestsAdminRoute)
app.route('/ui/connector-keys', adminConnectorKeysRoute)
app.route('/ui/maintenance', maintenanceRoute)

app.get('/openapi.json', (c) => c.json(openApiSpec))
app.get(
  '/docs',
  apiReference({
    url: '/openapi.json',
    pageTitle: 'StayUp API',
  }),
)

export default app
