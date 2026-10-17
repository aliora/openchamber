import { describe, expect, test } from 'bun:test';

import type { EngineControls, EngineControlsCatalog } from '@/stores/useEngineControlsStore';

import { findHandoffProviders } from './engineHandoff';

const engine = (id: string, providerID: string): EngineControls => ({
    engine: id,
    providerID,
    defaultPermissionMode: 'default',
    permissionModes: [{ id: 'default', labelKey: 'a', descriptionKey: 'b', dangerous: false, appliesLive: false }],
    defaultEffort: null,
});

const catalog: EngineControlsCatalog = {
    engines: [engine('claude', 'anthropic'), engine('codex', 'openai'), engine('antigravity', 'google')],
    defaultEngine: 'claude',
};

describe('findHandoffProviders', () => {
    test('marks every other engine in a chat with history', () => {
        expect([...findHandoffProviders(catalog, 'google', true)]).toEqual(['anthropic', 'openai']);
    });

    test('marks nothing in an empty chat, where the engine switches freely', () => {
        expect(findHandoffProviders(catalog, 'google', false).size).toBe(0);
    });

    test('marks nothing on a server without engines', () => {
        expect(findHandoffProviders(null, 'anthropic', true).size).toBe(0);
    });

    test('marks nothing when the chat runs on a provider that is not an engine', () => {
        expect(findHandoffProviders(catalog, 'openrouter', true).size).toBe(0);
        expect(findHandoffProviders(catalog, null, true).size).toBe(0);
    });
});
