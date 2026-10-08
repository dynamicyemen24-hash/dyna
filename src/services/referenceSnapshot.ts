/**
 * Read-only offline snapshot of subscriber identity, entitlements and branches.
 *
 * Cloud data remains authoritative. The browser may refresh and read this
 * snapshot when the network is unavailable, but it cannot write reference
 * records back to the server from this store. Transactional offline work uses
 * the separate idempotent outbox.
 */
export interface ReferenceSnapshot<T> {
  schemaVersion: 1;
  namespace: string;
  tenantId: string;
  userId: string;
  fetchedAt: string;
  data: T;
}

const DB_NAME = 'dypos-reference-cache';
const STORE_NAME = 'snapshots';
const DB_VERSION = 1;
export const REFERENCE_TTL_MS = 15 * 60 * 1000;

export interface SignedIdentity {
  tenantId: string;
  userId: string;
}

export function readSignedIdentity(): SignedIdentity | null {
  try {
    const currentToken = sessionStorage.getItem('dypos_token');
    const legacyRaw = localStorage.getItem('dypos_session_v1');
    const legacyToken = legacyRaw ? (JSON.parse(legacyRaw) as { token?: string }).token : null;
    const rawToken = currentToken || legacyToken;
    if (!rawToken || typeof rawToken !== 'string') return null;
    const [encodedPayload] = rawToken.split('.');
    if (!encodedPayload) return null;
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const payload = JSON.parse(atob(padded)) as {
      tenantId?: string;
      sub?: string;
    };
    if (!payload.tenantId || !payload.sub) return null;
    return { tenantId: payload.tenantId, userId: payload.sub };
  } catch {
    return null;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open local reference cache'));
    request.onblocked = () => reject(new Error('Local reference cache upgrade is blocked'));
  });
}

const recordKey = ({ tenantId, userId }: SignedIdentity, namespace: string) =>
  `${tenantId}::${userId}::${namespace}`;

export async function readReferenceSnapshot<T>(
  identity: SignedIdentity,
  namespace = 'reference',
): Promise<ReferenceSnapshot<T> | null> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(recordKey(identity, namespace));
      request.onsuccess = () => {
        const row = request.result as ({ key: string } & ReferenceSnapshot<T>) | undefined;
        resolve(row && row.schemaVersion === 1
          && row.tenantId === identity.tenantId
          && row.userId === identity.userId
          && row.namespace === namespace
          ? row
          : null);
      };
      request.onerror = () => reject(request.error ?? new Error('Unable to read local reference cache'));
    });
  } finally {
    db.close();
  }
}

export async function writeReferenceSnapshot<T>(
  identity: SignedIdentity,
  data: T,
  namespace = 'reference',
): Promise<ReferenceSnapshot<T>> {
  const snapshot: ReferenceSnapshot<T> = {
    schemaVersion: 1,
    namespace,
    tenantId: identity.tenantId,
    userId: identity.userId,
    fetchedAt: new Date().toISOString(),
    data,
  };
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({ key: recordKey(identity, namespace), ...snapshot });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Unable to store local reference cache'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local reference cache write aborted'));
    });
    return snapshot;
  } finally {
    db.close();
  }
}

export function isReferenceSnapshotFresh(snapshot: ReferenceSnapshot<unknown>, now = Date.now()): boolean {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt >= 0 && now - fetchedAt < REFERENCE_TTL_MS;
}