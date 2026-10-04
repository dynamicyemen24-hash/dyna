/*
 * The fallback tenant.
 *
 * It lives in its own module because `authz.ts` and `apiHelpers.ts` need it and
 * they now also import from each other: putting it in either one would make the
 * pair circular. ES modules tolerate that at runtime only because the read
 * happens after both modules finish evaluating — a class extends import, or any
 * top-level evaluation touching the other module's exports, would break. Leaf
 * modules are cheaper than reasoning about evaluation order.
 */
export const DEFAULT_TENANT = 'royal-global-hq';