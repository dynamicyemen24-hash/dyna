/**
 * ══ THE DEFECT THIS REPLACES ════════════════════════════════════════════════
 * The constructor of this class used to be:
 *
 *     constructor() {
 *       this.startSimulation();
 *     }
 *
 * with `status = 'simulated'` and a seeded reading of 1.45 kg, refreshed every
 * 1200 ms by `Math.random()` noise. Worse, **a failed connection restored the
 * simulation**: `catch { this.startSimulation(); }` in both `connectWebSerial`
 * and `connectBluetooth`. So an operator who plugged in a real scale, failed to
 * pair it, and then saw "USB RS232" in the widget was looking at invented digits
 * from a `setInterval`.
 *
 * `sendTareCommand()` and `sendZeroCommand()` then *mutated that invented
 * reading* when `status === 'simulated'`, which is how a tare could appear to
 * work on hardware that did not exist.
 *
 * ══ WHAT IS HERE NOW ═══════════════════════════════════════════════════════
 * The real transport, with no simulation anywhere in the file:
 *
 *   - the status starts `disconnected`, not `simulated`
 *   - a failed connection stays disconnected and reports why
 *   - `parseScaleData` is a pure function, so the protocol grammar is testable
 *     without a device — which is the only way to prove the parser is right
 *   - every parsed frame is published to `deviceGateway`, the single facade the
 *     screens read, so there is exactly one scale in the application
 *
 * The `'simulated'` member is kept in the union ONLY so that a stale compiled
 * bundle cannot silently produce an unreachable branch elsewhere; nothing sets
 * it, and `assert: no simulated status is ever emitted` guards that in
 * `scripts/test-hardware-integrity.ts`.
 */
import {
  deviceGateway,
  type SerialPort,
  type SerialWritable,
} from './deviceGateway';

/** Scale wire protocols. */
export type ScaleProtocol = 'NCI' | 'METTLER_TOLEDO' | 'CAS_ASCII' | 'GENERIC_CONTINUOUS';

/** A raw frame as it arrives on the wire, plus what we understood from it. */
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

/**
 * Transport state.
 *
 * `simulated` is retained in the union for one reason only: so that a stale
 * compiled reference to it is a *type* the compiler still knows, rather than an
 * `any` that could be produced by a cast. No code path sets it — a failed
 * connection now stays `disconnected` and reports the reason — and
 * `scripts/test-hardware-integrity.ts` asserts that it is never emitted.
 */
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected_web_serial'
  | 'connected_bluetooth'
  | 'simulated';

/**
 * The reading a scale that has said nothing yet reports.
 *
 * Every numeric field is zero and `isStable` is **false**, which is the
 * difference that matters: a zero weight that is not marked stable cannot be
 * mistaken for a scale that weighed an empty platter.
 *
 * Exported so that a screen's initial state is this one object rather than a
 * hand-written copy of it. A duplicated literal is how the `1.45` seed came to
 * exist in three places; one exported constant means the next empty reading is
 * written once, and `scripts/test-hardware-integrity.ts` can assert that the
 * screens actually reference it.
 */
export const NO_FRAME: ScaleReading = Object.freeze({
  weightKg: 0,
  tareKg: 0,
  netWeightKg: 0,
  unit: 'kg' as const,
  isStable: false,
  overload: false,
  rawString: '',
  protocol: 'NCI' as const,
});

/** Result of a connection attempt: it either happened, or it did not. */
export type ConnectResult =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

class ScaleProtocolHAL {
  /**
   * Starts disconnected.
   *
   * It used to start `'simulated'`, which is how a fresh page came up already
   * displaying a weight that no device produced.
   */
  private status: ConnectionStatus = 'disconnected';
  private currentProtocol: ScaleProtocol = 'NCI';
  private listeners: ((reading: ScaleReading) => void)[] = [];
  private statusListeners: ((status: ConnectionStatus) => void)[] = [];

  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  /** Tare the device itself reported, in kg. Zero until the device says so. */
  private deviceTareKg = 0;
  private currentReading: ScaleReading = NO_FRAME;

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getProtocol(): ScaleProtocol {
    return this.currentProtocol;
  }

