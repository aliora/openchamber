const DECIDED_KEY = 'openchamber.mobile.notificationPromptDecided';

type PromptStorage = Pick<Storage, 'getItem' | 'setItem'>;

export type NotificationPromptGate = {
  ready: boolean;
  decided: boolean;
  nativeNotificationsEnabled: boolean;
  engineSetupOpen: boolean;
};

export const shouldOfferNotificationPrompt = (gate: NotificationPromptGate): boolean =>
  gate.ready && !gate.decided && !gate.nativeNotificationsEnabled && !gate.engineSetupOpen;

const defaultStorage = (): PromptStorage | null => globalThis.window?.localStorage ?? null;

export const readNotificationPromptDecided = (storage?: PromptStorage): boolean => {
  try {
    return (storage ?? defaultStorage())?.getItem(DECIDED_KEY) === '1';
  } catch {
    return false;
  }
};

export const markNotificationPromptDecided = (storage?: PromptStorage): boolean => {
  try {
    const target = storage ?? defaultStorage();
    target?.setItem(DECIDED_KEY, '1');
    return target !== null;
  } catch {
    return false;
  }
};
