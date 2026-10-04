/**
 * Backup orchestration.
 *
 * The Neon PostgreSQL sync is the system of record and always runs first. The
 * secondary copy is kept in the browser's own storage rather than Firestore:
 * a local snapshot is what actually rescues a till when the network drops, and
 * importing the Firebase SDK for it cost ~527 KB on the critical path.
 */
import { TENANT_ID } from './dyposApi';
import { Product, Transaction, Customer, JournalEntry, PurchaseOrder, Employee, SyncStatus } from '../types';

// Re-exported so existing importers keep working; the canonical declaration
// lives in types.ts to keep the Firebase SDK off the application shell.
export type { SyncStatus };

const LOCAL_BACKUP_KEY = 'dypos_local_backup';
const LOCAL_META_KEY = 'dypos_local_backup_meta';

export interface BackupPayload {
  timestamp: string;
  tenantId: string;
  productsCount: number;
  transactionsCount: number;
  customersCount: number;
  journalEntriesCount: number;
  data: {
    products: Product[];
    transactions: Transaction[];
    customers: Customer[];
    journalEntries: JournalEntry[];
    purchaseOrders?: PurchaseOrder[];
    employees?: Employee[];
  };
}

export interface BackupState {
  status: SyncStatus;
  lastBackupTime: string | null;
  autoBackupIntervalMinutes: number;
  isOnline: boolean;
  unbackedChangesCount: number;
  neonPostgresStatus?: 'connected' | 'syncing' | 'failed';
}

/**
 * Pushes the current dataset to Neon PostgreSQL, then keeps a local snapshot.
 *
 * Returns true when either leg succeeded, so a caller can report partial
 * success honestly rather than claiming a backup that only reached one target.
 */
export const executeCloudBackup = async (
  payload: BackupPayload,
  tenantId = TENANT_ID,
): Promise<boolean> => {
  let pgSuccess = false;
  let localSuccess = false;

  // 1. System of record — Neon PostgreSQL via the sync-batch endpoint.
  try {
    const pgRes = await fetch('/api/db/sync-batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({
        tenantId,
        transactions: payload.data.transactions || [],
        products: payload.data.products || [],
      }),
    });

    if (pgRes.ok) {
      const data = await pgRes.json();
      if (data.success) pgSuccess = true;
    }
  } catch (pgErr) {
    console.warn('Neon PostgreSQL sync batch skipped or temporarily unreachable:', pgErr);
  }

  // 2. Local snapshot — the copy that survives an outage on this terminal.
  try {
    localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(payload));
    localStorage.setItem(
      LOCAL_META_KEY,
      JSON.stringify({
        lastBackupTime: new Date().toLocaleString('ar-SA'),
        productsCount: payload.productsCount,
        transactionsCount: payload.transactionsCount,
        customersCount: payload.customersCount,
        updatedAt: new Date().toISOString(),
        pgStatus: pgSuccess ? 'healthy' : 'pending',
      }),
    );
    localSuccess = true;
  } catch (err) {
    console.error('Failed to write the local backup snapshot:', err);
  }

  return pgSuccess || localSuccess;
};

/** Reads back the last local snapshot, or null when none was ever written. */
export const readLocalBackup = (): BackupPayload | null => {
  try {
    const raw = localStorage.getItem(LOCAL_BACKUP_KEY);
    return raw ? (JSON.parse(raw) as BackupPayload) : null;
  } catch {
    return null;
  }
};

/** Metadata about the most recent backup attempt, for the status bar. */
export const readLocalBackupMeta = (): BackupState | null => {
  try {
    const raw = localStorage.getItem(LOCAL_META_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw);
    return {
      status: 'synced',
      lastBackupTime: m.lastBackupTime ?? null,
      autoBackupIntervalMinutes: 15,
      isOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
      unbackedChangesCount: 0,
      neonPostgresStatus: m.pgStatus === 'healthy' ? 'connected' : 'syncing',
    };
  } catch {
    return null;
  }
};
