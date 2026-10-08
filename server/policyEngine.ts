export type PrerequisiteDecision =
  | 'READY'
  | 'CREATE_DEFAULT_BRANCH'
  | 'REQUIRE_VERIFICATION'
  | 'REQUIRE_ADMIN'
  | 'REQUIRE_SUBSCRIPTION'
  | 'BLOCKED_BY_POLICY';

export interface PrerequisiteInput {
  tenantExists: boolean;
  tenantStatus?: 'active' | 'pending' | 'disabled';
  userExists: boolean;
  userStatus?: 'active' | 'locked' | 'disabled' | 'pending';
  branchExists: boolean;
  userHasBranchAccess: boolean;
  deviceTrusted: boolean;
  subscriptionStatus?: 'active' | 'trial' | 'expired' | 'pending';
  allowDefaultBranchCreation?: boolean;
}

export interface PrerequisiteResult {
  decision: PrerequisiteDecision;
  fixable: boolean;
  actions: string[];
  reason: string;
  blockUntil?: string[];
}

export function resolvePrerequisites(input: PrerequisiteInput): PrerequisiteResult {
  if (!input.tenantExists) {
    return {
      decision: 'REQUIRE_VERIFICATION',
      fixable: false,
      actions: ['verify_tenant_identity', 'request_enrollment'],
      reason: 'The tenant is not yet verified or does not exist.',
      blockUntil: ['tenant_validation'],
    };
  }

  if (input.tenantStatus === 'disabled') {
    return {
      decision: 'BLOCKED_BY_POLICY',
      fixable: false,
      actions: ['contact_admin', 'review_tenant_status'],
      reason: 'The tenant is disabled by policy.',
      blockUntil: ['tenant_reactivation'],
    };
  }

  if (input.userStatus === 'disabled' || input.userStatus === 'locked') {
    return {
      decision: 'REQUIRE_VERIFICATION',
      fixable: false,
      actions: ['verify_account_status', 'reset_access'],
      reason: 'The user cannot operate until the account is validated or re-enabled.',
      blockUntil: ['account_status'],
    };
  }

  if (input.subscriptionStatus === 'expired' || input.subscriptionStatus === 'pending') {
    return {
      decision: 'REQUIRE_SUBSCRIPTION',
      fixable: false,
      actions: ['renew_subscription', 'restore_access'],
      reason: 'The subscription is not active enough to authorize work.',
      blockUntil: ['subscription_activation'],
    };
  }

  if (!input.userExists) {
    return {
      decision: 'REQUIRE_VERIFICATION',
      fixable: false,
      actions: ['verify_user_identity', 'assign_access'],
      reason: 'No user mapping is valid for this tenant yet.',
      blockUntil: ['user_validation'],
    };
  }

  if (!input.branchExists && input.allowDefaultBranchCreation) {
    return {
      decision: 'CREATE_DEFAULT_BRANCH',
      fixable: true,
      actions: ['create_default_branch', 'attach_user_to_branch', 'record_audit_event'],
      reason: 'The tenant exists and policy allows a default branch to be created safely.',
      blockUntil: ['branch_creation'],
    };
  }

  if (!input.branchExists && !input.allowDefaultBranchCreation) {
    return {
      decision: 'REQUIRE_ADMIN',
      fixable: false,
      actions: ['contact_admin', 'assign_branch_owner', 'request_default_branch'],
      reason: 'No branch exists and creating one is disallowed by policy.',
      blockUntil: ['branch_provisioning_approval'],
    };
  }

  if (!input.userHasBranchAccess) {
    return {
      decision: 'REQUIRE_ADMIN',
      fixable: false,
      actions: ['grant_branch_access', 'review_rbac_policy'],
      reason: 'The user is valid but has no access to the chosen branch.',
      blockUntil: ['branch_access_assignment'],
    };
  }

  if (!input.deviceTrusted) {
    return {
      decision: 'REQUIRE_VERIFICATION',
      fixable: false,
      actions: ['verify_device', 'challenge_owner', 'register_device'],
      reason: 'The device is not accepted for this tenant’s trusted environment.',
      blockUntil: ['device_binding'],
    };
  }

  return {
    decision: 'READY',
    fixable: true,
    actions: ['continue_session'],
    reason: 'Tenant, user, branch, subscription and device are all acceptable for work.',
  };
}
