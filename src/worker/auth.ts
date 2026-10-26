import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Env, Site } from './env';
import { passwordMatches, randomId, signToken, verifyToken } from './lib/crypto';
import { clientIp } from './policy';

/**
 * Two modes:
 *  - self-hosted (default): one owner, password login (ADMIN_PASSWORD), sees every site.
 *  - hosted: set GOOGLE_CLIENT_ID/SECRET; anyone can sign in with Google, pays for a plan and sees only their own sites.
 *    Emails in ADMIN_EMAILS never pay and also own the sites created before accounts existed.
 */
export const isHosted = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export interface User {
  id: string;
  email: string | null;
  name: string | null;
  avatar: string | null;
  admin: boolean;
  paid: boolean;
  plan_status: string;
  plan_until: number | null;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
  plan_status: string;
  plan_until: number | null;
}

const SELF_HOSTED_OWNER: User = {
  id: 'admin',
  email: null,
  name: null,
  avatar: null,
  admin: true,
  paid: true,
  plan_status: 'active',
  plan_until: null,
};

export const AUTH_COOKIE = 'ml_auth';
const AUTH_DAYS = 30;
const OAUTH_COOKIE = 'ml_oauth';

export function isAdminEmail(env: Env, email: string | null | undefined) {
  if (!email) return false;
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

/** Paid and not expired. plan_until NULL with an active plan means a one-time (lifetime) payment. */
export function planActive(status: string | null | undefined, until: number | null | undefined, now = Date.now()) {
  if (until) return until > now;
  return status === 'active';
}

/** Should events for this site still be recorded? (Self-hosted: always. Hosted: only while the owner has access.) */
export function siteOwnerActive(env: Env, site: Site & { owner_email?: string | null; owner_plan_status?: string | null; owner_plan_until?: number | null }) {
  if (!isHosted(env) || !site.owner_id) return true;
  return isAdminEmail(env, site.owner_email) || planActive(site.owner_plan_status, site.owner_plan_until);
}

export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export async function login(c: Context<AppEnv>) {
  if (isHosted(c.env)) return c.json({ error: 'Use "Continue with Google".' }, 400);
  if (!c.env.ADMIN_PASSWORD || !c.env.SESSION_SECRET) {
    return c.json({ error: 'Set ADMIN_PASSWORD and SESSION_SECRET (see README).' }, 500);
  }
  const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
  const ip = clientIp(c.req.raw) ?? 'unknown';
  const now = Date.now();
  const counted = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - LOGIN_WINDOW_MS),
    c.env.DB.prepare('INSERT INTO login_failures (ip, ts) VALUES (?, ?)').bind(ip, now),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE ip = ? AND ts > ?').bind(ip, now - LOGIN_WINDOW_MS),
  ]);
  const n = Number((counted[2]?.results?.[0] as { n: number } | undefined)?.n ?? 0);
  if (n > LOGIN_MAX_FAILURES) return c.json({ error: 'Too many wrong attempts. Try again in 15 minutes.' }, 429);
  if (!password || !(await passwordMatches(c.env.ADMIN_PASSWORD, password))) {
    await new Promise((r) => setTimeout(r, 500));
    return c.json({ error: 'Wrong password' }, 401);
  }
  await c.env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
  await setSession(c, 'admin');
  return c.json({ ok: true });
}

export async function setSession(c: Context<AppEnv>, subject: string) {
  const expires = Date.now() + AUTH_DAYS * 86_400_000;
  setCookie(c, AUTH_COOKIE, await signToken(c.env.SESSION_SECRET, `${subject}.${expires}`), {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: AUTH_DAYS * 86_400,
  });
}

export function clearSession(c: Context<AppEnv>) {
  deleteCookie(c, AUTH_COOKIE, { path: '/' });
}

export function accessConfigured(env: Env): boolean {
  if (isHosted(env)) return false;
  return !!(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
}

const ACCESS_CERT_MS = 60 * 60 * 1000;
const accessCerts = new Map<string, { at: number; keys: Map<string, CryptoKey> }>();

function accessBase(team: string): string | null {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(team)) return null;
  return `https://${team}.cloudflareaccess.com`;
}

function bytesFromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonFromBase64Url(value: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(bytesFromBase64Url(value)));
}

async function accessKeys(base: string, refresh: boolean): Promise<Map<string, CryptoKey> | null> {
  const hit = accessCerts.get(base);
  if (!refresh && hit && Date.now() - hit.at < ACCESS_CERT_MS) return hit.keys;
  let res: Response;
  try {
    res = await fetch(`${base}/cdn-cgi/access/certs`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { keys?: { kid?: string; kty?: string; n?: string; e?: string }[] } | null;
  if (!body?.keys) return null;
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys) {
    if (!jwk.kid || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) continue;
    try {
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']),
      );
    } catch {}
  }
  accessCerts.set(base, { at: Date.now(), keys });
  return keys;
}

