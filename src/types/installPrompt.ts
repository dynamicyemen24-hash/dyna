export type InstallPlatform =
  | 'ios'
  | 'android'
  | 'desktop'
  | 'unknown';

export type InstallAvailability =
  | 'native'
  | 'manual'
  | 'installed'
  | 'unavailable';

export type ShareResult =
  | 'shared'
  | 'copied'
  | 'failed';

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
}

export interface InstallCapabilities {
  platform: InstallPlatform;
  standalone: boolean;
  ios: boolean;
  nativePrompt: boolean;
  manualInstall: boolean;
  canShare: boolean;
  canClipboard: boolean;
}