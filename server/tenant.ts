/*
 * The fallback tenant.
 *
 * It lives in its own module because `authz.ts` and `apiHelpers.ts` need it and
 * they now also import from each other: putting it in either one would make the
 * pair circular. ES modules tolerate that at runtime only because the read
 * happens after both modules finish evaluating — a class extends import, or any
 * top-level evaluation touching the other module's exports, would break. Leaf
 * modules are cheaper than reasoning about evaluation order.
 *
 * ══ WHY IT IS NOW READABLE FROM THE ENVIRONMENT ════════════════════════════
 * It was a string literal, and four other files repeated the same literal:
 * `neonDb.ts` seeding it, `LoginView` and `AuthContext` passing it to
 * `rememberTenant`, and the front-end `dyposApi` default. Six definitions of one
 * identifier is a value waiting to drift, and the front-end copies were the
 * dangerous ones: a client that named a different tenant still sent this one.
 *
 * `DEFAULT_TENANT` on the server is a BOOTSTRAP value, not a hard-coded
 * business rule — it is only reached when a request carries no tenant claim at
 * all, which is the single-tenant local install. It is configurable so a
 * deployment that seeds a differently-named tenant does not have to edit source
 * and rebuild. The server still re-derives the real tenant from the signed
 * token on every authenticated request; this never widens access.
 */
export const DEFAULT_TENANT = process.env.DEFAULT_TENANT?.trim() || 'royal-global-hq';