async function verifyAccess(env: Env, jwt: string): Promise<boolean> {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) return false;
  let header: { alg?: unknown; kid?: unknown };
  let claims: { iss?: unknown; aud?: unknown; exp?: unknown };
  try {
    header = jsonFromBase64Url(parts[0]) as typeof header;
    claims = jsonFromBase64Url(parts[1]) as typeof claims;
  } catch {
    return false;
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
  const base = accessBase(env.CF_ACCESS_TEAM_DOMAIN);
  if (!base || claims.iss !== base) return false;
  const aud = claims.aud;
  const audOk = aud === env.CF_ACCESS_AUD || (Array.isArray(aud) && aud.includes(env.CF_ACCESS_AUD));
  if (!audOk || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return false;
  let keys = await accessKeys(base, false);
  let key = keys?.get(header.kid);
  if (!key) {
    keys = await accessKeys(base, true);
    key = keys?.get(header.kid);
  }
  if (!key) return false;
  try {
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytesFromBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}

export async function currentUser(c: Context<AppEnv>): Promise<User | null> {
  if (accessConfigured(c.env)) {
    const jwt = c.req.header('Cf-Access-Jwt-Assertion');
    if (jwt && (await verifyAccess(c.env, jwt))) return SELF_HOSTED_OWNER;
  }
  if (!c.env.SESSION_SECRET) return null;
  const value = await verifyToken(c.env.SESSION_SECRET, getCookie(c, AUTH_COOKIE));
  if (!value) return null;
  const parts = value.split('.');
  if (Number(parts[parts.length - 1]) <= Date.now()) return null;
  // Self-hosted password session: "admin.<expires>"
  if (parts[0] === 'admin') return isHosted(c.env) ? null : SELF_HOSTED_OWNER;
  // Hosted Google session: "u:<userId>.<expires>"
  if (!parts[0].startsWith('u:') || !isHosted(c.env)) return null;
  const row = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(parts[0].slice(2)).first<UserRow>();
  if (!row) return null;
  const admin = isAdminEmail(c.env, row.email);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar: row.avatar,
    admin,
    paid: admin || planActive(row.plan_status, row.plan_until),
    plan_status: row.plan_status,
    plan_until: row.plan_until,
  };
}

export const requireUser = async (c: Context<AppEnv>, next: Next) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', user);
  await next();
};

/** SQL that limits `sites s` to the ones this user may see. */
export function siteAccessSql(env: Env, user: User): { sql: string; params: unknown[] } {
  if (!isHosted(env)) return { sql: '1 = 1', params: [] };
  if (user.admin) return { sql: '(s.owner_id = ? OR s.owner_id IS NULL)', params: [user.id] };
  return { sql: 's.owner_id = ?', params: [user.id] };
}

// ---------- Google sign-in (OAuth 2.0 authorization code flow)

function redirectUri(c: Context<AppEnv>) {
  return `${new URL(c.req.url).origin}/api/auth/google/callback`;
}

export async function googleStart(c: Context<AppEnv>) {
  if (!isHosted(c.env)) return c.text('Google sign-in is not configured', 404);
  const state = randomId(16);
  setCookie(c, OAUTH_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/api/auth/google',
    maxAge: 600,
  });
  const q = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
}

function decodeJwtPayload(jwt: string): Record<string, any> {
  const part = jwt.split('.')[1] ?? '';
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))));
}

export async function googleCallback(c: Context<AppEnv>) {
  if (!isHosted(c.env)) return c.text('Google sign-in is not configured', 404);
  const fail = (msg: string) => c.redirect(`/?login_error=${encodeURIComponent(msg)}`);
  const state = c.req.query('state');
  const expected = getCookie(c, OAUTH_COOKIE);
  deleteCookie(c, OAUTH_COOKIE, { path: '/api/auth/google' });
  if (!state || !expected || state !== expected) return fail('Sign-in expired, please try again.');
  const code = c.req.query('code');
  if (!code) return fail(c.req.query('error') ?? 'Sign-in was cancelled.');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(c),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) return fail('Google sign-in failed.');
  const tokens = await res.json<{ id_token?: string }>();
  if (!tokens.id_token) return fail('Google sign-in failed.');
  // The token came straight from Google over TLS, so its claims can be trusted; still check who it's for.
  const claims = decodeJwtPayload(tokens.id_token);
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issOk || claims.aud !== c.env.GOOGLE_CLIENT_ID || !claims.sub || !claims.email || claims.email_verified === false) {
    return fail('Google sign-in failed.');
  }
  const email = String(claims.email).toLowerCase();
  const now = Date.now();
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE google_sub = ? OR email = ?')
    .bind(claims.sub, email)
    .first<{ id: string }>();
  const id = existing?.id ?? randomId(10);
  const stmts = [
    existing
      ? c.env.DB.prepare('UPDATE users SET google_sub = ?, email = ?, name = ?, avatar = ? WHERE id = ?').bind(
          claims.sub,
          email,
          claims.name ?? null,
          claims.picture ?? null,
          id,
        )
      : c.env.DB.prepare('INSERT INTO users (id, google_sub, email, name, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
          id,
          claims.sub,
          email,
          claims.name ?? null,
          claims.picture ?? null,
          now,
        ),
  ];
  // The owner takes over the sites that existed before accounts were turned on.
  if (isAdminEmail(c.env, email)) stmts.push(c.env.DB.prepare('UPDATE sites SET owner_id = ? WHERE owner_id IS NULL').bind(id));
  await c.env.DB.batch(stmts);
  await setSession(c, `u:${id}`);
  // ?signup=1 lets the app record a "signup_completed" goal for brand-new accounts.
  return c.redirect(existing ? '/' : '/?signup=1');
}
