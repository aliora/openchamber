import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeModel, decodeModel, createOpenCodeModelCatalog } from './model-catalog.js';

test('provider/model identities round trip without collisions', () => {
  assert.deepEqual(decodeModel(encodeModel('vendor/a', 'model%/b')), { providerID: 'vendor/a', id: 'model%/b' });
  assert.notEqual(encodeModel('one', 'same'), encodeModel('two', 'same'));
  assert.throws(() => decodeModel('invalid'));
});

test('catalog is directory scoped, single flight and retains last good data on failure', async () => {
  let reads = 0; let fail = false;
  const catalog = createOpenCodeModelCatalog({ read: async (directory) => {
    reads++; if (fail) throw new Error('offline');
    return { models: [{ providerID: 'vendor', id: directory, name: directory, enabled: true, variants: [] }], defaultModel: { providerID: 'vendor', id: directory } };
  } });
  assert.equal(catalog.current('/a').defaultModel, null);
  await Promise.all([catalog.refresh('/a'), catalog.refresh('/a')]);
  assert.equal(reads, 1);
  await catalog.refresh('/b');
  assert.equal(catalog.current('/a').models[0].id, encodeModel('vendor', '/a'));
  fail = true;
  await assert.rejects(catalog.refresh('/a'), /offline/);
  assert.equal(catalog.current('/a').models.length, 1);
  assert.equal(catalog.current('/a').error, 'OpenCode model discovery failed.');
});
