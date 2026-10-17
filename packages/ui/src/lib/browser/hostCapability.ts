let headlessBrowserAvailable = false;
let capabilityKnown = false;

const isElectronHost = (): boolean => Boolean(globalThis.window?.__OPENCHAMBER_ELECTRON__);

export const canDriveBrowserPage = (): boolean => isElectronHost() || headlessBrowserAvailable;

export const usesServerBrowser = (): boolean => !isElectronHost() && headlessBrowserAvailable;

export const isBrowserCapabilityKnown = (): boolean => isElectronHost() || capabilityKnown;

export const setHeadlessBrowserAvailable = (available: boolean): void => {
  headlessBrowserAvailable = available;
  capabilityKnown = true;
};
