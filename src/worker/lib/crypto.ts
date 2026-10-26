const enc = new TextEncoder();

export function randomId(bytes = 12): string {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, bytes * 2);
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * Verify a Standard Webhooks signature (used by Dodo Payments).
 * Signed content is `${id}.${timestamp}.${body}`, HMAC-SHA256 with the base64 secret after `whsec_`.
 */
export async function verifyStandardWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  body: string,
  now = Date.now(),
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 5 * 60) return false;
  let key: Uint8Array<ArrayBuffer>;
  try {
    key = b64ToBytes(secret.startsWith('whsec_') ? secret.slice(6) : secret);
  } catch {
    return false;
  }
  const expected = bytesToB64(await hmac(key, `${id}.${timestamp}.${body}`));
  return signature
    .split(' ')
    .map((s) => s.split(',')[1] ?? '')
    .some((sig) => safeEqual(sig, expected));
}

/** Sign a value for the dashboard login cookie. */
export async function signToken(secret: string, value: string): Promise<string> {
  const sig = bytesToB64(await hmac(enc.encode(secret), value)).replace(/=+$/, '');
  return `${value}.${sig}`;
}

export async function verifyToken(secret: string, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const value = token.slice(0, i);
  const expected = await signToken(secret, value);
  return safeEqual(expected, token) ? value : null;
}

const PBKDF2 = /^\$pbkdf2-sha256\$i=(\d+)\$([^$]+)\$([^$]+)$/;
const PBKDF2_MAX_ITERATIONS = 2_000_000;

function timingSafeEqual(left: BufferSource, right: BufferSource): boolean {
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: BufferSource, b: BufferSource): boolean };
  return subtle.timingSafeEqual(left, right);
}

function equalBytes(candidate: Uint8Array, expected: Uint8Array): boolean {
  const left = candidate as BufferSource;
  const right = expected as BufferSource;
  if (candidate.byteLength !== expected.byteLength) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

export async function passwordMatches(secret: string, candidate: string): Promise<boolean> {
  if (secret.startsWith('$pbkdf2-sha256$')) {
    const parsed = PBKDF2.exec(secret);
    if (!parsed) return false;
    const iterations = Number(parsed[1]);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_MAX_ITERATIONS) return false;
    let salt: Uint8Array<ArrayBuffer>;
    let expected: Uint8Array<ArrayBuffer>;
    try {
      salt = b64ToBytes(parsed[2]);
      expected = b64ToBytes(parsed[3]);
    } catch {
      return false;
    }
    if (expected.byteLength === 0) return false;
    const key = await crypto.subtle.importKey('raw', enc.encode(candidate), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, expected.byteLength * 8);
    return equalBytes(new Uint8Array(bits), expected);
  }
  return equalBytes(await sha256(secret), await sha256(candidate));
}