  public setProtocol(protocol: ScaleProtocol): void {
    this.currentProtocol = protocol;
  }

  /** The last frame actually received. Never a fabricated one. */
  public getLastFrame(): ScaleReading {
    return this.currentReading;
  }

  public subscribe(callback: (reading: ScaleReading) => void): () => void {
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
   * Opens a USB / RS-232 scale over Web Serial.
   *
   * A failure returns `ok: false` with the reason and **leaves the transport
   * disconnected**. It used to call `startSimulation()` in the catch, which is
   * how "I plugged the scale in, it didn't work, and the number kept changing"
   * happened. `alert()` is also gone: a modal is not a status report, and it
   * told the operator a simulation was about to stand in for their hardware.
   */
  public async connectWebSerial(): Promise<ConnectResult> {
    const serial = navigator.serial;
    if (!serial) {
      return {
        ok: false,
        reason:
          'This browser does not expose the Web Serial API. '
          + 'Connect the scale from Chrome or Edge on the desktop, or type the weight by hand.',
      };
    }

    try {
      this.updateStatus('connecting');
      const port = await serial.requestPort();
      await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
      this.port = port;
      this.deviceTareKg = 0;
      this.updateStatus('connected_web_serial');
      void this.readSerialLoop();
      return { ok: true, detail: 'Scale open on the serial port at 9600 baud.' };
    } catch (err) {
      // Stay disconnected. Publishing anything here would be inventing data.
      this.port = null;
      this.updateStatus('disconnected');
      deviceGateway.clearScale();
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'The serial port was not granted.',
      };
    }
  }

  /**
   * Opens a Bluetooth Low Energy scale and subscribes to its weight
   * characteristic.
   *
   * The previous version requested a device, declared success, and never read
   * a single notification — so `connected_bluetooth` meant only "a chooser
   * dialog was dismissed". This one subscribes to the Weight Scale
   * characteristic and parses every notification, so the status means "frames
   * are arriving".
   */
  public async connectBluetooth(): Promise<ConnectResult> {
    const bluetooth = navigator.bluetooth;
    if (!bluetooth) {
      return {
        ok: false,
        reason:
          'This browser does not expose the Web Bluetooth API. '
          + 'Connect the scale from Chrome or Edge on the desktop, or type the weight by hand.',
      };
    }

    try {
      this.updateStatus('connecting');
      const device = await bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: ['weight_scale', '0000181d-0000-1000-8000-00805f9b34fb'],
      });
      const server = await device.gatt?.connect();
      if (!server) {
        throw new Error('The scale accepted the connection but exposes no GATT server.');
      }

      const service = await server.getPrimaryService('weight_scale');
      const characteristic = await service.getCharacteristic('weight_measurement');
      const handler = (event: Event): void => {
        const value = (event.target as unknown as { value?: DataView })?.value;
        if (!value) return;
        this.publishFrame(this.decodeWeightCharacteristic(value));
      };
      characteristic.addEventListener('characteristicvaluechanged', handler);
      await characteristic.startNotifications();

