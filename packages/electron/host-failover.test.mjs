import assert from 'node:assert/strict';
import test from 'node:test';
import { hostDirectUrls, sanitizeFailoverUrlsForStorage, selectAnsweringHostUrl } from './host-failover.mjs';

const sanitizeUrl = (raw) => {
  try {
    const parsed = new URL(String(raw).trim());
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
};

test('stores failover addresses in order, dropping invalid, repeated and main-address entries', () => {
  const stored = sanitizeFailoverUrlsForStorage(
    ['http://100.64.0.2:3000', '', 'ftp://nas', 'not a url', 'http://192.168.1.56:3000', 'http://100.64.0.2:3000/', 'https://pi.example'],
    'http://192.168.1.56:3000/',
    sanitizeUrl,
  );
  assert.deepEqual(stored, ['http://100.64.0.2:3000/', 'https://pi.example/']);
});

test('a missing or malformed failover list stores nothing', () => {
  assert.deepEqual(sanitizeFailoverUrlsForStorage(undefined, 'http://a/', sanitizeUrl), []);
  assert.deepEqual(sanitizeFailoverUrlsForStorage('http://b', 'http://a/', sanitizeUrl), []);
});

test('the direct addresses of a host are its main address first, then its failovers', () => {
  assert.deepEqual(
    hostDirectUrls({ url: 'http://a/', apiUrl: 'http://api/', failoverUrls: ['http://b/', 'http://c/'] }),
    ['http://api/', 'http://b/', 'http://c/'],
  );
  assert.deepEqual(hostDirectUrls({ url: 'http://a/' }), ['http://a/']);
});

test('picks the first address that answers, in list order', async () => {
  const probed = [];
  const answering = new Set(['http://c/', 'http://b/']);
  const url = await selectAnsweringHostUrl(['http://a/', 'http://b/', 'http://c/'], async (candidate) => {
    probed.push(candidate);
    return { status: answering.has(candidate) ? 'ok' : 'unreachable' };
  });
  assert.equal(url, 'http://b/');
  assert.deepEqual(probed, ['http://a/', 'http://b/']);
});

test('an address that answers as another service or an incompatible server is skipped', async () => {
  const statuses = { 'http://a/': 'wrong-service', 'http://b/': 'incompatible', 'http://c/': 'auth' };
  const url = await selectAnsweringHostUrl(Object.keys(statuses), async (candidate) => ({ status: statuses[candidate] }));
  assert.equal(url, 'http://c/');
});

test('when nothing answers the main address is kept, so the usual error names it', async () => {
  const url = await selectAnsweringHostUrl(['http://a/', 'http://b/'], async () => ({ status: 'unreachable' }));
  assert.equal(url, 'http://a/');
});

test('a host without failover addresses is not probed', async () => {
  let probes = 0;
  const url = await selectAnsweringHostUrl(['http://a/'], async () => {
    probes += 1;
    return { status: 'ok' };
  });
  assert.equal(url, 'http://a/');
  assert.equal(probes, 0);
});
