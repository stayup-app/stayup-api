import { describe, expect, it } from 'vitest'
import app from '../../src/app.js'
import { TEST_ENV } from '../helpers.js'

describe('GET /embed/youtube/:id', () => {
  it('serves a player page for a valid id', async () => {
    const res = await app.request('/embed/youtube/dQw4w9WgXcQ', {}, TEST_ENV)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    )
  })

  it('rejects an invalid id', async () => {
    const res = await app.request('/embed/youtube/a"onload=x', {}, TEST_ENV)
    expect(res.status).toBe(400)
  })
})
