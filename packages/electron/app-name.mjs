/**
 * Renames the app without losing its version. On Linux, an unpackaged launch
 * (`electron ./entry.mjs`, which `electron:dev` runs) has no package version,
 * and `app.setName()` resets `app.getVersion()` to "0.0". electron-updater
 * reads that version when `main.mjs` loads and rejects it as not semver, so
 * the dev app stopped before its first window. The version the app had
 * before the rename is put back; a packaged app keeps its own and is left
 * as it is.
 */
export const setAppNameKeepingVersion = (app, name) => {
  const version = app.getVersion();
  app.setName(name);
  if (app.getVersion() !== version) app.setVersion(version);
};
