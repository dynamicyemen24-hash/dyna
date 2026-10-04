import React, { useState, useEffect } from 'react';
import { scaleHAL, ScaleReading, ConnectionStatus, ScaleProtocol } from '../services/scaleProtocolHAL';
import { Scale, Usb, Bluetooth, RefreshCw, CheckCircle2, ShieldAlert, Cpu } from 'lucide-react';

interface ScaleHALWidgetProps {
  onAutoPopulateWeight?: (weightKg: number) => void;
}

export const ScaleHALWidget: React.FC<ScaleHALWidgetProps> = ({ onAutoPopulateWeight }) => {
  const [reading, setReading] = useState<ScaleReading>({
    weightKg: 1.45,
    tareKg: 0,
    netWeightKg: 1.45,
    unit: 'kg',
    isStable: true,
    overload: false,
    rawString: '',
    protocol: 'NCI',
  });

  const [status, setStatus] = useState<ConnectionStatus>('simulated');
  const [protocol, setProtocol] = useState<ScaleProtocol>('NCI');
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const unsubReading = scaleHAL.subscribe((r) => setReading(r));
    const unsubStatus = scaleHAL.subscribeStatus((s) => setStatus(s));
    return () => {
      unsubReading();
      unsubStatus();
    };
  }, []);

  const handleConnectUSB = async () => {
    await scaleHAL.connectWebSerial();
  };

  const handleConnectBluetooth = async () => {
    await scaleHAL.connectBluetooth();
  };

  const handleApplyWeight = () => {
    if (onAutoPopulateWeight) {
      onAutoPopulateWeight(reading.netWeightKg);
    }
  };

  return (
    <div className="font-['Cairo',sans-serif]">
      {/* Live Compact Scale Reader Bar */}
      <div className="flex items-center gap-2 bg-slate-900 border border-brand-500/40 px-3 py-1.5 rounded-2xl shadow-sm">
        <button
          onClick={() => setIsOpen(true)}
          className="flex items-center gap-1.5 text-xs font-mono font-bold text-brand-400 hover:text-brand-300 transition-colors"
          title="انقر لفتح إعدادات الميزان الإلكتروني والبروتوكولات"
        >
          <Scale className="w-4 h-4 text-brand-400" />
          <span>{reading.netWeightKg.toFixed(3)} {reading.unit}</span>
        </button>

        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-slate-950 text-slate-300 border border-slate-800">
          {status === 'connected_web_serial'
            ? 'USB RS232'
            : status === 'connected_bluetooth'
            ? 'Bluetooth'
            : 'ميزان ذكي'}
        </span>

        {onAutoPopulateWeight && (
          <button
            onClick={handleApplyWeight}
            className="bg-brand-600 hover:bg-brand-500 text-white px-2.5 py-1 rounded-xl text-[10px] font-bold shadow-md transition-all"
            title="إدراج الوزن الحالي تلقائياً في خانة الكمية/الوزن"
          >
            إدراج الوزن
          </button>
        )}
      </div>

      {/* Scale Settings & Connection Modal */}
      {isOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 shadow-2xl relative animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800 mb-4">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Cpu className="w-5 h-5 text-brand-400" />
                طبقة ربط الموازين الإلكترونية (Scale HAL)
              </h3>
              <button onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-white">
                ✕
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Live Weight Display Card */}
              <div className="bg-slate-950 p-4 rounded-2xl border border-slate-800 text-center space-y-1">
                <p className="text-[10px] text-slate-400">قراءة الميزان المباشرة (Live Output)</p>
                <p className="text-3xl font-black font-mono text-brand-400">
                  {reading.netWeightKg.toFixed(3)} <span className="text-sm font-normal text-slate-400">{reading.unit}</span>
                </p>
                <p className="text-[10px] text-slate-500 font-mono">
                  القائم: {reading.weightKg.toFixed(3)} | الخصم/Tare: {reading.tareKg.toFixed(3)}
                </p>
                <div className="text-[9px] font-mono text-slate-600 truncate mt-1">
                  Raw Output: {reading.rawString.trim() || 'N/A'}
                </div>
              </div>

              {/* Protocol Selection */}
              <div>
                <label className="block text-slate-300 font-bold mb-1.5">بروتوكول الميزان (Protocol Type):</label>
                <select
                  value={protocol}
                  onChange={(e) => {
                    const p = e.target.value as ScaleProtocol;
                    setProtocol(p);
                    scaleHAL.setProtocol(p);
                  }}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-brand-500 cursor-pointer"
                >
                  <option value="NCI">NCI / Avery Weigh-Tronix (قياسي عالي السرعة)</option>
                  <option value="METTLER_TOLEDO">Mettler Toledo SICS Protocol</option>
                  <option value="CAS_ASCII">CAS / Dibal Continuous ASCII</option>
                  <option value="GENERIC_CONTINUOUS">Generic Continuous Stream</option>
                </select>
              </div>

              {/* Connection Actions */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  onClick={handleConnectUSB}
                  className="bg-slate-950 hover:bg-slate-800 text-brand-400 border border-brand-500/30 p-3 rounded-xl font-bold flex flex-col items-center gap-1 transition-all"
                >
                  <Usb className="w-5 h-5 text-brand-400" />
                  <span>ربط USB / RS-232</span>
                </button>

                <button
                  onClick={handleConnectBluetooth}
                  className="bg-slate-950 hover:bg-slate-800 text-blue-400 border border-blue-500/30 p-3 rounded-xl font-bold flex flex-col items-center gap-1 transition-all"
                >
                  <Bluetooth className="w-5 h-5 text-blue-400" />
                  <span>ربط Bluetooth BLE</span>
                </button>
              </div>

              {/* Scale Hardware Controls */}
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800">
                <button
                  onClick={() => scaleHAL.sendTareCommand()}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 py-2 rounded-xl font-bold text-center"
                >
                  تصفير الطبلية (Tare)
                </button>
                <button
                  onClick={() => scaleHAL.sendZeroCommand()}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 py-2 rounded-xl font-bold text-center"
                >
                  إعادة الضبط (Zero)
                </button>
              </div>

              {onAutoPopulateWeight && (
                <button
                  onClick={() => {
                    handleApplyWeight();
                    setIsOpen(false);
                  }}
                  className="w-full bg-brand-600 hover:bg-brand-500 text-white py-2.5 rounded-xl font-bold transition-all shadow-lg shadow-brand-600/30"
                >
                  اعتماد الوزن الحالي ({reading.netWeightKg.toFixed(3)} كجم)
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
