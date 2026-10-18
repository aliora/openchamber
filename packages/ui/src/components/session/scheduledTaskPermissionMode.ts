import {
  findEngineForProvider,
  type EngineControls,
  type EngineControlsCatalog,
  type EnginePermissionModeOption,
} from '@/stores/useEngineControlsStore';

interface TaskPermission {
  engine: EngineControls;
  mode: EnginePermissionModeOption;
}

export const resolveTaskPermission = (
  catalog: EngineControlsCatalog | null,
  providerId: string,
  modeId: string,
): TaskPermission | null => {
  const engine = findEngineForProvider(catalog, providerId);
  if (!engine) return null;
  const mode = engine.permissionModes.find((option) => option.id === modeId)
    ?? engine.permissionModes.find((option) => option.id === engine.defaultPermissionMode);
  return mode ? { engine, mode } : null;
};

export const taskPermissionModeToSave = (
  catalog: EngineControlsCatalog | null,
  providerId: string,
  modeId: string,
): string | undefined => {
  if (!modeId) return undefined;
  const engine = findEngineForProvider(catalog, providerId);
  if (!engine) return modeId;
  const listed = engine.permissionModes.some((option) => option.id === modeId);
  return listed && modeId !== engine.defaultPermissionMode ? modeId : undefined;
};
