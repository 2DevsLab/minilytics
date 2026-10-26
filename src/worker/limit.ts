import type { IngestLimiter } from './env'

export const INGEST_IP_LIMIT = 60
export const INGEST_SITE_LIMIT = 600
export const INGEST_WINDOW_MS = 60_000

interface Bucket {
  windowStart: number
  left: number
}

const buckets = new Map<string, Bucket>()

function defaultCache(): Cache | null {
  const store = (globalThis as { caches?: { default?: Cache } }).caches
  return store?.default ?? null
}

function markUrl(scope: string, id: string, windowStart: number): string {
  return `https://minilytics-rl.invalid/${scope}/${encodeURIComponent(id)}/${windowStart}`
}

async function cachedUsed(scope: string, id: string, windowStart: number): Promise<number> {
  const cache = defaultCache()
  if (!cache) return 0
  try {
    const hit = await cache.match(markUrl(scope, id, windowStart))
    if (!hit) return 0
    const body = (await hit.json()) as { used?: unknown }
    return typeof body.used === 'number' ? body.used : 0
  } catch {
    return 0
  }
}

async function publishUsed(scope: string, id: string, windowStart: number, used: number): Promise<void> {
  const cache = defaultCache()
  if (!cache) return
  try {
    await cache.put(
      markUrl(scope, id, windowStart),
      new Response(JSON.stringify({ used }), { headers: { 'cache-control': 'max-age=60' } }),
    )
  } catch {
    // The cached count is a hint. A cache miss still leaves the local bucket in place.
  }
}

function bucket(key: string, windowStart: number, ceiling: number): Bucket {
  const current = buckets.get(key)
  if (current && current.windowStart === windowStart) return current
  const fresh = { windowStart, left: ceiling }
  buckets.set(key, fresh)
  return fresh
}

export async function allowIngest(
  env: { INGEST_IP?: IngestLimiter; INGEST_SITE?: IngestLimiter },
  ip: string | null,
  siteId: string,
  now: number,
): Promise<boolean> {
  if (env.INGEST_IP && env.INGEST_SITE) {
    const ipOk = (await env.INGEST_IP.limit({ key: ip ?? 'unknown' })).success
    if (!ipOk) return false
    return (await env.INGEST_SITE.limit({ key: siteId })).success
  }

  const windowStart = now - (now % INGEST_WINDOW_MS)
  const ipId = ip ?? 'unknown'
  const [ipUsed, siteUsed] = await Promise.all([
    cachedUsed('ip', ipId, windowStart),
    cachedUsed('site', siteId, windowStart),
  ])
  if (ipUsed >= INGEST_IP_LIMIT || siteUsed >= INGEST_SITE_LIMIT) return false

  const ipBucket = bucket(`ip:${ipId}`, windowStart, INGEST_IP_LIMIT)
  const siteBucket = bucket(`site:${siteId}`, windowStart, INGEST_SITE_LIMIT)
  if (ipBucket.left <= 0 || siteBucket.left <= 0) return false
  ipBucket.left -= 1
  siteBucket.left -= 1
  const nextIp = INGEST_IP_LIMIT - ipBucket.left
  const nextSite = INGEST_SITE_LIMIT - siteBucket.left
  if (nextIp > ipUsed) await publishUsed('ip', ipId, windowStart, nextIp)
  if (nextSite > siteUsed) await publishUsed('site', siteId, windowStart, nextSite)
  return true
}
