import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import {
  Check,
  Copy,
  Download,
  Monitor,
  Share2,
  Smartphone,
  X,
} from 'lucide-react';

import {
  BeforeInstallPromptEvent,
  detectPlatform,
  getCanonicalShareUrl,
  isBeforeInstallPromptEvent,
  isStandalone,
  PLATFORM_LABEL,
  shareOrCopy,
} from '../services/installPrompt';

type Platform = ReturnType<typeof detectPlatform>;

const SHARE_TITLE =
  'منصة التجارة';

const SHARE_TEXT =
  'افتح منصة التجارة للوصول إلى نظام إدارة الأعمال والمبيعات.';

const COPY_FEEDBACK_MS = 2200;

const InstallPrompt: React.FC = () => {
  const [deferred, setDeferred] =
    useState<BeforeInstallPromptEvent | null>(null);

  const [installed, setInstalled] = useState(false);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [copied, setCopied] = useState(false);

  const [platform] = useState<Platform>(() =>
    detectPlatform(),
  );

  const copyTimerRef =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  const installLockRef = useRef(false);

  const titleId = useId();
  const descriptionId = useId();

  /*
   * Initial + lifecycle synchronization.
   */
  useEffect(() => {
    const syncInstalled = () => {
      setInstalled(isStandalone());

      if (isStandalone()) {
        setDeferred(null);
        setOpen(false);
        setInstalling(false);
        installLockRef.current = false;
      }
    };

    syncInstalled();

    const mediaQuery =
      window.matchMedia?.(
        '(display-mode: standalone)',
      );

    mediaQuery?.addEventListener?.(
      'change',
      syncInstalled,
    );

    window.addEventListener(
      'appinstalled',
      syncInstalled,
    );

    return () => {
      mediaQuery?.removeEventListener?.(
        'change',
        syncInstalled,
      );

      window.removeEventListener(
        'appinstalled',
        syncInstalled,
      );
    };
  }, []);

  /*
   * Native Chromium installation capability.
   */
  useEffect(() => {
    const handleBeforeInstallPrompt = (
      event: Event,
    ) => {
      if (!isBeforeInstallPromptEvent(event)) {
        return;
      }

      event.preventDefault();

      if (isStandalone()) {
        return;
      }

      setDeferred(event);
    };

    window.addEventListener(
      'beforeinstallprompt',
      handleBeforeInstallPrompt,
    );

    return () => {
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt,
      );
    };
  }, []);

  /*
   * Present the offer only after the browser confirms
   * native installation capability.
   *
   * iOS is handled manually because Safari does not expose
   * beforeinstallprompt.
   */
  useEffect(() => {
    if (installed) return;

    if (deferred || platform === 'ios') {
      setOpen(true);
    }
  }, [deferred, installed, platform]);

  /*
   * Cleanup all transient resources.
   */
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const close = useCallback(() => {
    if (installing) return;

    setOpen(false);
  }, [installing]);

  const openInstall = useCallback(() => {
    if (installed) return;

    setOpen(true);
  }, [installed]);

  const runInstall = useCallback(async () => {
    if (
      !deferred ||
      installing ||
      installLockRef.current
    ) {
      return;
    }

    installLockRef.current = true;
    setInstalling(true);

    try {
      await deferred.prompt();

      const choice = await deferred.userChoice;

      if (choice.outcome === 'accepted') {
        setInstalled(true);
        setOpen(false);
      }
    } catch {
      /*
       * Installation is optional UX.
       * Never break POS operation because the browser
       * refused or interrupted the install prompt.
       */
    } finally {
      /*
       * beforeinstallprompt is single-use.
       */
      setDeferred(null);
      setInstalling(false);
      installLockRef.current = false;
    }
  }, [deferred, installing]);

  const share = useCallback(async () => {
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }

    setCopied(false);

    const result = await shareOrCopy(
      SHARE_TITLE,
      getCanonicalShareUrl(),
      SHARE_TEXT,
    );

    if (result !== 'copied') {
      return;
    }

    setCopied(true);

    copyTimerRef.current = setTimeout(() => {
      setCopied(false);
      copyTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  }, []);

  /*
   * Hooks must always run before conditional rendering.
   */
  const offerable =
    !installed &&
    Boolean(deferred || platform === 'ios');

  if (!offerable) {
    return null;
  }

  const nativeInstall = Boolean(deferred);

  return (
    <>
      <button
        type="button"
        dir="rtl"
        onClick={openInstall}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="
          fixed bottom-5 left-5 z-[70]
          inline-flex items-center gap-2
          rounded-full
          border border-white/10
          bg-slate-900/95
          px-4 py-2.5
          text-[12px] font-semibold text-white
          shadow-xl
          backdrop-blur
          transition
          hover:bg-slate-800
          active:scale-[0.98]
          focus-visible:outline-none
          focus-visible:ring-2
          focus-visible:ring-brand-500
          focus-visible:ring-offset-2
        "
      >
        <Download
          size={15}
          aria-hidden="true"
          className="text-brand-400"
        />

        تثبيت التطبيق
      </button>

      {open && (
        <div
          dir="rtl"
          className="
            fixed inset-0 z-[80]
            grid place-items-center
            px-4 sm:px-5
          "
          role="presentation"
        >
          <button
            type="button"
            aria-label="إغلاق نافذة التثبيت"
            onClick={close}
            disabled={installing}
            className="
              absolute inset-0
              cursor-default
              bg-slate-950/70
              backdrop-blur-sm
            "
          />

          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            className="
              relative z-[81]
              w-full max-w-md
              overflow-hidden
              rounded-2xl
              border border-slate-200
              bg-white
              p-5 sm:p-6
              shadow-2xl
            "
          >
            <button
              type="button"
              onClick={close}
              disabled={installing}
              aria-label="إغلاق"
              className="
                absolute left-3 top-3
                grid h-9 w-9
                place-items-center
                rounded-lg
                text-slate-400
                transition
                hover:bg-slate-100
                hover:text-slate-700
                focus-visible:outline-none
                focus-visible:ring-2
                focus-visible:ring-brand-500
                disabled:cursor-not-allowed
                disabled:opacity-50
              "
            >
              <X size={17} aria-hidden="true" />
            </button>

            <header className="mb-5 text-center">
              <img
                src="/icons/icon-192.png"
                alt=""
                width={64}
                height={64}
                loading="eager"
                decoding="async"
                className="
                  mx-auto h-16 w-16
                  rounded-2xl
                  shadow-lg
                "
              />

              <h2
                id={titleId}
                className="
                  mt-3
                  text-base
                  font-bold
                  text-slate-900
                "
              >
                ثبّت منصة التجارة على جهازك
              </h2>

              <p
                id={descriptionId}
                className="
                  mt-1
                  text-xs
                  leading-6
                  text-slate-500
                "
              >
                وصول أسرع إلى النظام وتجربة أقرب إلى
                التطبيق على جهازك.
              </p>
            </header>

            {nativeInstall ? (
              <NativeInstall
                target={platform}
                installing={installing}
                onInstall={runInstall}
              />
            ) : (
              <IOSInstallGuide />
            )}

            <button
              type="button"
              onClick={share}
              className="
                mt-4
                flex w-full
                items-center justify-center gap-2
                rounded-lg
                border border-slate-200
                px-4 py-3
                text-xs font-semibold
                text-slate-700
                transition
                hover:bg-slate-50
                focus-visible:outline-none
                focus-visible:ring-2
                focus-visible:ring-brand-500
              "
            >
              {copied ? (
                <Check
                  size={14}
                  aria-hidden="true"
                  className="text-brand-600"
                />
              ) : (
                <Copy
                  size={14}
                  aria-hidden="true"
                />
              )}

              {copied
                ? 'تم نسخ الرابط'
                : 'مشاركة رابط التطبيق'}
            </button>

            <p className="
              mt-3
              text-center
              text-[10.5px]
              leading-5
              text-slate-400
            ">
              يمكنك تجاهل هذه الرسالة — سيستمر منصة التجارة
              في العمل بشكل طبيعي.
            </p>
          </section>
        </div>
      )}
    </>
  );
};

