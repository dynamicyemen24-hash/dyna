import assert from 'node:assert/strict';
import { resolveIdentityIntent, type IdentityResolutionInput } from '../server/identityEngine.ts';

const inputBase: IdentityResolutionInput = {
  tenantName: 'Smart Ports',
  tenantCode: 'SP-001',
  email: 'ops@smartports.example',
  phone: '+966500000001',
  username: 'ops.smart',
  branchName: 'المركز الرئيسي',
  deviceFingerprint: 'device-fp-001',
  existingTenants: [
    { tenantId: 'tenant-1', tenantName: 'Smart Ports', normalizedName: 'smart ports', status: 'active', enrollmentCode: 'SP-001', branchCount: 1 },
  ],
  existingUsers: [
    { userId: 'user-9', tenantId: 'tenant-1', username: 'ops.smart', normalizedUsername: 'ops.smart', email: 'ops@smartports.example', normalizedEmail: 'ops@smartports.example', phone: '+966500000001', normalizedPhone: '+966500000001', status: 'active' },
  ],
  existingBranches: [
    { branchId: 'branch-1', tenantId: 'tenant-1', name: 'المركز الرئيسي', normalizedName: 'المركز الرئيسي', status: 'active' },
  ],
  deviceTrust: [],
};

const verified = resolveIdentityIntent(inputBase);
assert.equal(verified.state, 'VERIFIED_EXISTING_TENANT');

const pending = resolveIdentityIntent({
  ...inputBase,
  email: 'new@example.com',
  existingUsers: [],
  existingTenants: [
    { tenantId: 'tenant-1', tenantName: 'Smart Ports', normalizedName: 'smart ports', status: 'active', enrollmentCode: 'SP-001', branchCount: 1 },
  ],
});
assert.equal(pending.state, 'PENDING_VERIFICATION');

const newTenant = resolveIdentityIntent({
  ...inputBase,
  tenantName: 'Al Noor Retail',
  tenantCode: 'AN-NEW',
  email: 'owner@alnoor.example',
  phone: '+966500000099',
  username: 'owner.alnoor',
  existingTenants: [],
  existingUsers: [],
  existingBranches: [],
});
assert.equal(newTenant.state, 'NEW_TENANT');

const noBranch = resolveIdentityIntent({
  ...inputBase,
  existingBranches: [],
  existingUsers: [
    { userId: 'user-2', tenantId: 'tenant-1', username: 'ops.smart', normalizedUsername: 'ops.smart', email: 'ops@smartports.example', normalizedEmail: 'ops@smartports.example', phone: '+966500000001', normalizedPhone: '+966500000001', status: 'active' },
  ],
});
assert.equal(noBranch.state, 'EXISTING_TENANT_NO_BRANCH');

console.log('identity-engine smoke tests passed');
