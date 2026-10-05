/**
 * ══ THE DEFECT THIS REPLACES ════════════════════════════════════════════════
 * This file used to contain a scale that did not exist.
 *
 * Its constructor ran:
 *
 *     setInterval(() => {
 *       const noise = (Math.random() - 0.5) * 0.02;
 *       this.currentWeight = this.currentWeight + noise;
 *       this.notifyScaleListeners();
 *     }, 1500);
 *
 * and it started at 1.45 kg. `openCashDrawer()` and `printReceiptEscPos()` were
 * `console.log(...)` followed by `return true`.
 *
 * So the POS showed a live weight badge reading "⚖ 1.450 كجم" that was a random
 * number, the cash-drawer button reported success without a drawer existing, and
 * `ThirdPartySaleView` computed **money owed to a named farmer** from it:
 *
 *     const gross = scaleReading.netWeightKg * unitPrice;
 *     const netSeller = gross - commission;
 *
 * That is not cosmetic. It is a scale that invents its own readings and a
 * settlement figure derived from them, on a screen whose entire purpose is
 * deciding what a person is owed. §7 of the constitution says a figure the
 * system cannot read is never displayed as a number; this broke it in the one
 * place where the number decides money.
 *
 * ══ WHAT REPLACES IT ═══════════════════════════════════════════════════════
 * Real peripherals, both fail-closed:
 *
 *   1. A weighing scale over Web Serial / Web Bluetooth (`scaleProtocolHAL`).
 *      The reading is `null` until a device is connected and a frame has
 *      arrived. There is no simulated mode: a merchant with no scale must type
 *      the weight, which is the truth, rather than be shown a plausible one.
 *   2. An ESC/POS peripheral over Web Serial for the cash drawer and the receipt.
 *      `openCashDrawer()` returns `false` when no port is open. It cannot report
 *      success for an action it did not perform.
 */

/**
 * ══ WHY THESE TYPES EXIST ═══════════════════════════════════════════════════
 * `Web Serial` and `Web Bluetooth` are not in the TypeScript DOM library, and no
 * `@types` package for them is installed. The previous code therefore wrote
 *
 *     // @ts-ignore
 *     this.port = await navigator.serial.requestPort();
 *
 * and typed the port as `any`.
 *
 * `@ts-ignore` is not a type. It suppresses the compiler on the exact line where
 * the assumption is least verifiable, and `any` disables checking for every
 * property access afterwards — so `port.writable.getWriter()` returning a
 * *number* would have compiled. A typo in an API name is precisely the defect a
 * till cannot afford: the drawer would not open and nothing would say why.
 *
 * So the surface actually used is declared here, minimally and explicitly. If
 * the DOM library gains these later, this file becomes redundant rather than
 * wrong, and removing it is a compile-checked deletion.
 *
 * Only members this codebase calls are declared. That is the point: an undeclared
 * member is a compile error, not a silent `undefined` at the till.
 */

/** Options for `SerialPort.open()`. */
export interface SerialOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

/** A writable byte stream on an open serial port. */
export interface SerialWritable {
  getWriter(): WritableStreamDefaultWriter<Uint8Array>;
}

/** A readable byte stream on an open serial port. */
export interface SerialReadable {
  getReader(): ReadableStreamDefaultReader<Uint8Array>;
}

/** A port granted by the operator through the browser's chooser. */
export interface SerialPort {
  readonly readable: SerialReadable | null;
  readonly writable: SerialWritable | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
}

/** `navigator.serial` — present only in browsers that implement Web Serial. */
export interface SerialApi {
  requestPort(options?: { filters?: Array<{ name?: string; usbVendorId?: number }> }): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}

/** A GATT characteristic that emits notifications. */
export interface BluetoothRemoteGattCharacteristic {
  readonly value: DataView;
  addEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
  startNotifications(): Promise<BluetoothRemoteGattCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGattCharacteristic>;
}

/** A GATT service on a remote peripheral. */
export interface BluetoothRemoteGATTService {
  getCharacteristic(
    characteristic: string | number,
  ): Promise<BluetoothRemoteGattCharacteristic>;
}

