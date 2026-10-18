import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import type { ModelSelection } from './DefaultModelStep';

type SetupChanges = { engineSetupCompleted: true; defaultModel?: string; defaultVariant?: string };

export const completeEngineSetup = async (selection: ModelSelection | null): Promise<void> => {
  const changes: SetupChanges = { engineSetupCompleted: true };
  const value = selection ? `${selection.providerID}/${selection.modelID}` : null;
  if (value) {
    changes.defaultModel = value;
    changes.defaultVariant = '';
  }
  try {
    const result = await updateDesktopSettings(changes);
    if (value && result.ok) useConfigStore.getState().setSettingsDefaultModel(value);
  } catch (error) {
    console.warn('Failed to save engine setup:', error);
  }
};
