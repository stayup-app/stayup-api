import { describe, expect, it, vi } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV, json } from '../helpers.js'

vi.mock('../../src/db/client.js', () => ({ getSql: vi.fn() }))

async function config(env: typeof TEST_ENV) {
  const res = await app.request('/auth/config', {}, env)
  return { status: res.status, body: await json(res) }
}

describe('GET /auth/config', () => {
  it('reports both OAuth providers by default', async () => {
    const { status, body } = await config(TEST_ENV)
    expect(status).toBe(200)
    expect(body).toEqual({
      emailPassword: true,
      oauth: { google: true, github: true },
    })
  })

  it('hides an OAuth provider whose credentials are not set', async () => {
    const { body } = await config({
      ...TEST_ENV,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    })
    expect(body.oauth).toEqual({ google: false, github: true })
  })

  it('needs no authentication', async () => {
    const res = await app.request('/auth/config', {}, TEST_ENV)
    expect(res.status).toBe(200)
  })
})
