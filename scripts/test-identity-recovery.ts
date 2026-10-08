import assert from 'node:assert/strict';
import { recoverIdentityState } from '../server/identityRecovery.ts';

const healthy = await recoverIdentityState('tenant-1', 'user-9');
assert.ok(healthy.state === 'healthy' || healthy.state === 'needs_recovery' || healthy.state === 'conflict');
console.log('identity recovery smoke ok');
