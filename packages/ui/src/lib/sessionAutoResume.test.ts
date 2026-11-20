import { describe, expect, test } from 'bun:test';

import type { HostRequestInit } from '@/lib/hosts/host-transport';
import type { JsonValue } from '@/lib/opencode/model';
import {
  getSessionAutoResume,
  getSessionTransferredTo,
  looksLikeUsageLimit,
  nextTimeOfDay,
  setSessionAutoResume,
  toTimeInputValue,
} from './sessionAutoResume';

const json = (body: JsonValue, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('session auto-resume metadata', () => {
  test('reads the state the server stores under metadata.openchamber.autoResume', () => {
    const autoResume = { enabled: true, status: 'scheduled', resumeAt: 1_800_000, resetWindow: '5h', prompt: null, lastError: null };
    expect(getSessionAutoResume({ metadata: { openchamber: { autoResume, work: { state: 'open' } } } })).toEqual(autoResume);
  });

  test('a session without the state, or with a malformed one, has none', () => {
    expect(getSessionAutoResume(undefined)).toBeNull();
    expect(getSessionAutoResume({ metadata: {} })).toBeNull();
    expect(getSessionAutoResume({ metadata: { openchamber: { autoResume: { status: 'scheduled' } } } })).toBeNull();
  });

  test('reads where a moved session went', () => {
    const transferredTo = { hostLabel: 'Pi5', runtimeKey: 'host:pi5', targetSessionId: 'new-1', targetDirectory: '/srv/app', transferredAt: 5 };
    expect(getSessionTransferredTo({ metadata: { openchamber: { transferredTo } } })).toEqual(transferredTo);
    expect(getSessionTransferredTo({ metadata: { openchamber: {} } })).toBeNull();
  });
});

describe('usage limit errors', () => {
  test('reads limit errors of every engine as limits', () => {
    for (const text of [
      'Request failed with status 429',
      'Claude AI usage limit reached|1763481600',
      "You've hit your limit · resets 3pm (Europe/Istanbul)",
      "api_error: You've hit your 5-hour limit · resets 7pm (Europe/Istanbul)",
      'Rate limit exceeded, try again in 5 minutes',
      'Quota exhausted for this model',
      'Overloaded',
    ]) {
      expect(`${text}: ${looksLikeUsageLimit(text)}`).toBe(`${text}: true`);
    }
  });

  test('does not read other errors or no text as limits', () => {
    for (const text of ['File not found', '', null, undefined]) {
      expect(looksLikeUsageLimit(text)).toBe(false);
    }
  });
});

describe('the resume time field', () => {
  const now = new Date(2026, 10, 18, 14, 30).getTime();

  test('a later time today stays today', () => {
    expect(nextTimeOfDay('16:05', now)).toBe(new Date(2026, 10, 18, 16, 5).getTime());
  });

  test('a time already past today means tomorrow', () => {
    expect(nextTimeOfDay('09:00', now)).toBe(new Date(2026, 10, 19, 9, 0).getTime());
    expect(nextTimeOfDay('14:30', now)).toBe(new Date(2026, 10, 19, 14, 30).getTime());
  });

  test('text that is not a time gives nothing', () => {
    expect(nextTimeOfDay('', now)).toBeNull();
    expect(nextTimeOfDay('25:00', now)).toBeNull();
    expect(nextTimeOfDay('soon', now)).toBeNull();
  });

  test('a timestamp becomes the field value', () => {
    expect(toTimeInputValue(new Date(2026, 10, 18, 7, 5).getTime())).toBe('07:05');
  });
});

describe('changing the auto-resume of a session', () => {
  test('posts the change and answers the stored state', async () => {
    const calls: Array<{ path: string; init?: HostRequestInit }> = [];
    const state = { enabled: true, status: 'scheduled', resumeAt: 99, resetWindow: 'user', prompt: 'Go on', lastError: null };
    const request = async (path: string, init?: HostRequestInit) => {
      calls.push({ path, init });
      return json({ data: state });
    };

    expect(await setSessionAutoResume(request, 'a/b', { enabled: true, resumeAt: 99, prompt: 'Go on' })).toEqual(state);
    expect(calls[0].path).toBe('/api/session/a%2Fb/auto-resume');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(calls[0].init?.body ?? '')).toEqual({ enabled: true, resumeAt: 99, prompt: 'Go on' });
  });

  test('a refusal throws the server\'s reason', async () => {
    const request = async () => json({ error: 'resumeAt must be in the future' }, 400);
    await expect(setSessionAutoResume(request, 's1', { enabled: true, resumeAt: 1 })).rejects.toThrow('resumeAt must be in the future');
  });
});
