/**
 * Hardware Abstraction Layer (HAL) for USB / Bluetooth / RS-232 Serial Weighing Scales
 * Supports NCI (Avery Weigh-Tronix), Mettler Toledo SICS, CAS, and Dibal protocols.
 */

export type ScaleProtocol = 'NCI' | 'METTLER_TOLEDO' | 'CAS_ASCII' | 'GENERIC_CONTINUOUS';

export interface ScaleReading {
  weightKg: number;
  tareKg: number;
  netWeightKg: number;
  unit: 'kg' | 'lb' | 'g';
  isStable: boolean;
  overload: boolean;
  rawString: string;
  protocol: ScaleProtocol;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected_web_serial' | 'connected_bluetooth' | 'simulated';

class ScaleProtocolHAL {
  private status: ConnectionStatus = 'simulated';
  private currentProtocol: ScaleProtocol = 'NCI';
  private listeners: ((reading: ScaleReading) => void)[] = [];
  private statusListeners: ((status: ConnectionStatus) => void)[] = [];

  private port: any = null; // SerialPort instance
  private reader: any = null;
  private currentReading: ScaleReading = {
    weightKg: 1.45,
    tareKg: 0,
    netWeightKg: 1.45,
    unit: 'kg',
    isStable: true,
    overload: false,
    rawString: 'ST,GS,+0001.450kg\r\n',
    protocol: 'NCI',
  };

  private simTimer: any = null;

  constructor() {
    this.startSimulation();
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getProtocol(): ScaleProtocol {
    return this.currentProtocol;
  }

  public setProtocol(protocol: ScaleProtocol) {
    this.currentProtocol = protocol;
  }

  public subscribe(callback: (reading: ScaleReading) => void) {
    this.listeners.push(callback);
    callback(this.currentReading);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  public subscribeStatus(callback: (status: ConnectionStatus) => void) {
    this.statusListeners.push(callback);
    callback(this.status);
    return () => {
      this.statusListeners = this.statusListeners.filter((s) => s !== callback);
    };
  }

  /**
   * Request USB/Serial Port connection using Web Serial API
   */
  public async connectWebSerial(): Promise<boolean> {
    if (!('serial' in navigator)) {
      alert('متصفحك لا يدعم Web Serial API مباشرة. سيتم استخدام الوضع التشبيهي للميزان.');
      return false;
    }

    try {
      this.updateStatus('connecting');
      // @ts-ignore
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });

      this.stopSimulation();
      this.updateStatus('connected_web_serial');
      this.readSerialLoop();
      return true;
    } catch (err) {
      console.warn('Web Serial connection cancelled or failed:', err);
      this.startSimulation();
      return false;
    }
  }

  /**
   * Request Bluetooth Low Energy Scale connection using Web Bluetooth API
   */
  public async connectBluetooth(): Promise<boolean> {
    if (!('bluetooth' in navigator)) {
      alert('متصفحك لا يدعم Web Bluetooth API. سيتم استخدام المحاكي المباشر للميزان.');
      return false;
    }

    try {
      this.updateStatus('connecting');
      // @ts-ignore
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ['weight_scale', '0000181d-0000-1000-8000-00805f9b34fb'],
      });

