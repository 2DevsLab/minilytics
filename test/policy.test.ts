import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'

const subtle = globalThis.crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (left: BufferSource, right: BufferSource) => boolean
}
if (typeof subtle.timingSafeEqual !== 'function') {
  subtle.timingSafeEqual = (left, right) => {
    const view = (source: BufferSource) =>
      source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    return nodeTimingSafeEqual(view(left), view(right))
  }
}
import { describe, expect, it } from 'vitest'
import { startOfDay } from '../src/worker/lib/time'
import { passwordMatches } from '../src/worker/lib/crypto'
import { decideIngest, requestGeo, visitorSalt, type IngestFacts } from '../src/worker/policy'

const now = Date.UTC(2026, 9, 23, 12, 0)
const salt = 'visitor-salt'
const ip = '203.0.113.8'
const ua = 'Mozilla/5.0 Chrome/129'
const site = { id: 'siteid01', domain: 'example.com', timezone: 'Europe/Prague', cookie_visitors: false }

function facts(over: Partial<IngestFacts> = {}): IngestFacts {
  return {
    origin: 'https://example.com',
    referer: null,
    ip,
    ua,
    cf: { country: 'CZ', region: '10', city: 'Prague', latitude: 50.087, longitude: 14.421 },
    now,
    site,
    scriptCookie: false,
    clientVid: null,
    clientSid: null,
    salt,
    pageUrl: 'https://www.example.com/pricing/?utm_source=x',
    ...over,
  }
}

function visitorHex(at: number) {
  const day = String(startOfDay(at, site.timezone))
  return createHmac('sha256', salt).update(`${ip}\n${ua}\n${site.id}\n${day}`).digest('hex')
}

function sessionHex(at: number) {
  return createHmac('sha256', salt).update(`${ip}\n${ua}\n${site.id}\n${String(startOfDay(at, site.timezone))}\n${Math.floor(at / 1_800_000)}`).digest('hex')
}

describe('decideIngest', () => {
  it('uses Origin and ignores a matching Referer when Origin is foreign', async () => {
    const denied = await decideIngest(facts({ origin: 'https://evil.com', referer: 'https://example.com/from' }))
    expect(denied).toMatchObject({ ok: false, status: 403, reason: 'origin' })
  })

  it('uses Referer only when Origin is absent', async () => {
    const allowed = await decideIngest(facts({ origin: null, referer: 'https://blog.example.com/post' }))
    expect(allowed.ok).toBe(true)
    const missing = await decideIngest(facts({ origin: null, referer: null }))
    expect(missing).toMatchObject({ ok: false, status: 403, reason: 'origin' })
    const badOrigin = await decideIngest(facts({ origin: 'not a url', referer: 'https://example.com/' }))
    expect(badOrigin).toMatchObject({ ok: false, status: 403, reason: 'origin' })
  })

  it('keeps a page on another host once the header matches', async () => {
    const decision = await decideIngest(facts({ pageUrl: 'https://evil.com/phish' }))
    expect(decision.ok).toBe(true)
    if (decision.ok) expect(decision.page.hostname).toBe('evil.com')
  })

  it('rejects a page URL that does not parse', async () => {
    expect(await decideIngest(facts({ pageUrl: 'not a url' }))).toMatchObject({ ok: false, status: 400, reason: 'page-url' })
  })

  it('hashes the visitor for the site day and the session for 30 minutes', async () => {
    const first = await decideIngest(facts({ clientVid: 'aaaaaaaa', clientSid: 'bbbbbbbb' }))
    const second = await decideIngest(facts())
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.identity).toBe('cookieless')
    expect(first.visitorId).toBe(second.visitorId)
    expect(first.visitorId).toBe(visitorHex(now))
    expect(first.sessionId).toBe(sessionHex(now))
    expect(first.geo).toEqual({ country: 'CZ', region: '10', city: 'Prague', lat: 50.09, lon: 14.42 })

    const nextBucket = await decideIngest(facts({ now: now + 1_800_000 }))
    expect(nextBucket.ok).toBe(true)
    if (!nextBucket.ok) return
    expect(nextBucket.visitorId).toBe(first.visitorId)
    expect(nextBucket.sessionId).not.toBe(first.sessionId)
    expect(nextBucket.sessionId).toBe(sessionHex(now + 1_800_000))

    const nextDay = await decideIngest(facts({ now: now + 86_400_000 }))
    expect(nextDay.ok).toBe(true)
    if (!nextDay.ok) return
    expect(nextDay.visitorId).not.toBe(first.visitorId)
  })

  it('trusts both client ids in cookie mode and hashes when both are absent', async () => {
    const vid = 'visitor-1'
    const sid = 'session-1'
    const cookie = await decideIngest(facts({
      site: { ...site, cookie_visitors: true },
      clientVid: vid,
      clientSid: sid,
      ip: null,
      salt: null,
    }))
    expect(cookie).toMatchObject({ ok: true, identity: 'cookie', visitorId: vid, sessionId: sid })

    const fromScript = await decideIngest(facts({ scriptCookie: true, clientVid: vid, clientSid: sid, ip: null, salt: null }))
    expect(fromScript).toMatchObject({ ok: true, identity: 'cookie', visitorId: vid, sessionId: sid })

    const one = await decideIngest(facts({ scriptCookie: true, clientVid: vid, clientSid: null }))
    expect(one).toMatchObject({ ok: false, status: 400, reason: 'cookie-id' })
    const bad = await decideIngest(facts({ scriptCookie: true, clientVid: 'short', clientSid: sid }))
    expect(bad).toMatchObject({ ok: false, status: 400, reason: 'cookie-id' })

    const neither = await decideIngest(facts({ site: { ...site, cookie_visitors: true } }))
    expect(neither.ok).toBe(true)
    if (neither.ok) {
      expect(neither.identity).toBe('cookieless')
      expect(neither.visitorId).toBe(visitorHex(now))
    }
  })

  it('requires an IP and a salt for the cookieless hash', async () => {
    expect(await decideIngest(facts({ ip: null }))).toMatchObject({ ok: false, status: 403, reason: 'client-ip' })
    expect(await decideIngest(facts({ salt: null }))).toMatchObject({ ok: false, status: 503, reason: 'salt' })
  })
})

