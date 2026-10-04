import type {
  BeforeInstallPromptEvent,
  InstallCapabilities,
  InstallPlatform,
  ShareResult,
} from '../types/installPrompt';

export type {
  BeforeInstallPromptEvent,
  InstallCapabilities,
  InstallPlatform,
  ShareResult,
} from '../types/installPrompt';

export const PLATFORM_LABEL: Record<InstallPlatform, string> = {
  ios: 'iPhone / iPad',
  android: 'Android',
  desktop: 'الكمبيوتر',
  unknown: 'هذا الجهاز',
};

const isBrowser = () =>
  typeof window !== 'undefined' &&
  typeof navigator !== 'undefined';

export const isStandalone = (): boolean => {
  if (!isBrowser()) return false;

  const mediaStandalone = window.matchMedia?.(
    '(display-mode: standalone)',
  ).matches ?? false;

  const iosStandalone =
    'standalone' in navigator &&
    Boolean(
      (navigator as Navigator & { standalone?: boolean }).standalone,
    );

  return mediaStandalone || iosStandalone;
};

export const detectPlatform = (): InstallPlatform => {
  if (!isBrowser()) return 'unknown';

  const ua = navigator.userAgent.toLowerCase();

  const ios =
    /iphone|ipad|ipod/.test(ua) ||
    (/macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  if (ios) return 'ios';

  if (/android/.test(ua)) return 'android';

  if (
    /windows|macintosh|linux|cros/.test(ua)
  ) {
    return 'desktop';
  }

  return 'unknown';
};

export const getInstallCapabilities = (
  deferred: BeforeInstallPromptEvent | null,
): InstallCapabilities => {
  if (!isBrowser()) {
    return {
      platform: 'unknown',
      standalone: false,
      ios: false,
      nativePrompt: false,
      manualInstall: false,
      canShare: false,
      canClipboard: false,
    };
  }

  const platform = detectPlatform();
  const standalone = isStandalone();
  const ios = platform === 'ios';

  return {
    platform,
    standalone,
    ios,
    nativePrompt: Boolean(deferred),
    manualInstall: ios && !standalone,
    canShare: typeof navigator.share === 'function',
    canClipboard:
      typeof navigator.clipboard?.writeText === 'function',
  };
};

export const getCanonicalShareUrl = (): string => {
  if (!isBrowser()) return '';

  /*
   * Preserve the current application route instead of forcing
   * users back to the origin.
   */
  return window.location.href;
};

export const shareOrCopy = async (
  title: string,
  url: string,
  text?: string,
): Promise<ShareResult> => {
  if (!isBrowser()) return 'failed';

  try {
    if (typeof navigator.share === 'function') {
      await navigator.share({
        title,
        text,
        url,
      });

      return 'shared';
    }
  } catch (error) {
    /*
     * AbortError means the user intentionally cancelled sharing.
     * Do not treat cancellation as an application failure.
     */
    if (
      error instanceof DOMException &&
      error.name === 'AbortError'
    ) {
      return 'failed';
    }
  }

  try {
    if (
      typeof navigator.clipboard?.writeText ===
      'function'
    ) {
      await navigator.clipboard.writeText(url);
      return 'copied';
    }
  } catch {
    // Clipboard permission may be unavailable.
  }

  return 'failed';
};

export const isBeforeInstallPromptEvent = (
  event: Event,
): event is BeforeInstallPromptEvent => {
  const candidate = event as Partial<BeforeInstallPromptEvent>;

  return (
    typeof candidate.prompt === 'function' &&
    candidate.userChoice instanceof Promise
  );
};