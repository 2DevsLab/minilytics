import type { Context } from 'hono';
import { classify } from '../shared/sources';
import { siteOwnerActive } from './auth';
import { getSite, type AppEnv, type Site } from './env';
import { isBot, parseUA } from './lib/ua';
import { creditedSessionSql, fillVisitorStmts } from './payments';
import { belongsTo, gateEvent, type RawEvent, type TrackedEvent } from './policy';

const TYPES = new Set(['pageview', 'goal', 'outbound', 'ping', 'identify']);
const MAX_PING_MS = 10 * 60_000;

const clip = (s: unknown, n = 255): string | null =>
  typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : null;

const isId = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

export function normalizePath(pathname: string): string {
  let p = pathname || '/';
  try {
    p = decodeURI(p);
  } catch {}
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.slice(0, 500);
}

function stripWww(h: string) {
  return h.replace(/^www\./, '').toLowerCase();
}

export function parseEvent(raw: string): { ok: false; status: 400 } | { ok: true; event: RawEvent } {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400 };
  }
  if (!body || typeof body !== 'object' || !isId(body.w) || typeof body.t !== 'string' || !TYPES.has(body.t)) {
    return { ok: false, status: 400 };
  }
  const type = body.t as RawEvent['type'];
  const props = body.p && typeof body.p === 'object' ? (body.p as Record<string, unknown>) : null;
  return {
    ok: true,
    event: {
      siteId: body.w,
      type,
      pageUrl: typeof body.u === 'string' ? body.u : '',
      referrer: typeof body.r === 'string' && body.r ? body.r : null,
      scriptCookie: body.ck === 1 || body.ck === true,
      clientVid: typeof body.vid === 'string' ? body.vid : null,
      clientSid: typeof body.sid === 'string' ? body.sid : null,
      screenWidth: typeof body.sw === 'number' ? body.sw : null,
      name: type === 'goal' ? clip(body.n, 64) : type === 'outbound' ? clip(body.n, 500) : null,
      props,
      durationMs: type === 'ping' ? Math.max(0, Math.min(MAX_PING_MS, Math.round(Number(body.d) || 0))) : null,
    },
  };
}

export async function handleEvent(c: Context<AppEnv>) {
  const raw = await c.req.text();
  if (raw.length > 8192) return c.body(null, 413);
  const parsed = parseEvent(raw);
  if (!parsed.ok) return c.body(null, parsed.status);
  const ua = c.req.header('user-agent') ?? '';
  if (isBot(ua)) return c.body(null, 202);

  const site = await getSite(c.env.DB, parsed.event.siteId);
  if (!site) return c.body(null, 404);
  // Hosted mode: stop recording when the owner's plan has ended (quietly, so their site never shows errors).
  if (!siteOwnerActive(c.env, site)) return c.body(null, 202);

  const gate = await gateEvent(c.env, c.req.raw, site, parsed.event, ua, Date.now());
  if (!gate.ok) return c.body(null, gate.status);
  await ingest(c.env.DB, site, gate.event);
  return c.body(null, 202);
}

export async function ingest(db: D1Database, site: Site, event: TrackedEvent) {
  const path = normalizePath(event.page.pathname);
  const { type, visitorId, sessionId } = event;

  if (type === 'ping') {
    await db
      .prepare('UPDATE sessions SET duration = duration + ?, last_seen_at = ? WHERE site_id = ? AND id = ?')
      .bind(event.durationMs ?? 0, event.now, site.id, sessionId)
      .run();
    return;
  }

  if ((type === 'goal' || type === 'outbound') && !event.name) return;

  const existing = await db.prepare('SELECT 1 FROM sessions WHERE site_id = ? AND id = ?').bind(site.id, sessionId).first();

  const stmts: D1PreparedStatement[] = [];
  if (!existing) stmts.push(...newSession(db, site, event, path));

  if (type === 'pageview') {
    if (existing) {
      stmts.push(
        db
          .prepare('UPDATE sessions SET pageviews = pageviews + 1, exit_page = ?, last_seen_at = ? WHERE site_id = ? AND id = ?')
          .bind(path, event.now, site.id, sessionId),
      );
    }
    stmts.push(insertEvent(db, site.id, sessionId, visitorId, event.now, 'pageview', null, path, null));
    stmts.push(...claimPayment(db, site.id, visitorId, event.page, event.now));
  } else if (type === 'goal') {
    const props = event.props ? JSON.stringify(event.props).slice(0, 1000) : null;
    stmts.push(
      db.prepare('UPDATE sessions SET goals = goals + 1, last_seen_at = ? WHERE site_id = ? AND id = ?').bind(event.now, site.id, sessionId),
      insertEvent(db, site.id, sessionId, visitorId, event.now, 'goal', event.name, path, props),
    );
  } else if (type === 'outbound') {
    stmts.push(
      db.prepare('UPDATE sessions SET last_seen_at = ? WHERE site_id = ? AND id = ?').bind(event.now, site.id, sessionId),
      insertEvent(db, site.id, sessionId, visitorId, event.now, 'outbound', event.name, path, null),
    );
  }
  if (stmts.length) await db.batch(stmts);
}

