import { describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { json, TEST_ENV } from '../helpers.js'

describe('GET /', () => {
  it('returns health check without auth', async () => {
    const res = await app.request('/', {}, TEST_ENV)
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body).toEqual({ status: 'ok' })
  })
})
