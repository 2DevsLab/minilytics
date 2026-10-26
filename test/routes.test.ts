import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootWorker, type WorkerHarness } from './workerHarness'

const PASSWORD = 'test-password'
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36'

describe('routes', () => {
  let harness: WorkerHarness
  let cookie = ''
  let site: { id: string; api_key: string; domain: string; timezone: string }

  async function read<T>(res: Response): Promise<T> {
    return (await res.json()) as T
  }

  beforeAll(async () => {
    harness = await bootWorker()
    const login = await harness.fetch('http://example.com/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.10' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(login.status).toBe(200)
    cookie = login.headers.get('set-cookie')?.split(';')[0] ?? ''
    const created = await harness.fetch('http://example.com/api/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'cf-connecting-ip': '203.0.113.10' },
      body: JSON.stringify({ domain: 'example.com', name: 'Example' }),
    })
    expect(created.status).toBe(200)
    site = await read(created)
    expect(site.domain).toBe('example.com')
  }, 60_000)

  afterAll(async () => {
    await harness?.dispose()
  })

  function authed(extra: Record<string, string> = {}) {
    return { cookie, 'cf-connecting-ip': '203.0.113.10', ...extra }
  }

  async function event(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return harness.fetch('http://example.com/api/event', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'user-agent': UA, 'cf-connecting-ip': '203.0.113.20', ...headers },
      body: JSON.stringify({ w: site.id, ...body }),
    })
  }

  it('rejects an oversized body, a bot, and a missing Origin', async () => {
    const huge = await event({ t: 'pageview', u: 'https://example.com/', ck: 1, vid: 'visitor-huge', sid: 'session-huge', pad: 'x'.repeat(8200) })
    expect(huge.status).toBe(413)
    expect(await huge.text()).toBe('')

    const bot = await harness.fetch('http://example.com/api/event', {
      method: 'POST',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      body: JSON.stringify({ w: 'no-such-site', t: 'pageview', u: 'https://example.com/' }),
    })
    expect(bot.status).toBe(202)
    expect(await bot.text()).toBe('')

    const foreign = await event({ t: 'pageview', u: 'https://example.com/' })
    expect(foreign.status).toBe(403)
    expect(await foreign.text()).toBe('')
  })

  it('stores a cookie visitor and rejects browser identify', async () => {
    const vid = 'visitor-cookie-1'
    const sid = 'session-cookie-1'
    const ok = await event(
      { t: 'pageview', u: 'https://example.com/pricing', r: 'https://t.co/abc', vid, sid, ck: 1 },
      { origin: 'https://www.example.com' },
    )
    expect(ok.status).toBe(202)
    expect(await ok.text()).toBe('')

    const browser = await event(
      { t: 'identify', u: 'https://example.com/pricing', vid, sid, ck: 1, p: { email: 'planted@evil.test', name: 'Planted' } },
      { origin: 'https://example.com' },
    )
    expect(browser.status).toBe(400)
    expect(await browser.text()).toBe('')

    const profile = await harness.fetch(`http://example.com/api/sites/${site.id}/visitors/${vid}`, { headers: authed() })
    expect(profile.status).toBe(200)
    const before = await read<{ visitor: { email: string | null; id: string } }>(profile)
    expect(before.visitor.email).toBeNull()
    expect(before.visitor.id).toBe(vid)

    const first = await harness.fetch('http://example.com/api/v1/identify', {
      method: 'POST',
      headers: { authorization: `Bearer ${site.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visitor_id: vid, email: 'Jane@Acme.com', name: 'Jane', user_id: 'user_1' }),
    })
    expect(first.status).toBe(200)
    expect(await read(first)).toEqual({ ok: true })

    const second = await harness.fetch('http://example.com/api/v1/identify', {
      method: 'POST',
      headers: { authorization: `Bearer ${site.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ visitor_id: vid, email: 'other@acme.com', name: 'Other', user_id: 'user_999' }),
    })
    expect(second.status).toBe(200)

    const badKey = await harness.fetch('http://example.com/api/v1/identify', {
      method: 'POST',
      headers: { authorization: 'Bearer ml_nope', 'content-type': 'application/json' },
      body: JSON.stringify({ visitor_id: vid, email: 'x@y.z' }),
    })
    expect(badKey.status).toBe(401)
    expect(await read(badKey)).toEqual({ error: 'invalid api key' })

    const after = await read<{ visitor: { email: string; name: string; user_id: string } }>(
      await harness.fetch(`http://example.com/api/sites/${site.id}/visitors/${vid}`, { headers: authed() }),
    )
    expect(after.visitor.email).toBe('jane@acme.com')
    expect(after.visitor.name).toBe('Jane')
    expect(after.visitor.user_id).toBe('user_1')
  })

  it('returns 429 with an empty body after 60 events from one IP', async () => {
    const ip = '203.0.113.61'
    let last = 0
    for (let i = 0; i < 60; i++) {
      const res = await event({ t: 'ping', u: 'https://example.com/', d: 1000 }, { 'cf-connecting-ip': ip, origin: 'https://example.com' })
      last = res.status
      expect(res.status).toBe(202)
      await res.text()
    }
    expect(last).toBe(202)
    const limited = await event({ t: 'ping', u: 'https://example.com/', d: 1000 }, { 'cf-connecting-ip': ip, origin: 'https://example.com' })
    expect(limited.status).toBe(429)
    expect(await limited.text()).toBe('')
    const other = await event({ t: 'ping', u: 'https://example.com/', d: 1000 }, { 'cf-connecting-ip': '203.0.113.62', origin: 'https://example.com' })
    expect(other.status).toBe(202)
    await other.text()
  }, 60_000)

  it('hides live and share until public stats are on, then returns only public keys', async () => {
    const created = await harness.fetch('http://example.com/api/sites', {
      method: 'POST',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'live.example', name: 'Live' }),
    })
    const liveSite = await read<{ id: string }>(created)
    const hidden = await harness.fetch(`http://example.com/api/public/${liveSite.id}/live`)
    expect(hidden.status).toBe(404)
    expect(hidden.headers.get('cache-control')).toBe('no-store')
    expect(await read(hidden)).toEqual({ error: 'not found' })
    const hiddenShare = await harness.fetch(`http://example.com/api/public/${liveSite.id}/share`)
    expect(hiddenShare.status).toBe(404)
    expect(await read(hiddenShare)).toEqual({ error: 'not found' })

    const badFlag = await harness.fetch(`http://example.com/api/sites/${liveSite.id}`, {
      method: 'PATCH',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ public_stats: 1 }),
    })
    expect(badFlag.status).toBe(400)

    const turnedOn = await harness.fetch(`http://example.com/api/sites/${liveSite.id}`, {
      method: 'PATCH',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ public_stats: true }),
    })
    expect(turnedOn.status).toBe(200)
    expect((await read<{ public_stats: boolean }>(turnedOn)).public_stats).toBe(true)

    const now = Date.now()
    await harness.db
      .prepare(
        `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel)
         VALUES (?, 'old-session', 'old-visitor', ?, ?, 'Direct/None', 'Direct')`,
      )
      .bind(liveSite.id, now - 7 * 60 * 60 * 1000, now)
      .run()
    const quiet = await harness.fetch(`http://example.com/api/public/${liveSite.id}/live?probe=before`)
    expect(quiet.status).toBe(200)
    const quietBody = await read<{ online: number }>(quiet)
    expect(Object.keys(quietBody).sort()).toEqual(['last24h', 'online', 'today'])
    expect(quietBody.online).toBe(0)

    await harness.db
      .prepare(
        `INSERT INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, source, channel)
         VALUES (?, 'new-session', 'new-visitor', ?, ?, 'Direct/None', 'Direct')`,
      )
      .bind(liveSite.id, now - 60_000, now)
      .run()
    const live = await harness.fetch(`http://example.com/api/public/${liveSite.id}/live?probe=after`, {
      headers: { origin: 'https://app.live.example' },
    })
    expect(live.headers.get('access-control-allow-origin')).toBe('https://app.live.example')
    expect(live.headers.get('vary')).toBe('Origin')
    expect(live.headers.get('cache-control')).toContain('s-maxage=60')
    const liveBody = await read<{ online: number }>(live)
    expect(Object.keys(liveBody).sort()).toEqual(['last24h', 'online', 'today'])
    expect(liveBody.online).toBe(1)

    const omitted = await harness.fetch(`http://example.com/api/public/${liveSite.id}/live`, {
      headers: { origin: 'https://evil.com' },
    })
    expect(omitted.headers.get('access-control-allow-origin')).toBeNull()

    const view = await event(
      { t: 'pageview', u: 'https://example.com/docs', r: 'https://news.ycombinator.com/item', vid: 'share-visitor', sid: 'share-session', ck: 1 },
      { origin: 'https://example.com' },
    )
    expect(view.status).toBe(202)
    await view.text()
    await harness.fetch(`http://example.com/api/sites/${site.id}`, {
      method: 'PATCH',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ public_stats: true }),
    })
    const share = await harness.fetch(`http://example.com/api/public/${site.id}/share`)
    expect(share.status).toBe(200)
    const shareBody = await read<{
      period: string
      pages: { label: string }[]
      referrers: { label: string }[]
      countries: { label: string }[]
    }>(share)
    expect(shareBody.period).toBe('7d')
    expect(Object.keys(shareBody).sort()).toEqual(['countries', 'pages', 'pageviews', 'period', 'referrers', 'visitors'])
    const encoded = JSON.stringify(shareBody)
    expect(encoded).not.toContain('revenue')
    expect(encoded).not.toContain('email')
    expect(encoded).not.toContain('api_key')
    for (const row of [...shareBody.pages, ...shareBody.referrers, ...shareBody.countries]) {
      expect(Object.keys(row).sort()).toEqual(['label', 'pageviews', 'visitors'])
    }
    expect(shareBody.referrers.some((row: { label: string }) => row.label === 'news.ycombinator.com')).toBe(true)

    const badPeriod = await harness.fetch(`http://example.com/api/public/${site.id}/share?period=year`)
    expect(badPeriod.status).toBe(400)
  })

  it('sends no-store and nosniff on private API responses', async () => {
    const me = await harness.fetch('http://example.com/api/auth/me', { headers: authed() })
    expect(me.headers.get('cache-control')).toBe('no-store')
    expect(me.headers.get('x-content-type-options')).toBe('nosniff')
    expect(me.headers.get('x-frame-options')).toBe('DENY')
  })

  it('keeps the 10th wrong password at 401 and the 11th at 429', async () => {
    const ip = '203.0.113.99'
    for (let i = 0; i < 10; i++) {
      const res = await harness.fetch('http://example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({ password: 'wrong-password' }),
      })
      expect(res.status).toBe(401)
      await res.text()
    }
    const locked = await harness.fetch('http://example.com/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({ password: PASSWORD }),
    })
    expect(locked.status).toBe(429)
    const body = await read<{ error: string }>(locked)
    expect(body.error).toContain('15 minutes')
  }, 30_000)
})

