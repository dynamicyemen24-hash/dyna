import type { Express } from 'express';
import { asyncRoute, fail } from './apiHelpers.js';
import { resolvePrerequisites } from './policyEngine.js';

export function registerPolicyRoutes(app: Express) {
  app.post('/api/identity/prerequisites', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const decision = resolvePrerequisites({
      tenantExists: Boolean(body.tenantExists),
      tenantStatus: body.tenantStatus,
      userExists: Boolean(body.userExists),
      userStatus: body.userStatus,
      branchExists: Boolean(body.branchExists),
      userHasBranchAccess: Boolean(body.userHasBranchAccess),
      deviceTrusted: Boolean(body.deviceTrusted),
      subscriptionStatus: body.subscriptionStatus,
      allowDefaultBranchCreation: Boolean(body.allowDefaultBranchCreation),
    });

    if (decision.decision !== 'READY' && decision.decision !== 'CREATE_DEFAULT_BRANCH') {
      return fail(res, 409, decision.reason);
    }

    res.json({ ok: true, decision });
  }));
}
