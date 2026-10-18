import { describe, expect, test } from 'bun:test';
import { applyJobEvent, createEventStreamParser, parseJobEvent, type JobLog } from './engineJobStream';

describe('createEventStreamParser', () => {
  test('reads named events split across chunks and skips comments', () => {
    const events: Array<[string, string]> = [];
    const push = createEventStreamParser((event, data) => events.push([event, data]));
    push(': heartbeat\n\nevent: status\ndata: {"state":"insta');
    push('lling"}\r\n\r\nevent: log\ndata: {"stream":"stdout","text":"a"}\n\n');
    expect(events).toEqual([
      ['status', '{"state":"installing"}'],
      ['log', '{"stream":"stdout","text":"a"}'],
    ]);
  });
});

describe('parseJobEvent', () => {
  test('maps the server states and keeps the action', () => {
    expect(parseJobEvent('status', '{"state":"installing","action":"update"}')).toEqual({ type: 'status', state: 'running', action: 'update' });
    expect(parseJobEvent('status', '{"state":"failed"}')).toEqual({ type: 'status', state: 'failed', action: null });
  });

  test('a log line from an unknown stream reads as stdout', () => {
    expect(parseJobEvent('log', '{"stream":"pty","text":"x"}')).toEqual({ type: 'log', line: { stream: 'stdout', text: 'x' } });
  });

  test('broken or unknown events are ignored', () => {
    expect(parseJobEvent('log', 'not json')).toBeNull();
    expect(parseJobEvent('progress', '{}')).toBeNull();
  });
});

describe('applyJobEvent', () => {
  const finished: JobLog = { state: 'completed', action: 'install', lines: [{ stream: 'stdout', text: 'old' }] };

  test('a new job clears the previous log', () => {
    expect(applyJobEvent(finished, { type: 'status', state: 'running', action: 'update' })).toEqual({ state: 'running', action: 'update', lines: [] });
  });

  test('a replayed status of the same job keeps its lines', () => {
    expect(applyJobEvent(finished, { type: 'status', state: 'completed', action: null }).lines).toHaveLength(1);
  });

  test('lines are capped', () => {
    let log: JobLog = { state: 'running', action: 'install', lines: [] };
    for (let index = 0; index < 600; index += 1) log = applyJobEvent(log, { type: 'log', line: { stream: 'stdout', text: String(index) } });
    expect(log.lines).toHaveLength(500);
    expect(log.lines[0]?.text).toBe('100');
  });
});
