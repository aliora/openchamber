let checkPending = false;

export const requestEngineSetupCheck = (): void => {
  checkPending = true;
};

export const takeEngineSetupCheck = (): boolean => {
  const pending = checkPending;
  checkPending = false;
  return pending;
};
