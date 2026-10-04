export interface DeviceStatus {
  thermalPrinter: 'connected' | 'disconnected' | 'paper_low';
  digitalScale: 'connected' | 'disconnected' | 'tare_active';
  cashDrawer: 'closed' | 'open';
  barcodeScanner: 'ready' | 'scanning';
  customerDisplay: 'active' | 'standby';
}

export interface ScaleReading {
  weightKg: number;
  tareKg: number;
  netWeightKg: number;
  isStable: boolean;
}

class DeviceGateway {
  private scaleListeners: ((reading: ScaleReading) => void)[] = [];
  private currentWeight = 1.45;
  private currentTare = 0;

  constructor() {
    // Simulate real-time digital scale hardware ticks
    setInterval(() => {
      // Slight jitter simulating weight placed on scale
      const noise = (Math.random() - 0.5) * 0.02;
      this.currentWeight = Math.max(0, Math.round((this.currentWeight + noise) * 1000) / 1000);
      this.notifyScaleListeners();
    }, 1500);
  }

  public setWeight(kg: number) {
    this.currentWeight = kg;
    this.notifyScaleListeners();
  }

  public setTare() {
    this.currentTare = this.currentWeight;
    this.notifyScaleListeners();
  }

  public clearTare() {
    this.currentTare = 0;
    this.notifyScaleListeners();
  }

  public subscribeScale(callback: (reading: ScaleReading) => void) {
    this.scaleListeners.push(callback);
    callback(this.getScaleReading());
    return () => {
      this.scaleListeners = this.scaleListeners.filter((l) => l !== callback);
    };
  }

  public getScaleReading(): ScaleReading {
    const net = Math.max(0, this.currentWeight - this.currentTare);
    return {
      weightKg: this.currentWeight,
      tareKg: this.currentTare,
      netWeightKg: Math.round(net * 1000) / 1000,
      isStable: true,
    };
  }

  public openCashDrawer() {
    console.log('[IoT Gateway] Sending pulse trigger (24V 100ms) to Cash Drawer via ESC/POS...');
    return true;
  }

  public printReceiptEscPos(receiptHtml: string) {
    console.log('[IoT Gateway] Sending raw ESC/POS raster print job to Thermal Printer (80mm)...');
    return true;
  }

  private notifyScaleListeners() {
    const reading = this.getScaleReading();
    this.scaleListeners.forEach((fn) => fn(reading));
  }
}

export const deviceGateway = new DeviceGateway();
