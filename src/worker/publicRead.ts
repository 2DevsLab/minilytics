import type { Context, Hono } from 'hono';
import { DEFAULT_SHARE_PERIOD, SHARE_PERIODS, type SharePeriod } from '../shared/publicStats';
import { flagOn, type AppEnv, type SiteRow } from './env';
import { belongsTo, publicStatsOn } from './policy';
import { loadLive, loadShare } from './stats';

const PUBLIC_CACHE = 'public, s-maxage=60, stale-while-revalidate=300';

function workerCache(): Cache {
  // DOM CacheStorage hides the Workers `caches.default` binding.
  return (caches as unknown as { default: Cache }).default;
}

interface PublicSite {
  id: string;
  domain: string;
  timezone: string;
  created_at: number;
  public_stats: boolean;
  cookie_visitors: boolean;
}

async function loadPublicSite(db: D1Database, siteId: string): Promise<PublicSite | null> {
  const row = await db
    .prepare('SELECT id, domain, timezone, created_at, public_stats, cookie_visitors FROM sites WHERE id = ?')
    .bind(siteId)
    .first<Pick<SiteRow, 'id' | 'domain' | 'timezone' | 'created_at' | 'public_stats' | 'cookie_visitors'>>();
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    timezone: row.timezone,
    created_at: row.created_at,
    public_stats: flagOn(row.public_stats),
    cookie_visitors: flagOn(row.cookie_visitors),
  };
}

function notFound(): Response {
  return Response.json({ error: 'not found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
}

function sharePeriod(url: URL): SharePeriod | null {
  const raw = url.searchParams.get('period');
  if (raw == null || raw === '') return DEFAULT_SHARE_PERIOD;
  return (SHARE_PERIODS as readonly string[]).includes(raw) ? (raw as SharePeriod) : null;
}

function applyPublicCors(response: Response, originHeader: string | null, siteDomain: string): Response {
  const headers = new Headers(response.headers);
  headers.set('vary', 'Origin');
  if (originHeader) {
    let host: string | null = null;
    try {
      host = new URL(originHeader).hostname;
    } catch {
      host = null;
    }
    if (host && belongsTo(host, siteDomain)) headers.set('access-control-allow-origin', originHeader);
  }
  return new Response(response.body, { status: response.status, headers });
}

async function handleLiveOptions(c: Context<AppEnv>): Promise<Response> {
  const site = await loadPublicSite(c.env.DB, c.req.param('siteId')!);
  const headers = new Headers({ 'cache-control': 'no-store', vary: 'Origin' });
  const origin = c.req.header('origin') ?? null;
  if (site && origin) {
    try {
      if (belongsTo(new URL(origin).hostname, site.domain)) {
        headers.set('access-control-allow-origin', origin);
        headers.set('access-control-allow-methods', 'GET, OPTIONS');
      }
    } catch {
      // Leave the preflight without an allow-origin header.
    }
  }
  return new Response(null, { status: 204, headers });
}

async function handlePublicGet(c: Context<AppEnv>, kind: 'live' | 'share'): Promise<Response> {
  const site = await loadPublicSite(c.env.DB, c.req.param('siteId')!);
  const origin = c.req.header('origin') ?? null;
  if (!site) return notFound();
  if (!publicStatsOn(site)) return applyPublicCors(notFound(), origin, site.domain);
  const url = new URL(c.req.url);
  let period: SharePeriod = DEFAULT_SHARE_PERIOD;
  if (kind === 'share') {
    const parsed = sharePeriod(url);
    if (!parsed) return Response.json({ error: 'period must be 24h, 7d, or 30d' }, { status: 400, headers: { 'cache-control': 'no-store' } });
    period = parsed;
  }
  const cache = workerCache();
  const cacheKey = new Request(url.toString());
  const hit = await cache.match(cacheKey);
  if (hit) return applyPublicCors(hit, origin, site.domain);
  const now = Date.now();
  const body = kind === 'live' ? await loadLive(c.env.DB, site, now) : await loadShare(c.env.DB, site, period, now);
  const stored = Response.json(body, { headers: { 'cache-control': PUBLIC_CACHE } });
  await cache.put(cacheKey, stored.clone());
  return applyPublicCors(stored, origin, site.domain);
}

export function publicRoutes(app: Hono<AppEnv>) {
  app.options('/api/public/:siteId/live', handleLiveOptions);
  app.get('/api/public/:siteId/live', (c) => handlePublicGet(c, 'live'));
  app.get('/api/public/:siteId/share', (c) => handlePublicGet(c, 'share'));
}

export async function forgetPublicReads(origin: string, siteId: string): Promise<void> {
  const cache = workerCache();
  const urls = [
    `${origin}/api/public/${siteId}/live`,
    `${origin}/api/public/${siteId}/share`,
    ...SHARE_PERIODS.map((period) => `${origin}/api/public/${siteId}/share?period=${period}`),
  ];
  await Promise.all(urls.map((url) => cache.delete(url)));
}