interface NativeInstallProps {
  target: Platform;
  installing: boolean;
  onInstall: () => void;
}

const NativeInstall: React.FC<NativeInstallProps> = ({
  target,
  installing,
  onInstall,
}) => {
  const Icon =
    target === 'desktop'
      ? Monitor
      : Smartphone;

  const label =
    PLATFORM_LABEL[
      target as keyof typeof PLATFORM_LABEL
    ];

  return (
    <>
      <div className="
        mb-4
        flex items-center gap-3
        rounded-xl
        border border-slate-200
        bg-slate-50
        px-3.5 py-3
      ">
        <span className="
          grid h-9 w-9 shrink-0
          place-items-center
          rounded-lg
          bg-white
          text-slate-500
          shadow-sm
        ">
          <Icon
            size={17}
            aria-hidden="true"
          />
        </span>

        <div className="min-w-0">
          <p className="text-[11px] text-slate-500">
            جهاز التثبيت
          </p>

          <p className="
            mt-0.5
            truncate
            text-xs
            font-bold
            text-slate-800
          ">
            {label}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onInstall}
        disabled={installing}
        aria-busy={installing}
        className="
          flex w-full
          items-center justify-center gap-2
          rounded-xl
          bg-slate-900
          px-4 py-3.5
          text-[13px]
          font-bold
          text-white
          shadow-sm
          transition
          hover:bg-slate-800
          focus-visible:outline-none
          focus-visible:ring-2
          focus-visible:ring-brand-500
          focus-visible:ring-offset-2
          disabled:cursor-wait
          disabled:opacity-70
        "
      >
        {installing ? (
          <>
            <span
              aria-hidden="true"
              className="
                h-4 w-4
                animate-spin
                rounded-full
                border-2
                border-white/30
                border-t-white
              "
            />
            جارٍ تجهيز التثبيت...
          </>
        ) : (
          <>
            <Download
              size={15}
              aria-hidden="true"
            />
            تثبيت منصة التجارة الآن
          </>
        )}
      </button>
    </>
  );
};

const IOSInstallGuide: React.FC = () => (
  <ol
    aria-label="خطوات تثبيت منصة التجارة على iPhone أو iPad"
    className="space-y-3"
  >
    {[
      <>
        افتح قائمة{' '}
        <Share2
          size={13}
          aria-hidden="true"
          className="mx-0.5 inline -mt-0.5"
        />{' '}
        المشاركة في Safari.
      </>,
      <>اختر «إضافة إلى الشاشة الرئيسية».</>,
      <>اضغط «إضافة» لإكمال التثبيت.</>,
    ].map((content, index) => (
      <li
        key={index}
        className="
          flex items-start gap-3
          text-xs
          leading-6
          text-slate-700
        "
      >
        <span
          aria-hidden="true"
          className="
            grid h-6 w-6 shrink-0
            place-items-center
            rounded-full
            bg-brand-100
            text-[11px]
            font-bold
            text-brand-700
          "
        >
          {['١', '٢', '٣'][index]}
        </span>

        <span>{content}</span>
      </li>
    ))}
  </ol>
);

export default InstallPrompt;