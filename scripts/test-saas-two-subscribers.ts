/**
 * SaaS E2E — subscriber one is provisioned, then subscriber two proves isolation.
 *
 * Run:  npx tsx scripts/test-saas-two-subscribers.ts
 *
 * ══ WHAT THIS IS FOR ════════════════════════════════════════════════════════
 * The product is sold to more than one merchant on one deployment. The only
 * property that matters: **everything subscriber one creates must be invisible
 * to subscriber two, and an offline sale must still reach the ledger.**
 *
 * Both halves of the offline claim were broken, and neither raised an error:
 *
 *   - `offlineSyncService.registerSyncHandler` was called from NOWHERE, so
 *     `syncNow()` returned `{ outcome: 'retry' }` for every item forever. The
 *     till reported its sales as recorded; none reached the ledger.
 *   - The queue lived under ONE `localStorage` key shared by every tenant, and
 *     `localStorage` survives sign-out — so on a shared till subscriber two
 *     inherited subscriber one's unpaid invoices.
 *
 * Both were invisible to the build, the type-checker and every other suite. Only
 * an end-to-end assertion — data in for one tenant, absent for the other — can
 * tell a working offline queue from an inert one.
 *
 * ══ WHY IT DRIVES REAL POSTGRESQL ═══════════════════════════════════════════
 * A mocked pool would agree with whatever the code assumed. Isolation is the one
 * property a mock cannot have, so this runs against the real database with real
 * signed tokens and the real route registry.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import express from 'express';

import { issueSessionToken } from '../server/sessions.ts';
import { hashPassword } from '../server/passwords.ts';
import { makeId } from '../server/apiHelpers.ts';

/** Subscriber one: fully provisioned with business data. */
const TENANT_ONE = 'saas-subscriber-one';
/** Subscriber two: a real second customer on the same deployment. */
const TENANT_TWO = 'saas-subscriber-two';

/**
 * A value planted in subscriber one's data that must never appear in
 * subscriber two's view.
 *
 * A distinctive string rather than a count, so a leak is identified exactly
 * instead of inferred from a number that could differ for unrelated reasons. It
 * appears in a branch name, a customer phone and a product barcode, so a leak
 * through any one of those routes is caught.
 */
const SECRET_MARKER = 'MARKER-ONLY-SUBSCRIBER-ONE-7731';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function section(title: string): void { console.log(`\n${title}`); }

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 20_000,
});

type Call = { status: number; data: Record<string, unknown> };

async function call(
  base: string,
  token: string,
  path: string,
  body?: unknown,
): Promise<Call> {
  const res = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* a non-JSON body is still a response */
  }
  return { status: res.status, data };
}

/** Walks any response for the marker, whatever shape the payload takes. */
function containsMarker(value: unknown): boolean {
  return JSON.stringify(value ?? null).includes(SECRET_MARKER);
}