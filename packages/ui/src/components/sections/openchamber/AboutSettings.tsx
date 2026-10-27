import React from 'react';
import { isCapacitorApp } from '@/lib/platform';
import { useDeviceInfo } from '@/lib/device';
import { Icon } from "@/components/icon/Icon";
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useDesktopRemoteHostActive } from '@/hooks/useDesktopRemoteHostActive';
import { getDesktopAppVersion } from '@/lib/desktopNative';
import { InstanceServiceUrls } from './InstanceServiceUrls';
import {
  SettingsSection,
  SETTINGS_BRAND_TITLE_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
} from '@/components/sections/shared/SettingsSection';

const GITHUB_URL = 'https://github.com/openchamber/openchamber';
const DISCORD_URL = 'https://discord.gg/ZYRSdnwwKA';
const X_URL = 'https://x.com/openchamber_dev';

/** Version of the installed native app build (Capacitor only). */
function useNativeAppVersion(enabled: boolean): string | null {
  const [version, setVersion] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void import('@capacitor/app')
      .then(({ App }) => App.getInfo())
      .then((info) => {
        if (!cancelled) setVersion(info.version.trim() || null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return version;
}

export const AboutSettings: React.FC = () => {
  const { t } = useI18n();
  const [openChamberVersion, setOpenChamberVersion] = React.useState<string | null>(null);
  const { isMobile } = useDeviceInfo();
  const isNativeApp = React.useMemo(() => isCapacitorApp(), []);
  const isDesktopRemote = useDesktopRemoteHostActive();
  const [desktopAppVersion, setDesktopAppVersion] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!isDesktopRemote) return;
    let cancelled = false;
    void getDesktopAppVersion().then((version) => {
      if (!cancelled) setDesktopAppVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, [isDesktopRemote]);
  const nativeAppVersion = useNativeAppVersion(isNativeApp);
  const currentVersion = openChamberVersion || 'unknown';
  const appVersion = desktopAppVersion || 'unknown';

  React.useEffect(() => {
    let cancelled = false;

    const loadOpenChamberVersion = async () => {
      try {
        const response = await runtimeFetch('/api/system/info', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = await response.json().catch(() => null) as { openchamberVersion?: unknown } | null;
        const version = typeof data?.openchamberVersion === 'string' && data.openchamberVersion.trim().length > 0
          ? data.openchamberVersion.trim()
          : null;
        if (!cancelled) setOpenChamberVersion(version);
      } catch {
        if (!cancelled) setOpenChamberVersion(null);
      }
    };

    void loadOpenChamberVersion();

    return () => {
      cancelled = true;
    };
  }, []);

  if (isMobile) {
    return (
      <div className="w-full space-y-6 pb-2">
        <div className="flex flex-col items-center text-center">
          <OpenChamberLogo width={72} height={72} />
          <h2 className={`mt-4 ${SETTINGS_BRAND_TITLE_CLASS}`}>OpenChamber</h2>
          <div className="mt-2 space-y-1 typography-ui text-muted-foreground">
            {isNativeApp ? (
              <>
                <p>{t('settings.openchamber.about.native.serverOpenChamberVersion', { version: currentVersion })}</p>
                {nativeAppVersion && <p>{t('settings.openchamber.about.native.appVersion', { version: nativeAppVersion })}</p>}
              </>
            ) : isDesktopRemote ? (
              <>
                <p>{t('aboutDialog.appVersionLabel', { version: appVersion })}</p>
                <p>{t('settings.openchamber.about.native.serverOpenChamberVersion', { version: currentVersion })}</p>
              </>
            ) : (
              <p>{t('aboutDialog.openChamberVersionLabel', { version: currentVersion })}</p>
            )}
          </div>
          <InstanceServiceUrls />
        </div>

        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex items-center justify-center gap-5">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="github-fill" className="size-5" />
              <span>GitHub</span>
            </a>

            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
            >
              <Icon name="discord-fill" className="size-5" />
              <span>Discord</span>
            </a>
          </div>

          <a
            href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon name="twitter-xfill" className="size-5" />
            <span>@openchamber_dev</span>
          </a>
        </div>

        <p className="text-center typography-ui text-muted-foreground">
          {t('aboutDialog.footerNote')}
        </p>
      </div>
    );
  }

  // Desktop layout
  return (
    <SettingsSection divider={false}>
      <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
        <div className="flex flex-col @xl:flex-row @xl:items-center justify-between gap-4 px-4 py-3 border-b border-border/40">
          {isDesktopRemote ? (
            <>
              <div className="flex min-w-0 flex-col">
                <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.openchamber.about.field.appVersion')}</span>
                <span className="typography-meta text-muted-foreground font-mono">{appVersion}</span>
              </div>
              <div className="flex min-w-0 flex-col">
                <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.openchamber.about.field.serverVersion')}</span>
                <span className="typography-meta text-muted-foreground font-mono">{currentVersion}</span>
              </div>
            </>
          ) : (
            <div className="flex min-w-0 flex-col">
              <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.openchamber.about.field.version')}</span>
              <span className="typography-meta text-muted-foreground font-mono">{currentVersion}</span>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-b border-border/40 px-4 py-3 @xl:flex-row @xl:items-center @xl:justify-between">
          <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.openchamber.about.field.instanceUrls')}</span>
          <InstanceServiceUrls />
        </div>

        <div className="flex items-center gap-4 px-4 py-4">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground typography-meta transition-colors"
          >
            <Icon name="github-fill" className="h-4 w-4" />
            <span>GitHub</span>
          </a>

            <a
              href={X_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground typography-meta transition-colors"
          >
            <Icon name="twitter-xfill" className="h-4 w-4" />
              <span>@openchamber_dev</span>
            </a>
        </div>
      </div>
    </SettingsSection>
  );
};
