import type { Express } from 'express';
import { asyncRoute } from './apiHelpers.js';
import { processIdentityOutbox } from './outboxEngine.js';
import { recoverIdentityState } from './identityRecovery.js';

export function registerSyncRecoveryRoutes(app: Express) {
  app.post('/api/identity/outbox/process', asyncRoute(async (_req, res) => {
    const result = await processIdentityOutbox();
    res.json({ ok: true, result });
  }));

  app.post('/api/identity/recover', asyncRoute(async (req, res) => {
    const result = await recoverIdentityState(req.body?.tenantId, req.body?.userId);
    res.json({ ok: result.state !== 'conflict', result });
  }));
}
