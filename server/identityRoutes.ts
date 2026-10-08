import type { Express } from 'express';
import { asyncRoute, fail } from './apiHelpers.js';
import { resolveExistingIdentity, enrollTenantSafely } from './enrollmentEngine.js';
import { resolvePrerequisites } from './policyEngine.js';

export function registerIdentityRoutes(app: Express) {
  app.post('/api/identity/resolve', asyncRoute(async (req, res) => {
    const decision = await resolveExistingIdentity({
      tenantName: req.body?.tenantName,
      tenantCode: req.body?.tenantCode,
      ownerName: req.body?.ownerName,
      username: req.body?.username,
      email: req.body?.email,
      phone: req.body?.phone,
      branchName: req.body?.branchName,
      deviceFingerprint: req.body?.deviceFingerprint,
      idempotencyKey: req.body?.idempotencyKey,
    });

    res.json({
      ok: !['AMBIGUOUS_IDENTITY', 'PENDING_VERIFICATION', 'EXISTING_USER_NO_ACCESS'].includes(decision.state),
      decision,
    });
  }));

  app.post('/api/identity/enroll', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const identityDecision = await resolveExistingIdentity({
      tenantName: body.tenantName,
      tenantCode: body.tenantCode,
      ownerName: body.ownerName,
      username: body.username,
      email: body.email,
      phone: body.phone,
      branchName: body.branchName,
      deviceFingerprint: body.deviceFingerprint,
      idempotencyKey: body.idempotencyKey,
    });

    if (identityDecision.state !== 'NEW_TENANT') {
      return fail(res, 409, identityDecision.reason || 'Identity is not safe for enrollment');
    }

    const prereq = resolvePrerequisites({
      tenantExists: true,
      tenantStatus: 'active',
      userExists: false,
      userStatus: 'pending',
      branchExists: false,
      userHasBranchAccess: false,
      deviceTrusted: Boolean(body.deviceFingerprint),
      subscriptionStatus: 'trial',
      allowDefaultBranchCreation: true,
    });

    if (prereq.decision !== 'CREATE_DEFAULT_BRANCH' && prereq.decision !== 'READY') {
      return fail(res, 409, prereq.reason);
    }

    const result = await enrollTenantSafely({
      tenantName: body.tenantName,
      tenantCode: body.tenantCode,
      ownerName: body.ownerName,
      username: body.username,
      email: body.email,
      phone: body.phone,
      password: body.password,
      branchName: body.branchName,
      deviceFingerprint: body.deviceFingerprint,
      idempotencyKey: body.idempotencyKey,
    });

    if (result.state === 'AMBIGUOUS_IDENTITY' || result.state === 'PENDING_VERIFICATION' || result.state === 'EXISTING_USER_NO_ACCESS') {
      return fail(res, 409, result.reason || 'Identity not safe to enroll');
    }

    res.status(201).json({ ok: true, result, prereq });
  }));
}