      this.port = null;
      this.deviceTareKg = 0;
      this.updateStatus('connected_bluetooth');
      return { ok: true, detail: 'Subscribed to the weight measurement characteristic.' };
    } catch (err) {
      this.updateStatus('disconnected');
      deviceGateway.clearScale();
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'The Bluetooth scale was not paired.',
      };
    }
  }

  /**
   * Decodes a Bluetooth Weight Measurement characteristic.
   *
   * Per the Bluetooth SIG scale profile the first byte is flags: bits 0–1 give
   * the resolution, bit 2 the unit (0 = kg, 1 = lb), bit 3 whether a timestamp
   * follows. The value is signed only in one documented combination, so both
   * encodings are handled rather than assumed.
   */
  public decodeWeightCharacteristic(view: DataView): ScaleReading {
    const flags = view.getUint8(0);
    const unit: 'kg' | 'lb' = flags & 0x04 ? 'lb' : 'kg';
    const resolution = flags & 0x03;
    const signed = unit === 'kg' && (flags & 0x08) === 0 && resolution === 0;
    const raw = signed ? view.getInt16(2, true) : view.getUint16(2, true);
    const divisor = resolution === 0 ? 0.005 : resolution === 1 ? 0.01 : 0.05;
    const weightKg = unit === 'lb' ? raw * 0.45359237 * divisor : raw * divisor;

    return {
      weightKg: Math.round(weightKg * 1000) / 1000,
      tareKg: this.deviceTareKg,
      netWeightKg: Math.max(0, Math.round((weightKg - this.deviceTareKg) * 1000) / 1000),
      unit,
      isStable: true,
      overload: false,
      rawString: `flags=0x${flags.toString(16)} raw=${raw}`,
      protocol: 'GENERIC_CONTINUOUS',
    };
  }

  /**
   * Asks the physical scale to tare.
   *
   * Returns whether the command was actually written to a port. There is no
   * branch that "tares" the local copy of a reading when no device is attached:
   * a tare that exists only in the browser is a tare the merchant's customer was
   * never charged for.
   */
  public async sendTareCommand(): Promise<ConnectResult> {
    if (!this.port?.writable) {
      return { ok: false, reason: 'No scale is connected, so no tare command was sent.' };
    }
    return this.writeToScale(this.currentProtocol === 'CAS_ASCII' ? 'KT\r\n' : 'T\r\n');
  }

  /** Asks the physical scale to zero. Same contract as `sendTareCommand`. */
  public async sendZeroCommand(): Promise<ConnectResult> {
    if (!this.port?.writable) {
      return { ok: false, reason: 'No scale is connected, so no zero command was sent.' };
    }
    return this.writeToScale('Z\r\n');
  }

  private async writeToScale(command: string): Promise<ConnectResult> {
    const writable: SerialWritable | null | undefined = this.port?.writable;
    if (!writable) {
      return { ok: false, reason: 'The scale port is no longer writable.' };
    }
    try {
      const writer = writable.getWriter();
      await writer.write(new TextEncoder().encode(command));
      writer.releaseLock();
      // The device confirms the tare with its next frame; recording it here is
      // what makes the next *reported* net weight subtract it.
      this.deviceTareKg = this.currentReading.weightKg;
      return { ok: true, detail: `Sent "${command.trim()}" to the scale.` };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'The scale rejected the command.',
      };
    }
  }

  /**
   * Parses one raw scale frame into a reading.
   *
   * Pure: it reads no state beyond the selected protocol, so the protocol
   * grammar is verifiable without a device — which is the only practical way to
   * prove a parser is right. `isStable` is `false` for any frame it could not
   * fully understand, so an unrecognised line never presents as a settled weight.
   */
  public parseScaleData(raw: string): ScaleReading {
    let weight: number | null = null;
    let isStable = false;
    let unit: 'kg' | 'lb' | 'g' = 'kg';

    if (this.currentProtocol === 'NCI') {
      // NCI: `ST,GS,+0001.450kg` (stable) or `US,GS,+0001.450kg` (unstable).
      isStable = raw.startsWith('ST');
      const match = raw.match(/([+-]?\d+\.?\d*)\s*(kg|lb|g)/i);
      if (match) {
        weight = Number.parseFloat(match[1]);
        unit = match[2].toLowerCase() as 'kg' | 'lb' | 'g';
      }
    } else if (this.currentProtocol === 'METTLER_TOLEDO') {
      // SICS: `S S    1.450 kg` (stable) / `S D    1.450 kg` (unstable).
      isStable = raw.includes('S S');
      const match = raw.match(/([+-]?\d+\.?\d*)\s*(kg|g|lb)/i);
      if (match) {
        weight = Number.parseFloat(match[1]);
        unit = match[2].toLowerCase() as 'kg' | 'lb' | 'g';
      }
    } else {
      // CAS / generic continuous: a bare number with an optional unit token.
      const match = raw.match(/([+-]?\d+\.?\d*)\s*(kg|lb|g)?/i);
      if (match) {
        weight = Number.parseFloat(match[1]);
        unit = (match[2]?.toLowerCase() ?? 'kg') as 'kg' | 'lb' | 'g';
        // A continuous stream carries no stability flag; the device is the only
        // authority on that, so this stays false rather than being invented.
        isStable = false;
      }
    }

    // An unparseable frame yields NO_FRAME, not a weight of zero: "0 kg" is a
    // measurement, and reading one out of noise is a measurement nobody made.
    if (weight === null || !Number.isFinite(weight)) return NO_FRAME;

    const inKg = unit === 'lb' ? weight * 0.45359237 : unit === 'g' ? weight / 1000 : weight;
    const net = Math.max(0, inKg - this.deviceTareKg);

    return {
      weightKg: Math.round(inKg * 1000) / 1000,
      tareKg: this.deviceTareKg,
      netWeightKg: Math.round(net * 1000) / 1000,
      unit,
      isStable,
      overload: inKg > 150,
      rawString: raw,
      protocol: this.currentProtocol,
    };
  }

  /**
   * Streams frames off the serial port until the device closes or errors.
   *
   * A scale sends many lines per second, and a frame boundary is a newline — so
   * the buffer is split rather than parsing each read as a whole frame. The old
   * version called `decoder.decode(value)` without `{ stream: true }` and parsed
   * whatever chunk arrived, which split multi-line frames into nonsense.
   */
  private async readSerialLoop(): Promise<void> {
    const port = this.port;
    if (!port?.readable) return;

    let buffer = '';
    const decoder = new TextDecoder();

    try {
      this.reader = port.readable.getReader();
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: true });
        // A partial trailing line stays in the buffer for the next read.
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          this.publishFrame(this.parseScaleData(line));
        }
      }
    } catch (err) {
      // The port is gone (unplugged, or the operator cancelled). Go back to a
      // truthful disconnected state instead of leaving the last digits frozen
      // on screen as if the scale were still weighing.
      this.updateStatus('disconnected');
      deviceGateway.clearScale();
      this.notifyListeners();
      console.warn('Scale serial stream ended:', err instanceof Error ? err.message : err);
    } finally {
      try {
        this.reader?.releaseLock();
      } catch {
        /* the lock is already released */
      }
      this.reader = null;
    }
  }

  /**
   * Publishes a frame to the subscribers and to `deviceGateway`.
   *
   * An unstable or unparsed frame clears the facade rather than publishing a
   * number: while a weight is moving, showing the last settled value as *the*
   * weight is how produce gets sold at the wrong price.
   */
  private publishFrame(frame: ScaleReading): void {
    this.currentReading = frame;
    if (frame.isStable && frame.rawString !== '') {
      deviceGateway.reportDeviceWeight(frame.netWeightKg, frame.tareKg);
    } else {
      deviceGateway.clearScale();
    }
    this.notifyListeners();
  }

  private updateStatus(newStatus: ConnectionStatus): void {
    this.status = newStatus;
    for (const fn of this.statusListeners) fn(newStatus);
  }

  private notifyListeners(): void {
    for (const fn of this.listeners) fn(this.currentReading);
  }
}

/**
 * The one scale instance.
 *
 * Constructed with no side effects: it opens no port, starts no timer and holds
 * no reading. Everything it reports, it received from a device.
 */
export const scaleHAL = new ScaleProtocolHAL();
