import { describe, expect, test } from 'bun:test';
import { isAttentionState, isRunningState, resolveSessionLiveState, type SessionLiveStateInput } from './sessionLiveState';

const idle: SessionLiveStateInput = {
  pendingPermission: false,
  pendingInput: false,
  failedUnseen: false,
  turnActivity: null,
  unread: false,
};

describe('resolveSessionLiveState', () => {
  test('a session with nothing going on is idle', () => {
    expect(resolveSessionLiveState(idle)).toBe('idle');
  });

  test('ranks waiting-permission > waiting-input > failed > running > unread', () => {
    const everything: SessionLiveStateInput = {
      pendingPermission: true,
      pendingInput: true,
      failedUnseen: true,
      turnActivity: 'running',
      unread: true,
    };
    expect(resolveSessionLiveState(everything)).toBe('waiting-permission');
    expect(resolveSessionLiveState({ ...everything, pendingPermission: false })).toBe('waiting-input');
    expect(resolveSessionLiveState({ ...everything, pendingPermission: false, pendingInput: false })).toBe('failed');
    expect(resolveSessionLiveState({ ...idle, turnActivity: 'running', unread: true })).toBe('running');
    expect(resolveSessionLiveState({ ...idle, unread: true })).toBe('unread');
  });

  test('keeps the kind of work that holds the turn open', () => {
    expect(resolveSessionLiveState({ ...idle, turnActivity: 'subagent' })).toBe('subagent');
    expect(resolveSessionLiveState({ ...idle, turnActivity: 'shell', unread: true })).toBe('shell');
  });

  test('only requests and unseen failures need the user', () => {
    expect(['waiting-permission', 'waiting-input', 'failed'].every((state) => isAttentionState(resolveSessionLiveState({
      ...idle,
      pendingPermission: state === 'waiting-permission',
      pendingInput: state === 'waiting-input',
      failedUnseen: state === 'failed',
    })))).toBe(true);
    for (const turnActivity of ['running', 'subagent', 'shell'] as const) {
      const state = resolveSessionLiveState({ ...idle, turnActivity });
      expect(isAttentionState(state)).toBe(false);
      expect(isRunningState(state)).toBe(true);
    }
    expect(isAttentionState('unread')).toBe(false);
    expect(isRunningState('unread')).toBe(false);
  });
});
