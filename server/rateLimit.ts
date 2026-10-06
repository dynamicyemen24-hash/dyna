/**
 * Rate limiting for the pre-authentication surface.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The per-account lockout in `passwords.ts` bounds guessing AGAINST ONE USER
 * (5 attempts, then a widening window). It does not bound an attacker who
 * sprays one password across hundreds of usernames, and it does not bound the
 * COST of being attacked: every `/api/auth/login` runs PBKDF2 at 100,000
 * iterations before deciding the password is wrong, so a flood of logins is
 * also a CPU-exhaustion attack whether or not any guess succeeds.
 *
 * So two independent budgets, per IP, per route:
 *
 *   1. FAILURE budget — only 401/403 responses consume it. A legitimate
 *      operator who signs in all day never approaches it; an attacker gets a
 *      bounded number of guesses per window regardless of how many accounts
 *      they rotate through.
 *   2. REQUEST budget — every request counts. This is the CPU ceiling: it is
 *      generous enough for any real till floor and useless as an attack tool.
 *
 * ── WHY IN-MEMORY ────────────────────────────────────────────────────────────
 * The Express server is a single process; a Map is the honest data structure
 * for a single process, and adding Redis to a product that already runs
 * PostgreSQL would be a new failure mode to protect the limiter itself. The
 * public production front door is the Cloudflare Worker, which carries its own
 * copy of this logic — see the note there on isolate locality.
 *
 * ── WHY THE WINDOW IS READ FROM THE ENVIRONMENT ──────────────────────────────
 * The test suite deliberately exhausts a budget to prove the refusal, and it
 * must not wait five minutes to prove the window reopens. Constants would make
 * that test either slow or unassertable.
 *
 * A lockout must never become a bypass: reaching 429 changes NOTHING about how
 * an authenticated session behaves, and no route stops requiring a session
 * because a caller was rate-limited.
 */
import type { Request, Response, NextFunction } from 'express';

const envInt = (name: string, dflt: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

/** Limiter configuration, re-read per request so tests can set it before import. */
export const rateLimitConfig = {
  /** Sliding window length. Default 5 minutes. */
  get windowMs(): number { return envInt('DYPOS_AUTH_RATE_WINDOW_MS', 5 * 60_000); },
  /** Failed auth attempts (401/403) allowed per window per IP per route. */
  get maxFailures(): number { return envInt('DYPOS_AUTH_RATE_MAX_FAILURES', 15); },
  /** Total requests allowed per window per IP per route (the CPU ceiling). */
  get maxRequests(): number { return envInt('DYPOS_AUTH_RATE_MAX_REQUESTS', 120); },
};

interface Bucket {
  windowStart: number;
  requests: number;
  failures: number;
}

/**
 * Keyed by `route|ip`. Route is part of the key so a burst of MFA guesses does
 * not spend the login budget and vice versa — they are different attacks and
 * are diagnosed from different counters.
 */
const buckets = new Map<string, Bucket>();

/**
 * Bounded memory. An attacker who rotates source IPs would otherwise grow this
 * Map without limit; past the ceiling the oldest window is dropped wholesale,
 * which briefly forgives one IP in exchange for never exhausting the process.
 */
const MAX_BUCKETS = 50_000;

/** Test hook: forget every window. Never called by a route. */
export function resetRateLimits(): void {
  buckets.clear();
}

function sweepExpired(now: number): void {
  const windowMs = rateLimitConfig.windowMs;
  for (const [key, b] of buckets) {
    if (now - b.windowStart >= windowMs) buckets.delete(key);
  }
}

let lastSweep = 0;

function bucketFor(key: string, now: number): Bucket {
  let b = buckets.get(key);
  const windowMs = rateLimitConfig.windowMs;
  if (!b || now - b.windowStart >= windowMs) {
    b = { windowStart: now, requests: 0, failures: 0 };
    buckets.set(key, b);
  }
  // Amortised sweep: one full pass at most every window length.
  if (now - lastSweep >= windowMs) {
    lastSweep = now;
    sweepExpired(now);
  }
  if (buckets.size > MAX_BUCKETS) sweepExpired(now);
  if (buckets.size > MAX_BUCKETS) buckets.clear();
  return b;
}

const clientIp = (req: Request): string =>
  (req.headers['cf-connecting-ip'] || req.ip || 'unknown').toString().slice(0, 64);

/**
 * Middleware factory for one route. `route` is the bucket label, not the path —
 * the path is fixed per registration, and a label survives a route rename.
 */
export function authRateLimit(route: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // `DYPOS_AUTH_RATE_LIMIT=off` — for load tests that must measure the
    // application rather than the limiter. Off by default; the limiter is on.
    if (process.env.DYPOS_AUTH_RATE_LIMIT === 'off') return next();

    const now = Date.now();
    const key = `${route}|${clientIp(req)}`;
    const b = bucketFor(key, now);

    const retryAfter = Math.max(
      1, Math.ceil((b.windowStart + rateLimitConfig.windowMs - now) / 1000));

    if (b.failures >= rateLimitConfig.maxFailures || b.requests >= rateLimitConfig.maxRequests) {
      res.setHeader('retry-after', String(retryAfter));
      res.status(429).json({
        error: 'عدد كبير من المحاولات — أعد المحاولة لاحقاً',
      });
      return;
    }

    b.requests += 1;

    // Failures are counted from the RESPONSE, so the budget reflects what the
    // caller actually got. Only authentication verdicts consume it: 400 is a
    // malformed request (a bug or a probe, not a guess), and 429 must never
    // feed itself.
    res.on('finish', () => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        const live = buckets.get(key);
        if (live) live.failures += 1;
      }
    });

    next();
  };
}
