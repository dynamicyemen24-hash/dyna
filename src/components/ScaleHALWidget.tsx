import React, { useState, useEffect } from 'react';
import { scaleHAL, NO_FRAME, ScaleReading, ConnectionStatus, ScaleProtocol } from '../services/scaleProtocolHAL';
import { Scale, Usb, Bluetooth, RefreshCw, CheckCircle2, ShieldAlert, Cpu } from 'lucide-react';

interface ScaleHALWidgetProps {
  onAutoPopulateWeight?: (weightKg: number) => void;
}

export const ScaleHALWidget: React.FC<ScaleHALWidgetProps> = ({ onAutoPopulateWeight }) => {
  /*
   * ══ THE FABRICATED READING THIS REPLACES ════════════════════════════════════
   * The state was seeded with a 1.45 kg reading marked stable, so the login screen
   * displayed "1.450 kg" from a scale that had never been connected. The transport
   * also defaulted to `'simulated'`, which is why the badge showed a live weight
   * on a machine with no hardware at all.
   *
   * It now starts from the HAL's own `NO_FRAME` — every field zero but
   * `isStable: false`, which is what distinguishes "the scale weighed nothing"
   * from "no scale has spoken yet". The constant is imported rather than
   * re-typed because a hand-written copy of the empty state is precisely how a
   * fabricated seed appears in the first place.
   */
  const [reading, setReading] = useState<ScaleReading>(NO_FRAME);

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');

  /**
   * The connection verdict of the last attempt.
   *
   * `connectWebSerial` and `connectBluetooth` return `{ ok, reason }` rather than
   * a bare boolean, and both used to silently restart a simulation on failure.
   * The reason is shown so "it did not work" is diagnosable at the till.
   */
  const [connectError, setConnectError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  /**
   * A weight is shown only when the transport is connected AND the last frame
   * was stable. Anything else renders the state, never a number.
   */
  const hasLiveReading =
    (status === 'connected_web_serial' || status === 'connected_bluetooth')
    && reading.isStable;
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

  /**
   * Connects over the requested transport and surfaces the real outcome.
   *
   * The previous handlers ignored a returned boolean and let the HAL restart its
   * simulation on failure, so an operator whose scale would not pair saw a
   * cheerful "USB RS232" badge and changing digits.
   */
  const handleConnectUSB = async () => {
    setIsBusy(true);
    setConnectError(null);
    const outcome = await scaleHAL.connectWebSerial();
    if (!outcome.ok) setConnectError(outcome.reason);
    setIsBusy(false);
  };

  const handleConnectBluetooth = async () => {
    setIsBusy(true);
    setConnectError(null);
    const outcome = await scaleHAL.connectBluetooth();
    if (!outcome.ok) setConnectError(outcome.reason);
    setIsBusy(false);
  };

  /**
   * Hands the current weight to the caller.
   *
   * Guarded on `hasLiveReading`, so a disconnected scale cannot inject 0 kg into
   * a quantity field — which is how a weighed item is sold for nothing.
   */
  const handleApplyWeight = () => {
    if (!hasLiveReading || !onAutoPopulateWeight) return;
    onAutoPopulateWeight(reading.netWeightKg);
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
          {/*
            A number appears ONLY when a connected device reported a stable
            weight. Otherwise the state is named — displaying "0.000 kg" for an
            absent scale reads as a measurement of nothing, which it is not.
          */}
          <span>
            {hasLiveReading ? `${reading.netWeightKg.toFixed(3)} ${reading.unit}` : 'غير متصل'}
          </span>
        </button>

        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-slate-950 text-slate-300 border border-slate-800">
          {status === 'connected_web_serial'
            ? 'USB RS232'
            : status === 'connected_bluetooth'
            ? 'Bluetooth'
            : status === 'connecting'
            ? 'جارٍ الاتصال…'
            : 'لا يوجد ميزان'}
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
                <p className="text-[10px] text-slate-400">
                {hasLiveReading ? 'القراءة المباشرة من الميزان:' : 'لا يوجد ميزان متصل — لم تُعرض أي قراءة.'}
              </p>
              <p className="text-3xl font-black font-mono text-brand-400">
                {hasLiveReading ? reading.netWeightKg.toFixed(3) : '—'}{' '}
                <span className="text-sm font-normal text-slate-400">{hasLiveReading ? reading.unit : ''}</span>
              </p>
              <p className="text-[9px] text-slate-500 font-mono">
                الوزن القائم: {hasLiveReading ? reading.weightKg.toFixed(3) : '—'} | الطبلية:{' '}
                {hasLiveReading ? reading.tareKg.toFixed(3) : '—'}
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

              {/*
                The reason the last connection attempt failed, named in place.
                Previously a failed attempt was invisible: the catch restarted a
                simulation, so the operator saw a live-looking reading and no
                indication that their scale had never been opened.
              */}
              {connectError && (
                <p
                  role="alert"
                  className="text-[10px] font-bold text-rose-300 bg-rose-950/60 border border-rose-800/60 rounded-xl px-3 py-2"
                >
                  {connectError}
                </p>
              )}

              {/* Connection Actions */}
              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => void handleConnectUSB()}
                  disabled={isBusy}
                  className="bg-slate-950 hover:bg-slate-800 text-brand-400 border border-brand-500/30 p-3 rounded-xl font-bold flex flex-col items-center gap-1 transition-all disabled:opacity-50"
                >
                  <Usb className="w-5 h-5 text-brand-400" />
                  <span>ربط USB / RS-232</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleConnectBluetooth()}
                  disabled={isBusy}
                  className="bg-slate-950 hover:bg-slate-800 text-blue-400 border border-blue-500/30 p-3 rounded-xl font-bold flex flex-col items-center gap-1 transition-all disabled:opacity-50"
                >
                  <Bluetooth className="w-5 h-5 text-blue-400" />
                  <span>ربط Bluetooth BLE</span>
                </button>
              </div>

              {/*
                Scale hardware controls. Both are disabled with no device
                connected: the old handlers edited a local copy of a simulated
                reading when `status === 'simulated'`, so a "tare" could appear to
                succeed on hardware that did not exist.
              */}
              <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    void scaleHAL.sendTareCommand().then((r) => {
                      if (!r.ok) setConnectError(r.reason);
                    });
                  }}
                  disabled={status !== 'connected_web_serial'}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 py-2 rounded-xl font-bold text-center disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  تصفير الطبلية (Tare)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void scaleHAL.sendZeroCommand().then((r) => {
                      if (!r.ok) setConnectError(r.reason);
                    });
                  }}
                  disabled={status !== 'connected_web_serial'}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 py-2 rounded-xl font-bold text-center disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  إعادة الضبط (Zero)
                </button>
              </div>

              {onAutoPopulateWeight && (
                <button
                  type="button"
                  onClick={() => {
                    handleApplyWeight();
                    setIsOpen(false);
                  }}
                  disabled={!hasLiveReading}
                  className="w-full bg-brand-600 hover:bg-brand-500 text-white py-2.5 rounded-xl font-bold transition-all shadow-lg shadow-brand-600/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {hasLiveReading
                    ? `اعتماد الوزن الحالي (${reading.netWeightKg.toFixed(3)} كجم)`
                    : 'لا يوجد وزن مقيس لاعتماده'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
