import type { Env, Site } from './env'
import { allowIngest } from './limit'
import { startOfDay } from './lib/time'

declare const visitorIdBrand: unique symbol
declare const sessionIdBrand: unique symbol
export type VisitorId = string & { readonly [visitorIdBrand]: 'VisitorId' }
export type SessionId = string & { readonly [sessionIdBrand]: 'SessionId' }

export const CLIENT_ID = /^[\w-]{8,64}$/

export interface Geo {
  country: string | null
  region: string | null
  city: string | null
  lat: number | null
  lon: number | null
}

export type TrackedType = 'pageview' | 'goal' | 'outbound' | 'ping'

export interface TrackedEvent {
  type: TrackedType
  visitorId: VisitorId
  sessionId: SessionId
  page: URL
  referrer: string | null
  geo: Geo
  ua: string
  screenWidth: number | null
  name: string | null
  props: Record<string, unknown> | null
  durationMs: number | null
  now: number
}

export interface RawEvent {
  siteId: string
  type: TrackedType | 'identify'
  pageUrl: string
  referrer: string | null
  scriptCookie: boolean
  clientVid: string | null
  clientSid: string | null
  screenWidth: number | null
  name: string | null
  props: Record<string, unknown> | null
  durationMs: number | null
}

interface CfGeo {
  country?: unknown
  region?: unknown
  city?: unknown
  latitude?: unknown
  longitude?: unknown
}

export interface IngestFacts {
  origin: string | null
  referer: string | null
  ip: string | null
  ua: string
  cf: CfGeo | null
  now: number
  site: Pick<Site, 'id' | 'domain' | 'timezone' | 'cookie_visitors'>
  scriptCookie: boolean
  clientVid: string | null
  clientSid: string | null
  salt: string | null
  pageUrl: string
}

export type IngestDenyReason = 'page-url' | 'origin' | 'cookie-id' | 'client-ip' | 'salt' | 'identify'

export type GateResult =
  | { ok: false; status: 400 | 403 | 429 | 503; reason: IngestDenyReason | 'rate' }
  | { ok: true; event: TrackedEvent }

export type IngestDecision =
  | { ok: false; status: 400 | 403 | 503; reason: IngestDenyReason }
  | {
      ok: true
      identity: 'cookie' | 'cookieless'
      visitorId: VisitorId
      sessionId: SessionId
      geo: Geo
      page: URL
    }

export function publicStatsOn(site: Pick<Site, 'public_stats'>): boolean {
  return site.public_stats === true
}

function stripWww(host: string) {
  return host.replace(/^www\./, '').toLowerCase()
}

export function belongsTo(hostname: string, domain: string): boolean {
  const h = stripWww(hostname)
  const d = stripWww(domain)
  return h === d || h.endsWith('.' + d)
}

export function clientIp(request: Request): string | null {
  const ip = request.headers.get('cf-connecting-ip')
  if (!ip || !ip.trim()) return null
  return ip.trim()
}

function coord(v: unknown, max: number): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) && Math.abs(n) <= max ? Math.round(n * 100) / 100 : null
}

function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

export function requestGeo(cf: CfGeo | null | undefined): Geo {
  if (!cf) return { country: null, region: null, city: null, lat: null, lon: null }
  return {
    country: textOrNull(cf.country),
    region: textOrNull(cf.region),
    city: textOrNull(cf.city),
    lat: coord(cf.latitude, 90),
    lon: coord(cf.longitude, 180),
  }
}

export function visitorSalt(env: { VISITOR_SALT?: string; SESSION_SECRET?: string }): string | null {
  if (env.VISITOR_SALT) return env.VISITOR_SALT
  if (env.SESSION_SECRET) return env.SESSION_SECRET
  return null
}

function headerHost(value: string): string | null {
  try {
    return new URL(value).hostname
  } catch {
    return null
  }
}

function brandVisitor(id: string): VisitorId {
  return id as VisitorId
}

function brandSession(id: string): SessionId {
  return id as SessionId
}

const enc = new TextEncoder()

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function decideIngest(facts: IngestFacts): Promise<IngestDecision> {
  let page: URL
  try {
    page = new URL(facts.pageUrl)
  } catch {
    return { ok: false, status: 400, reason: 'page-url' }
  }

  const originPresent = facts.origin !== null
  const candidate = originPresent ? facts.origin : facts.referer
  const host = candidate ? headerHost(candidate) : null
  if (!host || !belongsTo(host, facts.site.domain)) return { ok: false, status: 403, reason: 'origin' }

  const wantCookie = facts.site.cookie_visitors || facts.scriptCookie
  const clientVid = facts.clientVid
  const clientSid = facts.clientSid
  const vidOk = clientVid !== null && CLIENT_ID.test(clientVid)
  const sidOk = clientSid !== null && CLIENT_ID.test(clientSid)
  if (wantCookie && vidOk && sidOk) {
    return {
      ok: true,
      identity: 'cookie',
      visitorId: brandVisitor(clientVid),
      sessionId: brandSession(clientSid),
      geo: requestGeo(facts.cf),
      page,
    }
  }
  if (wantCookie && (clientVid !== null || clientSid !== null)) {
    return { ok: false, status: 400, reason: 'cookie-id' }
  }

  if (!facts.ip) return { ok: false, status: 403, reason: 'client-ip' }
  if (!facts.salt) return { ok: false, status: 503, reason: 'salt' }
  const day = String(startOfDay(facts.now, facts.site.timezone))
  const bucket = Math.floor(facts.now / 1_800_000)
  const visitorMessage = `${facts.ip}\n${facts.ua}\n${facts.site.id}\n${day}`
  const visitorId = await hmacHex(facts.salt, visitorMessage)
  const sessionId = await hmacHex(facts.salt, `${visitorMessage}\n${bucket}`)
  return {
    ok: true,
    identity: 'cookieless',
    visitorId: brandVisitor(visitorId),
    sessionId: brandSession(sessionId),
    geo: requestGeo(facts.cf),
    page,
  }
}

export async function gateEvent(
  env: Env,
  request: Request,
  site: Site,
  event: RawEvent,
  ua: string,
  now: number,
): Promise<GateResult> {
  const ip = clientIp(request)
  if (!(await allowIngest(env, ip, site.id, now))) return { ok: false, status: 429, reason: 'rate' }
  const cf = (request as Request & { cf?: CfGeo | null }).cf ?? null
  const decision = await decideIngest({
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    ip,
    ua,
    cf,
    now,
    site,
    scriptCookie: event.scriptCookie,
    clientVid: event.clientVid,
    clientSid: event.clientSid,
    salt: visitorSalt(env),
    pageUrl: event.pageUrl,
  })
  if (!decision.ok) return decision
  if (event.type === 'identify') return { ok: false, status: 400, reason: 'identify' }
  return {
    ok: true,
    event: {
      type: event.type,
      visitorId: decision.visitorId,
      sessionId: decision.sessionId,
      page: decision.page,
      referrer: event.referrer,
      geo: decision.geo,
      ua,
      screenWidth: event.screenWidth,
      name: event.name,
      props: event.props,
      durationMs: event.durationMs,
      now,
    },
  }
}
