# StayUp API

[![CI](https://github.com/stayup-app/stayup-api/actions/workflows/ci.yml/badge.svg)](https://github.com/stayup-app/stayup-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Website:** https://stayup-ui.vercel.app

HTTP API that aggregates content from several sources — changelogs, YouTube channels, RSS feeds and scraped pages — and serves it back as per-user feeds.

Built with [Hono](https://hono.dev), deployed on Cloudflare Workers or Node/Docker, on top of a single PostgreSQL database. There is one StayUp API; the apps all talk to it.

## Stack

| | |
|---|---|
| Runtime | Node.js 22 · Cloudflare Workers |
| Framework | Hono 4 |
| Database | PostgreSQL |
| Tests | Vitest |
| Quality | Biome (lint + format) · strict TypeScript |
| Documentation | OpenAPI 3.1 · [Scalar](https://scalar.com) UI |

## Quick start

```bash
git clone git@github.com:stayup-app/stayup-api.git
cd stayup-api
npm install

cp .env.example .env          # set JWT_SECRET (and DATABASE_URL if not using DB_*)
docker compose up -d db       # PostgreSQL on :5432

npm run dev                   # API on http://localhost:3000
```

Interactive documentation is then available at **http://localhost:3000/docs**.

On first start the PostgreSQL container creates two databases: `stayup` (development, schema applied automatically) and `stayup_test` (functional tests).

### Everything in containers

```bash
docker compose up -d          # api :3000 · db :5432 · pgadmin :5050
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | built from `DB_*` | PostgreSQL connection string |
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | `localhost` `5432` `stayup` `postgres` `postgres` | Alternative to `DATABASE_URL` |
| `JWT_SECRET` | `changeme` | Token signing key — **change this in production** |
| `PORT` | `3000` | Listening port |
| `UI_URL` | `http://localhost:3001` | Redirect target after OAuth |
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` | — | Google OAuth (optional) |
| `GITHUB_CLIENT_ID` `GITHUB_CLIENT_SECRET` | — | GitHub OAuth (optional) |
| `CLEANUP_SECRET` | — | Shared secret that lets the cleanup cron call `POST /ui/maintenance/cleanup` without an admin JWT. Empty → only an admin can trigger the purge |

On Cloudflare Workers these are set with `wrangler secret put <NAME>`.

## Scripts

| Command | Effect |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run dev:worker` | Local server through Wrangler (Workers runtime) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the build |
| `npm test` | Full suite — **requires PostgreSQL** |
| `npm run test:unit` | Unit tests only (mocked database, no dependency) |
| `npm run test:functional` | Functional tests against `stayup_test` |
| `npm run typecheck` | Type checking, source **and** tests |
| `npm run lint` / `lint:fix` | Biome analysis, with or without fixes |
| `npm run create-user` | Create a user account from the command line |
| `npm run create-admin` | Bootstrap the first **super admin** (from source) |
| `npm run create-admin:prod` | Same, from a built image: `node dist/scripts/create-admin.js` |
| `npm run deploy` | Deploy to Cloudflare Workers |

Creating a user:

```bash
npm run create-user -- "Alice" alice@example.com secret123
```

Bootstrapping the first super admin — from source, or from the Docker image
(the built `dist/` already ships the compiled script and `schema.sql`):

```bash
npm run create-admin  root@example.com "Root" 's3cret'
# or, inside a container built from the Dockerfile:
docker compose run --rm api node dist/scripts/create-admin.js root@example.com "Root" 's3cret'
```

Both apply `src/db/schema.sql` first, then insert the super admin.

## API

Every route is described in the OpenAPI specification served at `/openapi.json` and browsable at `/docs`.

| Area | Routes | Access |
|---|---|---|
| Health | `GET /` | public |
| Authentication | `POST /auth/register` · `POST /auth/login` · `GET /auth/me` · `GET /auth/config` · `GET /auth/oauth/{google,github}` and their callbacks | public |
| Connectors (read) | `GET /connectors` · `GET /connectors/:name` · `GET /connectors/providers` | authenticated |
| | `GET /connectors/latest` | admin |
| Connector API (write) | `POST /connector-api/:provider/{register,sources,items,errors}` · `GET /connector-api/:provider/sources[/:id/{state,versions}]` · `PATCH /connector-api/:provider/sources/:id/config` · `DELETE /connector-api/:provider/sources/:id/old-items` | connector key |
| Provider fluxes | `GET /providers/:provider/fluxes` · `POST`/`DELETE /providers/:provider/fluxes/:id/subscribe` | authenticated |
| Users | `GET`/`PATCH /ui/users/:userId` · `GET /ui/users/:userId/feed[/:connector]` · `POST`/`DELETE /ui/users/:userId/repositories` | self or admin |
| Administration | `GET`/`POST`/`DELETE` `/ui/users` · `/ui/repositories` · `/ui/flux-requests` · `/ui/providers` · `/ui/admins` · `/ui/connector-keys` · `GET`/`PATCH /ui/maintenance/retention` | admin |
| Maintenance | `POST /ui/maintenance/cleanup` | admin **or** `CLEANUP_SECRET` |

### Authentication

Two credentials coexist:

- **Users and admins** send a JWT (`Authorization: Bearer <jwt>`), obtained from `POST /auth/login` or the OAuth flow, valid for 24 hours. The role it carries (`admin` or `user`) drives access.
- **Connectors** send an API key (`Authorization: Bearer stayup_conn_…`) on `/connector-api/*` only. A key is scoped to a single provider — an `rss` key cannot write for `youtube` — created by an admin from `stayup-ui` (or `POST /ui/connector-keys`), shown once, and revocable (`DELETE /ui/connector-keys/:id`). See [Connectors](#connectors).

Getting a JWT:

```bash
# Admin account — the `username` field carries the admin's e-mail
curl -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"root@example.com","password":"secret"}'

# User account — email and password
curl -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"secret"}'
```

Routes under `/ui/users/:userId` are open to that user as well as to admins; administration routes require the `admin` role, and managing other admins requires a super admin (`is_super`).

Admins live in the `admin` table. Bootstrap the first (super) admin from the command line:

```bash
npm run create-admin root@example.com "Root" 's3cret'
```

Further admins are then created from `stayup-ui`'s admin area (super admin only). Accounts created through registration, OAuth or `npm run create-user` always get the `user` role.

OAuth sign-up automatically links the account to an existing user when the email address matches. Callbacks accept a `redirect_uri` using the `stayup://` or `exp://` scheme for mobile deep links; any other scheme is ignored in favour of `UI_URL`.

`GET /auth/config` (public) reports which login methods the API offers (`{ emailPassword, oauth: { google, github } }`).

The OAuth start routes (`GET /auth/oauth/:provider`) accept an optional opaque `client_state` query param, echoed back unchanged as `&state=` on the callback redirect.

### Flux approval

Each provider carries a `flux_approval` mode in `provider_registry` (`auto` | `manual`, an admin sets it via `PATCH /ui/providers/:name`). When a user adds a flux that does not exist yet with `POST /ui/users/:userId/repositories`:

- `auto` — the source is created and the user subscribed immediately (`201`).
- `manual` — a request is created in `pending` state (`202`). An admin then handles it with `POST /ui/flux-requests/:id/approve` — the source is created and the requester subscribed automatically — or `POST /ui/flux-requests/:id/reject`. Scraping ships as `manual`.

Subscribing to a flux that already exists is never gated.

## Database

PostgreSQL only. The schema is [`src/db/schema.sql`](src/db/schema.sql), applied automatically when the container first starts and when functional tests run.

The core tables are `repository` (a tracked source), `connector_item` (all collected content, one table for every provider, discriminated by a `provider` column), `user_repository` (subscriptions), `provider_registry` (one row per provider — display name, ordering, `flux_approval` mode, `retention_days` override), `connector_key` (connector API keys), `app_setting` (the global content-retention default) and `log` (connector run errors). Auth relies on the `user`, `account`, `session` and `verification` tables, in [Better Auth](https://better-auth.com) format — managed by `stayup-ui`.

## Connectors

A connector (e.g. `stayup-cmd-changelog`, `stayup-cmd-rss`, `stayup-cmd-youtube`) is an
independent project that collects one kind of source and **talks to this API over HTTP** —
it never touches the database. Everything it does goes through `/connector-api/:provider/*`,
authenticated with a provider-scoped [connector key](#authentication):

- `POST …/register` — declare the display name and sort order on every
  run (idempotent).
- `POST …/sources` / `GET …/sources` — follow a URL / list the ones to collect.
- `GET …/sources/:id/state` and `…/versions` — the last known version, or every known
  version, so the connector knows where to resume.
- `PATCH …/sources/:id/config` — shallow-merge keys into a source's config (e.g. `rss`
  stores the channel title there for labelling).
- `POST …/items` — write a batch of collected rows into `connector_item`.
- `POST …/errors` — record a collection failure in `log`.

Connectors no longer prune old content themselves. `DELETE …/sources/:id/old-items` still
works for older connector versions, but retention is now an **instance setting** — see
[Content retention](#content-retention).

The API never hardcodes a provider name: a provider **exists** as soon as it has a row in
`provider_registry` or any content in `connector_item`. Its display name comes from `provider_registry`; how each provider is rendered is hardcoded in the three apps.

### Content retention

Collected rows in `connector_item` are pruned centrally, not by the connectors. An admin
sets the policy and a scheduled job pulls the trigger:

- `GET /ui/maintenance/retention` — the global default (in days, or `null` for "keep
  forever") and each provider's optional override.
- `PATCH /ui/maintenance/retention` — `{ default?: number | null, providers?: { "<name>":
  number | null } }`. Per-provider `retention_days` lives in `provider_registry`; the global
  default lives in `app_setting` (built-in default: **30 days**).
- `POST /ui/maintenance/cleanup` — deletes every provider's expired content in one pass
  (override if set, else the global default; a provider whose effective retention is `null`
  is left alone). Accepts an **admin JWT** or `Authorization: Bearer $CLEANUP_SECRET`.

`stayup-api` ships `.github/workflows/cleanup.yml`, a daily scheduled workflow that calls
`POST /ui/maintenance/cleanup` with `CLEANUP_SECRET` — set the `STAYUP_API_URL` and
`CLEANUP_SECRET` repository secrets to enable it (or run cleanup from any other cron).

## Tests

```bash
npm run test:unit        # fast, no dependency
npm test                 # full — requires PostgreSQL
```

Unit tests isolate each route by replacing the SQL layer with an ordered mock (`tests/helpers.ts`). Functional tests run against a real `stayup_test` database and check end-to-end flows.

Type checking covers source **and** tests through `tsconfig.test.json`. Lint, typecheck, build and tests all run in CI before any deployment.

## Deployment

A push to `main` triggers CI and, if it passes, an automatic deployment to Cloudflare Workers.

Manual deployment:

```bash
npm run deploy
```

A Docker image is also provided for conventional hosting — multi-stage build, final image without development dependencies.

## License

[MIT](LICENSE)
