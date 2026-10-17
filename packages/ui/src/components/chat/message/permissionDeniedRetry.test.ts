import { describe, expect, test } from 'bun:test';

import type { Part } from '@/lib/opencode/model';
import { findPromptBefore, hasPromptAfter, offersFullPermissionRetry } from './permissionDeniedRetry';

describe('full permission retry', () => {
  test('is offered only for an Antigravity turn its permissions refused', () => {
    expect(offersFullPermissionRetry('antigravity', 'PermissionDenied')).toBe(true);
    expect(offersFullPermissionRetry('claude', 'PermissionDenied')).toBe(false);
    expect(offersFullPermissionRetry('antigravity', 'EngineExited')).toBe(false);
    expect(offersFullPermissionRetry(undefined, 'PermissionDenied')).toBe(false);
  });

  const text = (id: string, value: string): Part => ({ id, sessionID: 's', messageID: id, type: 'text', text: value }) as Part;
  const parts: Record<string, Part[]> = {
    u1: [text('u1', 'first')],
    u2: [text('u2', 'run the tests')],
    u3: [text('u3', 'later')],
  };
  const partsOf = (id: string) => parts[id] ?? [];

  test('resends the prompt the refused turn answered', () => {
    const messages = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'u2', role: 'user' },
      { id: 'syn', role: 'synthetic' },
      { id: 'a2', role: 'assistant' },
      { id: 'u3', role: 'user' },
    ] as const;
    expect(findPromptBefore(messages, 'a2', partsOf)).toBe('run the tests');
    expect(findPromptBefore(messages, 'a1', partsOf)).toBe('first');
  });

  test('finds nothing without the message or an earlier prompt', () => {
    expect(findPromptBefore([{ id: 'a1', role: 'assistant' }], 'a1', partsOf)).toBeNull();
    expect(findPromptBefore([{ id: 'u1', role: 'user' }], 'missing', partsOf)).toBeNull();
    expect(findPromptBefore([{ id: 'empty', role: 'user' }, { id: 'a1', role: 'assistant' }], 'a1', partsOf)).toBeNull();
  });

  test('is spent once a later prompt follows the refused turn', () => {
    const messages = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'syn', role: 'synthetic' },
    ] as const;
    expect(hasPromptAfter(messages, 'a1')).toBe(false);
    expect(hasPromptAfter([...messages, { id: 'u2', role: 'user' }], 'a1')).toBe(true);
    expect(hasPromptAfter(messages, 'missing')).toBe(false);
  });
});
