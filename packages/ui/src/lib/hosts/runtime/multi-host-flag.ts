let multiHostSurface = false;

export const setMultiHostRuntime = (enabled: boolean): void => {
  multiHostSurface = enabled;
};

export const isMultiHostRuntimeEnabled = (): boolean => multiHostSurface;

export const isHostFocusMove = (detail: { runtimeKey: string; previousRuntimeKey: string }): boolean => (
  detail.runtimeKey !== detail.previousRuntimeKey && isMultiHostRuntimeEnabled()
);
