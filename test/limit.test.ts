import { describe, expect, it } from 'vitest'
import { allowIngest, INGEST_IP_LIMIT } from '../src/worker/limit'

describe('allowIngest', () => {
  it('calls both bindings and ignores a single binding', async () => {
    let calls = 0
    const deny = { limit: async () => { calls += 1; return { success: false } } }
    const allow = { limit: async () => ({ success: true }) }
    expect(await allowIngest({ INGEST_IP: deny, INGEST_SITE: allow }, '1.1.1.1', 'bound-site', 0)).toBe(false)
    expect(calls).toBe(1)
    calls = 0
    expect(await allowIngest({ INGEST_IP: deny }, '1.1.1.1', 'half-config', 60_000)).toBe(true)
    expect(calls).toBe(0)
  })

  it('refills a fixed window per IP and per site', async () => {
    const now = 5 * 60_000
    const ip = '203.0.113.61'
    const siteId = 'window-site'
    for (let i = 0; i < INGEST_IP_LIMIT; i++) expect(await allowIngest({}, ip, siteId, now)).toBe(true)
    expect(await allowIngest({}, ip, siteId, now + 1_000)).toBe(false)
    expect(await allowIngest({}, '203.0.113.62', siteId, now)).toBe(true)
    expect(await allowIngest({}, ip, siteId, now + 60_000)).toBe(true)
  })

  it('shares the unknown bucket when the IP is missing', async () => {
    const now = 9 * 60_000
    const siteId = 'unknown-ip-site'
    for (let i = 0; i < INGEST_IP_LIMIT; i++) expect(await allowIngest({}, null, siteId, now)).toBe(true)
    expect(await allowIngest({}, null, siteId, now)).toBe(false)
    expect(await allowIngest({}, '203.0.113.70', siteId, now)).toBe(true)
  })
})
