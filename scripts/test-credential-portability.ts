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
import { hashPassword, verifyPassword } from '../server/passwords.js';
import {
  hashPasswordEdge, verifyPassword as verifyPasswordEdge,
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

console.log('\n=== a fixed salt must derive identically in both runtimes ===');
const edgeHash = await hashPasswordEdge(PASSWORD, SALT_HEX, 210_000);
check('Worker derives a 128-char PBKDF2-SHA512 digest', /^[0-9a-f]{128}$/.test(edgeHash));

console.log('\n=== Express-written credential, Worker verification (PRODUCTION) ===');
const stored = await hashPassword(PASSWORD);
check('Express verifies its own hash', await verifyPassword(PASSWORD, {
  hash: stored.hash, salt: stored.salt, iterations: stored.iterations,
}));
check('Worker verifies an Express-written hash', await verifyPasswordEdge(PASSWORD, {
  hash: stored.hash, salt: stored.salt, iterations: stored.iterations,
}));
check('Worker rejects a wrong password', !(await verifyPasswordEdge('Wrong-Password-1!', {
  hash: stored.hash, salt: stored.salt, iterations: stored.iterations,
})));

console.log('\n=== Worker-written credential, Express verification (the reverse) ===');
check('Express verifies a Worker-written hash', await verifyPassword(PASSWORD, {
  hash: edgeHash, salt: SALT_HEX, iterations: 210_000,
}));

console.log('\n=== a user rotating their own password on the edge ===');
// The path an operator actually takes: sign in on the Worker, then change the
// password there. The new hash must still verify on Express afterwards, or the
// account locks itself out of the on-premise path the moment it rotates.
const rotated = await hashPasswordEdge('Rotated-Password-7!', stored.salt, 210_000);
check('Express verifies a hash written by the edge rotation', await verifyPassword('Rotated-Password-7!', {
  hash: rotated, salt: stored.salt, iterations: 210_000,
}));
check('the previous password no longer verifies', !(await verifyPasswordEdge(PASSWORD, {
  hash: rotated, salt: stored.salt, iterations: 210_000,
})));

console.log(`\n${fail === 0 ? '✔' : '✘'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);