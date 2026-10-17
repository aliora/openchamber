import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setAppNameKeepingVersion } from './app-name.mjs';

// An `app` whose rename behaves like Electron's on Linux for an unpackaged
// launch: the version falls back to "0.0" unless one was set explicitly.
const linuxScriptApp = (startVersion) => {
  let name = 'Electron';
  let explicitVersion = null;
  let renamed = false;
  const calls = [];
  return {
    calls,
    getName: () => name,
    getVersion: () => explicitVersion ?? (renamed ? '0.0' : startVersion),
    setName: (next) => {
      calls.push(['setName', next]);
      name = next;
      renamed = true;
    },
    setVersion: (next) => {
      calls.push(['setVersion', next]);
      explicitVersion = next;
    },
  };
};

// A packaged app keeps the version from its package.json through a rename.
const packagedApp = (version) => {
  let name = 'Electron';
  const calls = [];
  return {
    calls,
    getName: () => name,
    getVersion: () => version,
    setName: (next) => {
      calls.push(['setName', next]);
      name = next;
    },
    setVersion: (next) => calls.push(['setVersion', next]),
  };
};

describe('setAppNameKeepingVersion', () => {
  it('puts back the version a Linux rename resets to 0.0', () => {
    const app = linuxScriptApp('43.7.0');
    setAppNameKeepingVersion(app, 'OpenChamber');
    assert.equal(app.getName(), 'OpenChamber');
    assert.equal(app.getVersion(), '43.7.0');
    assert.deepEqual(app.calls, [['setName', 'OpenChamber'], ['setVersion', '43.7.0']]);
  });

  it('leaves a version the rename kept alone', () => {
    const app = packagedApp('2.3.3');
    setAppNameKeepingVersion(app, 'OpenChamber');
    assert.equal(app.getName(), 'OpenChamber');
    assert.equal(app.getVersion(), '2.3.3');
    assert.deepEqual(app.calls, [['setName', 'OpenChamber']]);
  });
});