describe('password forms and hosted login', () => {
  it('accepts a PBKDF2 admin password', async () => {
    const salt = randomBytes(16)
    const hash = pbkdf2Sync('phc-password', salt, 1_000, 32, 'sha256')
    const phc = `$pbkdf2-sha256$i=1000$${salt.toString('base64')}$${hash.toString('base64')}`
    const harness = await bootWorker({ bindings: { ADMIN_PASSWORD: phc } })
    try {
      const ok = await harness.fetch('http://example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.70' },
        body: JSON.stringify({ password: 'phc-password' }),
      })
      expect(ok.status).toBe(200)
      const bad = await harness.fetch('http://example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.71' },
        body: JSON.stringify({ password: phc }),
      })
      expect(bad.status).toBe(401)
    } finally {
      await harness.dispose()
    }
  }, 30_000)

  it('keeps hosted login at 400 while Access variables are set', async () => {
    const harness = await bootWorker({
      bindings: {
        GOOGLE_CLIENT_ID: 'google-client',
        GOOGLE_CLIENT_SECRET: 'google-secret',
        CF_ACCESS_TEAM_DOMAIN: 'team',
        CF_ACCESS_AUD: 'aud',
      },
    })
    try {
      const res = await harness.fetch('http://example.com/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.80' },
        body: JSON.stringify({ password: PASSWORD }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'Use "Continue with Google".' })
    } finally {
      await harness.dispose()
    }
  }, 30_000)
})
