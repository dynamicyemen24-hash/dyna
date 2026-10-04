/**
 * Signed session tokens.
 *
 * Previously the acting user travelled in an `x-dypos-user` header that the
 * client set freely, so anyone could type another operator's name and inherit
 * their permissions. The token below is an HMAC-SHA256 over the payload, keyed
 * by DYPOS_SESSION_SECRET: a caller can no longer mint an identity, only replay
 * one the server issued, and a tampered payload fails verification.
 *
 * The payload is deliberately small. Branch scope is not trusted from the token
 * either — it is re-read from RBAC on every request.
 */
import crypto from 'crypto';


const SECRET = () => {
  const s = process.env.DYPOS_SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'DYPOS_SESSION_SECRET is not set (needs at least 32 characters). ' +
      'Without it no session can be signed and every request will be rejected.',
    );
  }
  return s;
};

const b64 = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64url');

const sign = (data: string) =>
  b64(crypto.createHmac('sha256', SECRET()).update(data).digest());

export interface SessionPayload {
  /** User row id. */
  sub: string;
  username: string;
  tenantId: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
}

/** Token lifetime. Short enough that a stolen token has a small window. */
const TTL_SECONDS = Number(process.env.DYPOS_SESSION_TTL_SECONDS) || 8 * 60 * 60;

export function issueSessionToken(
  userId: string, username: string, tenantId: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: userId, username, tenantId, iat: now, exp: now + TTL_SECONDS,
  };
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export type VerifyResult =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: string };

export function verifySessionToken(token: string, now = Date.now()): VerifyResult {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing_token' };

  const dot = token.indexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed_token' };

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  const expected = sign(body);
  // Constant-time compare so the signature cannot be probed byte by byte.
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed_payload' };
  }

  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}