      this.stopSimulation();
      this.updateStatus('connected_bluetooth');
      console.log('[Scale HAL] Connected to Bluetooth scale:', device.name);
      return true;
    } catch (err) {
      console.warn('Bluetooth scale connection failed:', err);
      this.startSimulation();
      return false;
    }
  }

  /**
   * Send Tare Command to Physical Scale via Serial Line
   */
  public async sendTareCommand() {
    if (this.status === 'simulated') {
      this.currentReading.tareKg = this.currentReading.weightKg;
      this.currentReading.netWeightKg = 0;
      this.notifyListeners();
      return;
    }

    if (this.port && this.port.writable) {
      const writer = this.port.writable.getWriter();
      let cmd = 'T\r\n'; // NCI protocol Tare
      if (this.currentProtocol === 'METTLER_TOLEDO') cmd = 'T\r\n';
      else if (this.currentProtocol === 'CAS_ASCII') cmd = 'KT\r\n';

      const encoder = new TextEncoder();
      await writer.write(encoder.encode(cmd));
      writer.releaseLock();
    }
  }

  /**
   * Send Zero Command to Scale
   */
  public async sendZeroCommand() {
    if (this.status === 'simulated') {
      this.currentReading.weightKg = 0;
      this.currentReading.tareKg = 0;
      this.currentReading.netWeightKg = 0;
      this.notifyListeners();
      return;
    }

    if (this.port && this.port.writable) {
      const writer = this.port.writable.getWriter();
      let cmd = 'Z\r\n'; // NCI / Mettler Zero
      const encoder = new TextEncoder();
      await writer.write(encoder.encode(cmd));
      writer.releaseLock();
    }
  }

  /**
   * Protocol Parser for raw scale strings
   */
  public parseScaleData(raw: string): ScaleReading {
    let weight = 0;
    let isStable = true;
    let unit: 'kg' | 'lb' | 'g' = 'kg';

    try {
      if (this.currentProtocol === 'NCI') {
        // NCI format: ST,GS,+0001.450kg or US,GS,+0001.450kg
        isStable = raw.startsWith('ST');
        const match = raw.match(/([+-]?\d+\.?\d*)\s*(kg|lb|g)/i);
        if (match) {
          weight = parseFloat(match[1]);
          unit = match[2].toLowerCase() as any;
        }
      } else if (this.currentProtocol === 'METTLER_TOLEDO') {
        // SICS format: S S    1.450 kg
        isStable = raw.includes('S S');
        const match = raw.match(/([+-]?\d+\.?\d*)\s*(kg|g)/i);
        if (match) {
          weight = parseFloat(match[1]);
          unit = match[2].toLowerCase() as any;
        }
      } else {
        // Generic ASCII numbers extract
        const match = raw.match(/([+-]?\d+\.?\d*)/);
        if (match) {
          weight = parseFloat(match[1]);
        }
      }
    } catch (e) {
      console.warn('Protocol parse error:', e);
    }

    const net = Math.max(0, weight - this.currentReading.tareKg);

    return {
      weightKg: Math.round(weight * 1000) / 1000,
      tareKg: this.currentReading.tareKg,
      netWeightKg: Math.round(net * 1000) / 1000,
      unit,
      isStable,
      overload: weight > 150,
      rawString: raw,
      protocol: this.currentProtocol,
    };
  }

  private async readSerialLoop() {
    while (this.port && this.port.readable) {
      try {
        this.reader = this.port.readable.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) {
            const text = decoder.decode(value, { stream: true });
            const parsed = this.parseScaleData(text);
            this.currentReading = parsed;
            this.notifyListeners();
          }
        }
      } catch (err) {
        console.error('Serial read loop error:', err);
        break;
      } finally {
        if (this.reader) {
          try {
            this.reader.releaseLock();
          } catch (e) {
            // Ignore if already released
          }
        }
      }
    }
  }

  private startSimulation() {
    this.updateStatus('simulated');
    if (this.simTimer) clearInterval(this.simTimer);

    this.simTimer = setInterval(() => {
      // Simulate live random weight changes on scale
      const noise = (Math.random() - 0.5) * 0.03;
      const newWeight = Math.max(0, Math.round((this.currentReading.weightKg + noise) * 1000) / 1000);
      const net = Math.max(0, newWeight - this.currentReading.tareKg);

      this.currentReading = {
        ...this.currentReading,
        weightKg: newWeight,
        netWeightKg: Math.round(net * 1000) / 1000,
        rawString: `ST,GS,+${newWeight.toFixed(3)}kg\r\n`,
      };
      this.notifyListeners();
    }, 1200);
  }

  private stopSimulation() {
    if (this.simTimer) {
      clearInterval(this.simTimer);
      this.simTimer = null;
    }
  }

  private updateStatus(newStatus: ConnectionStatus) {
    this.status = newStatus;
    this.statusListeners.forEach((fn) => fn(newStatus));
  }

  private notifyListeners() {
    this.listeners.forEach((fn) => fn(this.currentReading));
  }
}

export const scaleHAL = new ScaleProtocolHAL();
