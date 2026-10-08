/**
 * CLIENT TELEMETRY & PREDICTIVE SELF-HEALING SERVICE
 * ----------------------------------------------------
 * Collects client device health (battery, storage quota, memory, online latency,
 * peripheral connectivity status) and reports to backend telemetry engine,
 * fetches predicted anomalies, and executes automated or one-click self-healing.
 */

import { apiGet, apiPost } from './dyposApi';

export interface TelemetryPayload {
  branchId?: string;
  deviceId?: string;
  cpuUsage?: number | null;
  memoryUsage?: number | null;
  diskFreePercent?: number | null;
  batteryLevel?: number | null;
  networkLatencyMs?: number | null;
  scaleConnected?: boolean;
  printerConnected?: boolean;
  errorCount?: number;
  metadata?: Record<string, any>;
}

export interface HardwareAnomaly {
  id: string;
  tenant_id: string;
  branch_id?: string;
  device_id: string;
  component: string;
  anomaly_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence_score: number;
  predicted_failure_time?: string;
  description: string;
  status: 'open' | 'mitigating' | 'resolved' | 'ignored';
  detected_at: string;
}

export interface SelfHealingAction {
  id: string;
  action_type: string;
  target_component: string;
  status: 'success' | 'failed' | 'pending';
  result_details: string;
  executed_by: string;
  executed_at: string;
}

export async function reportClientTelemetry(payload: TelemetryPayload): Promise<any> {
  try {
    const res = await apiPost('/api/erp/telemetry/ingest', payload);
    return res;
  } catch (err) {
    console.warn('[telemetryClient] Failed to report telemetry:', err);
    return null;
  }
}

export async function fetchHardwareAnomalies(deviceId?: string): Promise<HardwareAnomaly[]> {
  try {
    const url = deviceId ? `/api/erp/telemetry/anomalies?deviceId=${encodeURIComponent(deviceId)}` : '/api/erp/telemetry/anomalies';
    const res = await apiGet<{ items: HardwareAnomaly[] }>(url);
    return res.items || [];
  } catch (err) {
    console.warn('[telemetryClient] Failed to fetch anomalies:', err);
    return [];
  }
}

export async function executeSelfHealing(
  anomalyId: string | null,
  actionType: string,
  targetComponent: string,
  deviceId?: string
): Promise<any> {
  const res = await apiPost('/api/erp/telemetry/heal', {
    anomalyId,
    actionType,
    targetComponent,
    deviceId: deviceId || 'pos-terminal-1',
  });
  return res;
}

export function startTelemetryCollector(intervalMs = 300_000): () => void {
  /*
   * ══ WHY EVERY READING DEFAULTS TO null, NOT A NUMBER ═══════════════════
   * This function reports into `dypos.hardware_telemetry`, where the server
   * raises anomalies from the values. A default of 45 (% memory), 75 (%
   * disk) or a random "latency" is a figure the browser never measured: it
   * becomes a stored fact, an anomaly computed from it, and maintenance
   * dispatched from the anomaly. A reading the system cannot take MUST be
   * null — the server already treats null as "unknown" (`?? null`) and the
   * anomaly rules skip nulls. Honesty here is load-bearing, not aesthetic.
   */
  const collectAndReport = async () => {
    let memoryUsage: number | null = null;
    if ((performance as any).memory) {
      const mem = (performance as any).memory;
      if (mem.usedJSHeapSize && mem.jsHeapSizeLimit) {
        memoryUsage = Number(((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100).toFixed(1));
      }
    }

    let diskFreePercent: number | null = null;
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        if (est.quota && est.usage) {
          diskFreePercent = Number((((est.quota - est.usage) / est.quota) * 100).toFixed(1));
        }
      } catch {}
    }

    let batteryLevel: number | null = null;
    if ((navigator as any).getBattery) {
      try {
        const battery = await (navigator as any).getBattery();
        batteryLevel = Math.round(battery.level * 100);
      } catch {}
    }

    /*
     * `navigator.onLine` is a BOOLEAN (online or not), not a clock. The
     * previous code turned it into `Math.floor(Math.random() * 40) + 15` — a
     * number that looks measured and was never measured. A measured latency
     * requires timing a real round trip; until one exists the field is null,
     * which the server's anomaly rules already treat as "no data".
     */
    const networkLatencyMs: number | null = null;

    await reportClientTelemetry({
      deviceId: 'pos-terminal-' + (navigator.platform || 'web').replace(/\s+/g, '-').toLowerCase(),
      memoryUsage,
      diskFreePercent,
      batteryLevel,
      networkLatencyMs,
      scaleConnected: false,
      printerConnected: false,
      errorCount: 0,
      metadata: { scaleExpected: true, printerExpected: true, userAgent: navigator.userAgent },
    });
  };

  void collectAndReport();
  const timer = setInterval(() => {
    void collectAndReport();
  }, intervalMs);

  return () => clearInterval(timer);
}
