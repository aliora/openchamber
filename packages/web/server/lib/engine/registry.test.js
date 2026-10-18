import { describe, it, expect } from 'bun:test';
import { createEngineRegistry } from './registry.js';
import { createFakeEngine } from './test/fake-engine.js';

describe('createEngineRegistry', () => {
  it('uses the first adapter as default and for sessions stored without an engine', () => {
    const registry = createEngineRegistry([createFakeEngine({ id: 'a' }), createFakeEngine({ id: 'b' })]);
    expect(registry.getDefault().id).toBe('a');
    expect(registry.forSession({ id: 's1' }).id).toBe('a');
    expect(registry.forSession({ id: 's2', engine: 'b' }).id).toBe('b');
    expect(registry.forSession({ id: 's3', engine: 'gone' })).toBeNull();
    expect(registry.list().map((a) => a.id)).toEqual(['a', 'b']);
    expect(registry.forProvider('b-provider').id).toBe('b');
    expect(registry.forProvider('missing')).toBeNull();
  });

  it('rejects an empty list, duplicates and incomplete adapters', () => {
    expect(() => createEngineRegistry([])).toThrow();
    expect(() => createEngineRegistry([createFakeEngine(), createFakeEngine()])).toThrow(/twice/);
    expect(() => createEngineRegistry([createFakeEngine({ id: 'a' }), { ...createFakeEngine({ id: 'b' }), providerID: 'a-provider' }])).toThrow(/share provider/);
    expect(() => createEngineRegistry([{ ...createFakeEngine(), createProcess: undefined }])).toThrow(/createProcess/);
    expect(() => createEngineRegistry([{ ...createFakeEngine(), defaultPermissionMode: 'other' }])).toThrow(/permission mode/);
    expect(() => createEngineRegistry([createFakeEngine({ livePermissionModes: ['other'] })])).toThrow(/livePermissionModes/);
    expect(() => createEngineRegistry([{ ...createFakeEngine(), dangerousPermissionModes: ['other'] }])).toThrow(/dangerousPermissionModes/);
    expect(() => createEngineRegistry([{ ...createFakeEngine(), dangerousPermissionModes: [] }])).toThrow(/full-permission mode/);
    expect(() => createEngineRegistry([{ ...createFakeEngine(), modelCatalog: undefined }])).toThrow(/modelCatalog/);
    expect(() => createEngineRegistry([{ ...createFakeEngine(), modelCatalog: () => ({ models: [], defaultModel: 'fast' }) }])).toThrow(/no models/);
    expect(() => createEngineRegistry([{ ...createFakeEngine(), modelCatalog: () => ({ models: [{ id: 'fast', name: 'Fast' }], defaultModel: 'slow' }) }]))
      .toThrow(/default model/);
  });
});