/** The GATT server of a paired peripheral. */
export interface BluetoothRemoteGATTServer {
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): Promise<void>;
  getPrimaryService(service: string | number): Promise<BluetoothRemoteGATTService>;
}

/** A paired Bluetooth peripheral. */
export interface BluetoothDevice {
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
}

/** `navigator.bluetooth` — present only in browsers implementing Web Bluetooth. */
export interface BluetoothApi {
  requestDevice(options?: {
    acceptAllDevices?: boolean;
    optionalServices?: string[];
  }): Promise<BluetoothDevice>;
}

declare global {
  interface Navigator {
    readonly serial?: SerialApi;
    readonly bluetooth?: BluetoothApi;
  }
}

/** Whether a peripheral did what it was asked, and why not when it did not. */
export type HardwareOutcome =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

const browserLacks = (api: string, arabic: string): HardwareOutcome => ({
  ok: false,
  reason:
    `This browser does not expose ${api}. ${arabic} `
    + 'Nothing was sent — the action was not performed.',
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ESC/POS peripheral — cash drawer and receipt printer
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * ESC/POS over Web Serial.
 *
 * The drawer on an Epson-compatible till opens on `ESC p m t1 t2`; `1B 70 00
 * 19 FA` is the standard 250 ms pulse. The printer, not the browser, decides
 * whether the drawer opens — all this can do is write bytes to a port the
 * operator granted. So every method reports what it actually did.
 */
class EscPosPeripheral {
  private port: SerialPort | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  public isConnected(): boolean {
    return this.port !== null;
  }

  /** Asks the operator to grant a serial port, then opens it at printer speed. */
  public async connect(): Promise<HardwareOutcome> {
    const serial = navigator.serial;
    if (!serial) {
      return browserLacks(
        'the Web Serial API',
        'These features require Chrome or Edge on the desktop.',
      );
    }
    try {
      const port = await serial.requestPort();
      await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
      this.port = port;
      return { ok: true, detail: 'ESC/POS peripheral open at 9600 baud.' };
    } catch (err) {
      this.port = null;
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'Port access was not granted.',
      };
    }
  }
private async write(bytes: number[]): Promise<HardwareOutcome> {
    if (!this.port?.writable) {
      return {
        ok: false,
        reason: 'No ESC/POS port is open. Connect the peripheral first.',
      };
    }
    try {
      this.writer ??= this.port.writable.getWriter();
      await this.writer!.write(new Uint8Array(bytes));
      return { ok: true, detail: `${bytes.length} byte(s) written to the peripheral.` };
    } catch (err) {
      // A writer that has errored is single-use; drop it so the next attempt
      // re-acquires the lock instead of failing forever on a poisoned handle.
      this.writer = null;
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'The peripheral rejected the write.',
      };
    }
  }

  /**
   * Fires the drawer kick.
   *
   * Returns `ok: false` — never a fabricated success — when no port is open or
   * the write failed. The previous implementation logged a line and returned
   * `true`, so the button's outcome was untestable and untrue.
   */
  public openCashDrawer(): Promise<HardwareOutcome> {
    // ESC p m=0 t1=0x19 t2=0xFA — the Epson "kick the drawer" pulse.
    return this.write([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  }

  /**
   * Sends one line of Latin text to the printer.
   *
   * Only code-page-437-representable text is written. An ESC/POS printer cannot
   * render Arabic glyphs, and a till that silently printed mojibake on a receipt
   * would be worse than one that refuses — so non-Latin text is refused with the
   * reason, and the caller falls back to the browser print dialog.
   */
  public async printLine(text: string): Promise<HardwareOutcome> {
    if (/[^\x20-\xff]/.test(text)) {
      return {
        ok: false,
        reason:
          'The ESC/POS code page cannot render this text. '
          + 'Use the browser print dialog for Arabic receipts.',
      };
    }
    const bytes = [...text].map((ch) => ch.charCodeAt(0) & 0xff);
    return this.write([...bytes, 0x0a]);
  }

  /** Paper cut: GS V m=0. */
  public async cutPaper(): Promise<HardwareOutcome> {
    return this.write([0x1d, 0x56, 0x00]);
  }

  public async disconnect(): Promise<void> {
    try {
      this.writer?.releaseLock();
    } catch {
      /* the lock is already gone; nothing to release */
    }
    this.writer = null;
    try {
      await this.port?.close();
    } catch {
      /* the device was unplugged; the port is already dead */
    }
    this.port = null;
  }
}

export const escposPeripheral = new EscPosPeripheral();

/* ═══════════════════════════════════════════════════════════════════════════
 * The device facade the screens use
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The scale reading the screens consume.
 *
 * `netWeightKg` is `null` when no scale has reported — the shape that makes it
 * impossible to render a fabricated weight, because there is no number left to
 * render. A typed weight is kept apart from a measured one by `fromDevice`,
 * because "45 kg, measured" and "45 kg, typed" are different claims about a
 * sale and the screen must not conflate them.
 */
export interface ScaleReading {
  /** Gross weight reported so far, or `null` when nothing has reported one. */
  weightKg: number | null;
  /** Tare in force, or `null` when no weight has been established. */
  tareKg: number | null;
  /** `weightKg - tareKg`, or `null` when the gross is unknown. */
  netWeightKg: number | null;
  /** True only when the reported weight was stable. */
  isStable: boolean;
  /** True when hardware produced this reading; false when an operator typed it. */
  fromDevice: boolean;
}

/** The only reading a screen may show before any weight has been established. */
export const NO_SCALE_READING: ScaleReading = Object.freeze({
  weightKg: null,
  tareKg: null,
  netWeightKg: null,
  isStable: false,
  fromDevice: false,
});

/**
 * The hardware a POS screen is allowed to assume.
 *
 * Cash and bank transfer need none of it. Card checkout goes through the server.
 * A scale and a drawer are peripherals, and a screen that pretends to have one
 * is precisely the defect this module replaces.
 */
class DeviceGateway {
  private reading: ScaleReading = NO_SCALE_READING;
  private listeners = new Set<(r: ScaleReading) => void>();

  /** The current reading; `null` fields until a device or an operator reports. */
  public getScaleReading(): ScaleReading {
    return this.reading;
  }

  /**
   * Publishes a weight the operator typed at the till.
   *
   * A negative or non-finite value is not a weight, so it clears to "no reading"
   * rather than being stored: an unparseable field must never become a number in
   * a settlement.
   */
  public reportManualWeight(manualKg: number | null): ScaleReading {
    const valid = typeof manualKg === 'number' && Number.isFinite(manualKg) && manualKg >= 0;
    this.reading = valid
      ? { weightKg: manualKg, tareKg: 0, netWeightKg: manualKg, isStable: true, fromDevice: false }
      : NO_SCALE_READING;
    this.notify();
    return this.reading;
  }

  /** Publishes a weight a real device measured, with its tare applied. */
  public reportDeviceWeight(weightKg: number, tareKg = 0): ScaleReading {
    if (!Number.isFinite(weightKg)) return this.clearScale();
    const tare = Number.isFinite(tareKg) && tareKg > 0 ? tareKg : 0;
    this.reading = {
      weightKg,
      tareKg: tare,
      netWeightKg: Math.max(0, Math.round((weightKg - tare) * 1000) / 1000),
      isStable: true,
      fromDevice: true,
    };
    this.notify();
    return this.reading;
  }

  /** Clears to the honest "no scale" reading. */
  public clearScale(): ScaleReading {
    this.reading = NO_SCALE_READING;
    this.notify();
    return this.reading;
  }

  /** Subscribes to readings; fires immediately with the current one. */
  public subscribeScale(callback: (reading: ScaleReading) => void): () => void {
    this.listeners.add(callback);
    callback(this.reading);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * Opens the cash drawer, returning the peripheral's verdict unchanged.
   *
   * The old signature returned `true` unconditionally, which made the button's
   * outcome both untestable and untrue.
   */
  public openCashDrawer(): Promise<HardwareOutcome> {
    return escposPeripheral.openCashDrawer();
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this.reading);
  }
}

export const deviceGateway = new DeviceGateway();