/**
 * Dodo sends buyers back to your return URL with ?payment_id=pay_... . Seeing that on a pageview tells us
 * exactly which visitor made the payment, even when the checkout had no metadata.
 */
function claimPayment(db: D1Database, siteId: string, vid: string, url: URL, now: number): D1PreparedStatement[] {
  const paymentId = url.searchParams.get('payment_id') ?? url.searchParams.get('subscription_id');
  if (!paymentId || !/^(pay|sub)_[\w-]{4,64}$/.test(paymentId)) return [];
  return [
    db
      .prepare('INSERT OR IGNORE INTO payment_claims (site_id, payment_id, visitor_id, ts) VALUES (?, ?, ?, ?)')
      .bind(siteId, paymentId, vid, now),
    // The webhook usually arrives first; link that payment now if nothing else already did.
    db
      .prepare(
        `UPDATE payments SET visitor_id = ?, matched_by = 'return_page',
           session_id = (${creditedSessionSql()})
         WHERE site_id = ? AND (id = ? OR subscription_id = ?) AND visitor_id IS NULL`,
      )
      .bind(vid, siteId, vid, now + 60_000, siteId, paymentId, paymentId),
    ...fillVisitorStmts(db, siteId, vid, now, { kind: 'payment', paymentId }),
  ];
}

function insertEvent(
  db: D1Database,
  siteId: string,
  sid: string,
  vid: string,
  ts: number,
  type: string,
  name: string | null,
  path: string,
  props: string | null,
) {
  return db
    .prepare('INSERT INTO events (site_id, session_id, visitor_id, ts, type, name, path, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(siteId, sid, vid, ts, type, name, path, props);
}

function newSession(db: D1Database, site: Site, event: TrackedEvent, path: string): D1PreparedStatement[] {
  let referrer: string | null = null;
  let referrerDomain: string | null = null;
  if (event.referrer) {
    try {
      const r = new URL(event.referrer);
      // Navigation between your own pages/subdomains is not a referral.
      if (/^https?:$/.test(r.protocol) && !belongsTo(r.hostname, site.domain)) {
        referrerDomain = stripWww(r.hostname);
        referrer = (r.hostname + normalizePath(r.pathname)).slice(0, 500);
      }
    } catch {
      // android-app://com.google.android.gm and friends
      const m = /^android-app:\/\/([\w.]+)/.exec(event.referrer);
      if (m) referrerDomain = m[1];
    }
  }
  const q = event.page.searchParams;
  const utm = {
    source: clip(q.get('utm_source'), 100),
    medium: clip(q.get('utm_medium'), 100),
    campaign: clip(q.get('utm_campaign'), 200),
    term: clip(q.get('utm_term'), 200),
    content: clip(q.get('utm_content'), 200),
  };
  const ref = clip(q.get('ref') ?? q.get('via'), 100);
  const { source, channel } = classify({ referrerDomain, utmSource: utm.source, utmMedium: utm.medium, ref });
  const { browser, os, device } = parseUA(event.ua, event.screenWidth || undefined);
  const pageviews = event.type === 'pageview' ? 1 : 0;
  const { geo } = event;

  return [
    db.prepare('INSERT OR IGNORE INTO visitors (site_id, id, first_seen) VALUES (?, ?, ?)').bind(site.id, event.visitorId, event.now),
    db
      .prepare(
        `INSERT OR IGNORE INTO sessions (site_id, id, visitor_id, started_at, last_seen_at, pageviews, hostname, entry_page, exit_page,
          referrer, referrer_domain, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref,
          country, region, city, browser, os, device, lat, lon)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        site.id,
        event.sessionId,
        event.visitorId,
        event.now,
        event.now,
        stripWww(event.page.hostname),
        path,
        path,
        referrer,
        referrerDomain,
        source,
        channel,
        utm.source,
        utm.medium,
        utm.campaign,
        utm.term,
        utm.content,
        ref,
        geo.country,
        geo.region,
        geo.city,
        browser,
        os,
        device,
        geo.lat,
        geo.lon,
      ),
    // Separate statement so concurrent first events (pageview + goal racing) never double count.
    ...(pageviews
      ? [db.prepare('UPDATE sessions SET pageviews = pageviews + 1 WHERE site_id = ? AND id = ?').bind(site.id, event.sessionId)]
      : []),
  ];
}
