import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyLocalHostLabel,
  findLoopbackHost,
  focusHostInWindow,
  readLocalHostLabel,
  resolveFocusHostId,
  resolveInitialFocusHostId,
  withInitialFocus,
} from './host-focus.mjs';

const hosts = [
  { id: 'host-mac', url: 'http://127.0.0.1:3000', apiUrl: 'http://127.0.0.1:3000' },
  { id: 'host-pi5', url: 'http://192.168.1.56:3000', apiUrl: 'http://192.168.1.56:3000' },
  { id: 'relay-only', url: 'relay://abc', relay: { serverId: 'abc' } },
];

test('only Local with a local server or a saved host can take the focus', () => {
  assert.equal(resolveFocusHostId('host-pi5', { hosts, localAvailable: false }), 'host-pi5');
  assert.equal(resolveFocusHostId(' local ', { hosts, localAvailable: true }), 'local');
  assert.equal(resolveFocusHostId('local', { hosts, localAvailable: false }), null);
  assert.equal(resolveFocusHostId('gone', { hosts, localAvailable: true }), null);
  assert.equal(resolveFocusHostId(42, { hosts, localAvailable: true }), null);
});

test('a host link that arrived before the window wins over the last focused host', () => {
  assert.equal(resolveInitialFocusHostId({ pendingFocusHostId: 'host-mac', defaultHostId: 'host-pi5', hosts, localAvailable: true }), 'host-mac');
  assert.equal(resolveInitialFocusHostId({ pendingFocusHostId: 'gone', defaultHostId: 'host-pi5', hosts, localAvailable: true }), 'host-pi5');
  assert.equal(resolveInitialFocusHostId({ pendingFocusHostId: null, defaultHostId: null, hosts, localAvailable: true }), null);
});

test('only a working boot carries the host to focus', () => {
  assert.deepEqual(withInitialFocus({ target: 'local', status: 'ok' }, 'host-pi5'), { target: 'local', status: 'ok', initialFocusHostId: 'host-pi5' });
  assert.deepEqual(withInitialFocus({ target: 'local', status: 'unreachable' }, 'host-pi5'), { target: 'local', status: 'unreachable' });
  assert.deepEqual(withInitialFocus({ target: null, status: 'not-configured' }, null), { target: null, status: 'not-configured' });
});

test('the loopback host stands in for this machine without a local server', () => {
  assert.equal(findLoopbackHost(hosts)?.id, 'host-mac');
  assert.equal(findLoopbackHost(hosts.slice(1)), null);
  assert.equal(findLoopbackHost([{ id: 'v6', url: 'http://[::1]:3000' }])?.id, 'v6');
});

test('settings without a local label load unchanged and keep it across writes that omit it', () => {
  const legacy = { desktopHosts: hosts, desktopDefaultHostId: 'host-mac', desktopInitialHostChoiceCompleted: true };
  const root = structuredClone(legacy);
  assert.equal(readLocalHostLabel(root), null);
  applyLocalHostLabel(root, { hosts, defaultHostId: 'host-mac' });
  assert.deepEqual(root, legacy);

  applyLocalHostLabel(root, { localHostLabel: '  This Mac ' });
  assert.equal(readLocalHostLabel(root), 'This Mac');
  applyLocalHostLabel(root, { hosts });
  assert.equal(readLocalHostLabel(root), 'This Mac');
  applyLocalHostLabel(root, { localHostLabel: '' });
  assert.equal('desktopLocalHostLabel' in root, false);
});

const fakeWindow = ({ loading = false, destroyed = false, minimized = false } = {}) => {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
    webContents: { isLoading: () => loading },
  };
};

test('a loaded main window gets focus-host and comes to the front', () => {
  const window = fakeWindow({ minimized: true });
  const emitted = [];
  const remembered = [];
  const delivered = focusHostInWindow({
    hostId: 'host-pi5',
    mainWindow: window,
    emit: (target, event, detail) => emitted.push({ target, event, detail }),
    remember: (id) => remembered.push(id),
  });
  assert.equal(delivered, true);
  assert.deepEqual(window.calls, ['restore', 'show', 'focus']);
  assert.deepEqual(emitted, [{ target: window, event: 'openchamber:focus-host', detail: { hostId: 'host-pi5' } }]);
  assert.deepEqual(remembered, []);
});

test('without a ready main window the host is kept for the next boot outcome', () => {
  for (const mainWindow of [null, fakeWindow({ loading: true }), fakeWindow({ destroyed: true })]) {
    const remembered = [];
    const emitted = [];
    const delivered = focusHostInWindow({
      hostId: 'host-mac',
      mainWindow,
      emit: () => emitted.push(true),
      remember: (id) => remembered.push(id),
    });
    assert.equal(delivered, false);
    assert.deepEqual(remembered, ['host-mac']);
    assert.deepEqual(emitted, []);
  }
});
