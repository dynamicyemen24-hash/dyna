/**
 * Credential portability between the two runtimes.
 *
 * Run:  npm run test:credentials
 *
 * ══ WHAT THIS IS FOR ════════════════════════════════════════════════════════
 * Production is served by the Cloudflare Worker (`worker/index.ts`) while every
 * credential in the database was written by the Express path
 * (`server/passwords.ts`) — via scripts/release-credentials.ts, and via both
 * password-change routes.
 *
 * Those two files each implemented PBKDF2-SHA512 independently and both looked
 * right. They disagreed on ONE thing: what the stored salt actually is. Express
 * passes the salt HEX STRING to Node's `pbkdf2`, so Node salts with those 32
 * ASCII characters; the Worker decoded the hex into 16 raw bytes.
 *
 * PBKDF2 is unlike an ordinary hash here — change one bit of the salt and the
 * whole output changes. So the two runtimes derived two unrelated keys from one
 * password, and the Worker rejected every correct password as invalid, for every
 * account, with no error anywhere. An operator's only symptom was "invalid
 * credentials", which looks like a typo and is not.
 *
 * Neither the type-checker, the bundler, lint, nor any existing suite can catch
 * this. The two functions have identical types and different behaviour, and the
 * disagreement only appears when one runtime's OUTPUT is fed to the other's
 * INPUT. So it is asserted here, in both directions, before a deploy.
 */
import { hashPassword, verifyPassword, ITERATIONS, EDGE_MAX_ITERATIONS }
  from '../server/passwords.js';
import {
  hashPasswordEdge, verifyPassword as verifyPasswordEdge, MAX_ITERATIONS,
} from '../worker/index.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const PASSWORD = 'Test-Password-123!';
/** 16 bytes, hex — the shape `randomBytes(16).toString('hex')` produces. */
const SALT_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * A syntactically valid stored hash at an arbitrary cost.
 *
 * Only its SHAPE matters here: the ceiling check runs before any comparison,
 * so a placeholder digest is enough to prove the guard refuses it. Deriving it
 * for real would be wasted work at 200,001 iterations — the point is that the
 * runtime never gets that far.
 */
const storedHashAt = (iterations: number): string =>
  edgeHash.slice(0, 127) + String(iterations % 10);

console.log('\n=== a fixed salt must derive identically in both runtimes ===');
const edgeHash = await hashPasswordEdge(PASSWORD, SALT_HEX, ITERATIONS);
check('Worker derives a 128-char PBKDF2-SHA512 digest', /^[0-9a-f]{128}$/.test(edgeHash));

/*
 * ══ THE ITERATION CEILING ═════════════════════════════════════════════════
 * Measured on the deployed Worker, not assumed:
 *
 *     100,000 -> 200
 *     210,000 -> 500 "iteration counts above 100000 are not supported"
 *
 * A stored count above the ceiling is not "slow" — it is PERMANENTLY
 * unverifiable on the edge, because the runtime throws before comparing
 * anything. So the cost has to be pinned by an assertion here, since the
 * number appears in both runtimes and drifting between them is exactly how
 * 210,000 shipped in the first place.
 */
console.log('\n=== the iteration count is portable ===');
check('ITERATIONS is at or below the runtime ceiling',
  ITERATIONS <= EDGE_MAX_ITERATIONS, `${ITERATIONS} > ${EDGE_MAX_ITERATIONS}`);
check('the Worker ceiling matches the server constant',
  MAX_ITERATIONS === EDGE_MAX_ITERATIONS,
  `worker=${MAX_ITERATIONS} server=${EDGE_MAX_ITERATIONS}`);
check('the Worker defaults to the portable cost', ITERATIONS === MAX_ITERATIONS);

// A credential stored above the ceiling must be REFUSED, loudly. Returning
// `false` would route it into the bad-password path and burn the account's
// lockout budget for a fault that is not the user's.
check('the Worker refuses to VERIFY a credential above the ceiling', await (async () => {
  try {
    await verifyPasswordEdge(PASSWORD, {
      hash: storedHashAt(EDGE_MAX_ITERATIONS * 2 + 1),
      salt: SALT_HEX,
      iterations: EDGE_MAX_ITERATIONS * 2 + 1,
    });
    return false;
  } catch { return true; }
})());

check('the Worker refuses to WRITE a credential above the ceiling', await (async () => {
  try {
    await hashPasswordEdge(PASSWORD, SALT_HEX, EDGE_MAX_ITERATIONS + 1);
    return false;
  } catch { return true; }
})());

console.log('\n=== Express-written credential, Worker verification (PRODUCTION) ===');
const stored = await hashPassword(PASSWORD);
check('Express verifies its own hash', await verifyPassword(PASSWORD, {
  hash: stored.hash, salt: stored.salt, iterations: stored.iterations,
}));
check('Express writes at the portable cost', stored.iterations === ITERATIONS,
  `wrote ${stored.iterations}`);
check('Worker verifies an Express-written hash', await verifyPasswordEdge(PASSWORD, {
  hash: stored.hash, salt: stored.salt, iterations: stored.iterations,
}));
check('Worker rejects a wrong password', !(await verifyPasswordEdge('Wrong-Password-1!', {
  hash: stored.hash, salt: stored.salt, iterations: stored.iterations,
})));

console.log('\n=== Worker-written credential, Express verification (the reverse) ===');
check('Express verifies a Worker-written hash', await verifyPassword(PASSWORD, {
  hash: edgeHash, salt: SALT_HEX, iterations: ITERATIONS,
}));

console.log('\n=== a user rotating their own password on the edge ===');
// The path an operator actually takes: sign in on the Worker, then change the
// password there. The new hash must still verify on Express afterwards, or the
// account locks itself out of the on-premise path the moment it rotates.
const rotated = await hashPasswordEdge('Rotated-Password-7!', stored.salt, ITERATIONS);
check('Express verifies a hash written by the edge rotation', await verifyPassword('Rotated-Password-7!', {
  hash: rotated, salt: stored.salt, iterations: ITERATIONS,
}));
check('the previous password no longer verifies', !(await verifyPasswordEdge(PASSWORD, {
  hash: rotated, salt: stored.salt, iterations: ITERATIONS,
})));

console.log(`\n${fail === 0 ? '✔' : '✘'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);