describe('passwordMatches', () => {
  it('compares plaintext passwords by digest', async () => {
    expect(await passwordMatches('secret', 'secret')).toBe(true)
    expect(await passwordMatches('secret', 'secret2')).toBe(false)
    expect(await passwordMatches('a', 'ab')).toBe(false)
  })

  it('verifies a PBKDF2 string and does not treat a broken string as plaintext', async () => {
    const salt = randomBytes(16)
    const hash = pbkdf2Sync('correct horse', salt, 1_000, 32, 'sha256')
    const phc = `$pbkdf2-sha256$i=1000$${salt.toString('base64')}$${hash.toString('base64')}`
    expect(await passwordMatches(phc, 'correct horse')).toBe(true)
    expect(await passwordMatches(phc, 'wrong')).toBe(false)
    expect(await passwordMatches('$pbkdf2-sha256$nope', '$pbkdf2-sha256$nope')).toBe(false)
    expect(await passwordMatches('$pbkdf2-sha256$i=9000000$aa$bb', 'x')).toBe(false)
  })
})

describe('requestGeo and visitorSalt', () => {
  it('reads coordinates only from the cf object', () => {
    expect(requestGeo(null)).toEqual({ country: null, region: null, city: null, lat: null, lon: null })
    expect(requestGeo({ country: 'US', latitude: 'not-a-number', longitude: 200 }).lat).toBeNull()
    expect(requestGeo({ country: 'US', latitude: 'not-a-number', longitude: 200 }).lon).toBeNull()
  })

  it('prefers VISITOR_SALT and otherwise uses SESSION_SECRET', () => {
    expect(visitorSalt({ VISITOR_SALT: 'pepper', SESSION_SECRET: 'session' })).toBe('pepper')
    expect(visitorSalt({ SESSION_SECRET: 'session' })).toBe('session')
    expect(visitorSalt({})).toBeNull()
    expect(visitorSalt({ VISITOR_SALT: '', SESSION_SECRET: 'session' })).toBe('session')
  })
})
