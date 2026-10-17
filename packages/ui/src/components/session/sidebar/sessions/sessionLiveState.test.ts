import { afterEach, describe, expect, test } from 'bun:test';
import { appendNotification, markSessionViewed, useNotificationStore } from '@/sync/notification-store';
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

describe('unseen failure index', () => {
  const initial = useNotificationStore.getState();
  afterEach(() => useNotificationStore.setState(initial, true));

  // Notifications older than 30 days are pruned, so times are recent.
  const now = Date.now();
  const latestIsError = (sessionId: string): boolean => useNotificationStore.getState().index.session.unseenLatestIsError[sessionId] === true;

  test('follows the newest unseen result of the session', () => {
    appendNotification({ type: 'error', session: 'ses_a', time: now + 1, viewed: false });
    expect(latestIsError('ses_a')).toBe(true);
    // A later successful turn is the latest result now.
    appendNotification({ type: 'turn-complete', session: 'ses_a', time: now + 2, viewed: false });
    expect(latestIsError('ses_a')).toBe(false);
    appendNotification({ type: 'error', session: 'ses_a', time: now + 3, viewed: false });
    expect(latestIsError('ses_a')).toBe(true);
  });

  test('clears once the user has seen the session, and leaves other sessions alone', () => {
    appendNotification({ type: 'error', session: 'ses_a', time: now + 1, viewed: false });
    appendNotification({ type: 'error', session: 'ses_b', time: now + 2, viewed: false });
    markSessionViewed('ses_a');
    expect(latestIsError('ses_a')).toBe(false);
    expect(latestIsError('ses_b')).toBe(true);
  });
});
