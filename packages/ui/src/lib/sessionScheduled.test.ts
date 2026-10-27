import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { isSessionScheduledInMetadata } from './sessionScheduled';

const session = (metadata?: Session['metadata']): Session => ({
  id: 'ses_a',
  projectID: 'project',
  directory: '/repo',
  title: 'ses_a',
  time: { created: 1, updated: 2 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  metadata,
});

describe('isSessionScheduledInMetadata', () => {
  test('is true for a session created by a scheduled task', () => {
    expect(isSessionScheduledInMetadata(session({ openchamber: { kind: 'scheduled' } }))).toBe(true);
  });

  test('is false for another kind, or no kind', () => {
    expect(isSessionScheduledInMetadata(session({ openchamber: { kind: 'manual' } }))).toBe(false);
    expect(isSessionScheduledInMetadata(session({ openchamber: {} }))).toBe(false);
  });

  test('is false without metadata or a session', () => {
    expect(isSessionScheduledInMetadata(session())).toBe(false);
    expect(isSessionScheduledInMetadata(null)).toBe(false);
    expect(isSessionScheduledInMetadata(undefined)).toBe(false);
  });

  test('is false for malformed metadata', () => {
    expect(isSessionScheduledInMetadata(session({ openchamber: 'scheduled' }))).toBe(false);
    expect(isSessionScheduledInMetadata(session({ openchamber: null }))).toBe(false);
    expect(isSessionScheduledInMetadata(session({ kind: 'scheduled' }))).toBe(false);
  });
});
