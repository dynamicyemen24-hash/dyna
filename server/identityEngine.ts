export type IdentityDecisionState =
  | 'VERIFIED_EXISTING_TENANT'
  | 'PENDING_VERIFICATION'
  | 'NEW_TENANT'
  | 'EXISTING_TENANT_NO_BRANCH'
  | 'EXISTING_USER_NO_ACCESS'
  | 'AMBIGUOUS_IDENTITY';

export interface CanonicalTenantRef {
  tenantId: string;
  tenantName: string;
  normalizedName: string;
  status: 'active' | 'pending' | 'disabled';
  enrollmentCode?: string;
  branchCount: number;
}

export interface CanonicalUserRef {
  userId: string;
  tenantId: string;
  username: string;
  normalizedUsername: string;
  email?: string;
  normalizedEmail?: string;
  phone?: string;
  normalizedPhone?: string;
  status: 'active' | 'pending' | 'disabled' | 'locked';
}

export interface CanonicalBranchRef {
  branchId: string;
  tenantId: string;
  name: string;
  normalizedName: string;
  status: 'active' | 'disabled';
}

export interface DeviceTrustRef {
  deviceId: string;
  tenantId: string;
  userId?: string;
  fingerprint: string;
  status: 'trusted' | 'pending' | 'revoked';
}

export interface IdentityResolutionInput {
  tenantName?: string;
  tenantCode?: string;
  email?: string;
  phone?: string;
  username?: string;
  branchName?: string;
  deviceFingerprint?: string;
  existingTenants: CanonicalTenantRef[];
  existingUsers: CanonicalUserRef[];
  existingBranches: CanonicalBranchRef[];
  deviceTrust: DeviceTrustRef[];
  subscriptionStatus?: 'active' | 'trial' | 'expired' | 'pending';
}

export interface IdentityResolutionState {
  state: IdentityDecisionState;
  tenantId?: string;
  userId?: string;
  branchId?: string;
  reason: string;
  proofRequired?: string[];
  confidence: number;
}

const normalize = (value?: string) =>
  (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ').normalize('NFKC');

const hasStrongMatch = (a?: string, b?: string) => {
  const aa = normalize(a);
  const bb = normalize(b);
  return !!aa && !!bb && aa === bb;
};

export function resolveIdentityIntent(input: IdentityResolutionInput): IdentityResolutionState {
  const tenantName = input.tenantName ?? '';
  const tenantCode = input.tenantCode ?? '';
  const username = input.username ?? '';
  const email = normalize(input.email);
  const phone = normalize(input.phone);
  const branchName = normalize(input.branchName);
  const deviceFingerprint = normalize(input.deviceFingerprint);

  const matchedTenant = input.existingTenants.find((tenant) => {
    if (tenantCode && tenant.enrollmentCode) {
      if (normalize(tenant.enrollmentCode) === normalize(tenantCode)) return true;
    }
    return hasStrongMatch(tenant.tenantName, tenantName)
      || hasStrongMatch(tenant.normalizedName, normalize(tenantName));
  });

  const matchedUser = input.existingUsers.find((user) => {
    const sameUsername = hasStrongMatch(user.username, username) || hasStrongMatch(user.normalizedUsername, normalize(username));
    const sameEmail = hasStrongMatch(user.email, email) || hasStrongMatch(user.normalizedEmail, email);
    const samePhone = hasStrongMatch(user.phone, phone) || hasStrongMatch(user.normalizedPhone, phone);
    return sameUsername || sameEmail || samePhone;
  });

  const matchedBranch = input.existingBranches.find((branch) =>
    hasStrongMatch(branch.name, branchName) || hasStrongMatch(branch.normalizedName, branchName));

  const trustedDevice = input.deviceTrust.find((device) =>
    normalize(device.fingerprint) === deviceFingerprint && device.status === 'trusted');

  if (matchedTenant && matchedUser && matchedUser.tenantId === matchedTenant.tenantId) {
    if (!matchedBranch) {
      return {
        state: 'EXISTING_TENANT_NO_BRANCH',
        tenantId: matchedTenant.tenantId,
        userId: matchedUser.userId,
        reason: 'Tenant and user match, but no validated branch exists for this tenant.',
        proofRequired: ['tenant_verification', 'branch_policy_check'],
        confidence: 94,
      };
    }
    return {
      state: 'VERIFIED_EXISTING_TENANT',
      tenantId: matchedTenant.tenantId,
      userId: matchedUser.userId,
      branchId: matchedBranch.branchId,
      reason: 'The identity resolved to an existing, verified tenant and user.',
      confidence: 98,
    };
  }

  if (matchedTenant && !matchedUser) {
    return {
      state: 'PENDING_VERIFICATION',
      tenantId: matchedTenant.tenantId,
      reason: 'Tenant exists but the user identity requires proof before access is granted.',
      proofRequired: ['ownership_verification', 'user_identity_match'],
      confidence: 81,
    };
  }

  if (matchedUser && !matchedTenant) {
    return {
      state: 'EXISTING_USER_NO_ACCESS',
      userId: matchedUser.userId,
      reason: 'User exists but is not associated with a verified tenant for this onboarding flow.',
      proofRequired: ['tenant_mapping_check', 'access_policy_validation'],
      confidence: 80,
    };
  }

  if (matchedTenant && matchedUser && matchedUser.tenantId !== matchedTenant.tenantId) {
    return {
      state: 'AMBIGUOUS_IDENTITY',
      reason: 'The user and tenant are mapped to different organizations; do not auto-link.',
      proofRequired: ['tenant_user_correlation', 'session_rebinding'],
      confidence: 35,
    };
  }

  if (matchedTenant && !matchedUser && trustedDevice && trustedDevice.tenantId === matchedTenant.tenantId) {
    return {
      state: 'PENDING_VERIFICATION',
      tenantId: matchedTenant.tenantId,
      reason: 'Device is trusted for this tenant, but the user identity still requires a verified owner match.',
      proofRequired: ['device_binding_confirmation'],
      confidence: 77,
    };
  }

  if (!matchedTenant && !matchedUser && (tenantName || tenantCode || email || phone || username)) {
    return {
      state: 'NEW_TENANT',
      reason: 'No canonical tenant or user match was found; this is a new enrollment path requiring a transaction-safe setup.',
      proofRequired: ['tenant_enrollment', 'subscription_setup', 'owner_user', 'default_branch'],
      confidence: 60,
    };
  }

  return {
    state: 'AMBIGUOUS_IDENTITY',
    reason: 'Identity is not conclusive enough for automatic enrollment or access. Request explicit proof.',
    proofRequired: ['canonical_identity_reconciliation', 'manual_review'],
    confidence: 22,
  };
}

export const identityEngine = {
  normalize,
  resolveIdentityIntent,
};
