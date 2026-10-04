import { useEffect, useState } from 'react';

export type OperatingSystem = 'windows' | 'mac' | 'linux' | 'android' | 'ios' | 'unknown';

export interface SystemInfo {
  os: OperatingSystem;
  osName: string;
  isMobile: boolean;
  isPWAInstalled: boolean;
  browserName: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [systemInfo, setSystemInfo] = useState<SystemInfo>({
    os: 'unknown',
    osName: 'جهاز غير معروف',
    isMobile: false,
    isPWAInstalled: false,
    browserName: 'المتصفح القياسي',
  });

  useEffect(() => {
    // Detect OS & Environment
    const ua = navigator.userAgent.toLowerCase();
    let os: OperatingSystem = 'unknown';
    let osName = 'نظام التشغيل القياسي';
    let isMobile = false;

    if (/iphone|ipad|ipod/.test(ua)) {
      os = 'ios';
      osName = ua.includes('ipad') ? 'iPadOS / Apple iPad' : 'iOS / Apple iPhone';
      isMobile = true;
    } else if (/android/.test(ua)) {
      os = 'android';
      osName = 'Android Smart Device';
      isMobile = true;
    } else if (/win/.test(ua)) {
      os = 'windows';
      osName = 'Windows 11 / 10 Enterprise (64-bit)';
    } else if (/mac/.test(ua)) {
      os = 'mac';
      osName = 'macOS Apple Silicon / Intel';
    } else if (/linux/.test(ua)) {
      os = 'linux';
      osName = 'Linux Desktop / Ubuntu Workstation';
    }

    // Detect browser
    let browserName = 'Chrome Browser';
    if (ua.includes('edg')) browserName = 'Microsoft Edge';
    else if (ua.includes('safari') && !ua.includes('chrome')) browserName = 'Apple Safari';
    else if (ua.includes('firefox')) browserName = 'Mozilla Firefox';

    // Check standalone mode
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;

    setIsInstalled(isStandalone);
    setSystemInfo({
      os,
      osName,
      isMobile,
      isPWAInstalled: isStandalone,
      browserName,
    });

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = async (): Promise<boolean> => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setIsInstalled(true);
        setDeferredPrompt(null);
        return true;
      }
      return false;
    }
    return false;
  };

  return {
    isInstallable: !!deferredPrompt,
    isInstalled,
    systemInfo,
    install,
  };
}
