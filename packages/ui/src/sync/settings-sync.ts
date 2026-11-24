import { isVSCodeRuntime } from '@/lib/desktop';
import { getOpenchamberEventsRuntimeKey, subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { invalidateSettingsCache, syncDesktopSettings } from '@/lib/persistence';

export const subscribeSettingsSync = (runtimeKey: string): (() => void) => {
  if (isVSCodeRuntime()) return () => undefined;
  return subscribeOpenchamberEvents((event) => {
    if (runtimeKey !== getOpenchamberEventsRuntimeKey()) return;
    if (event.type === 'settings-updated') {
      invalidateSettingsCache();
      void syncDesktopSettings({ bootstrap: false });
    }
  });
};
