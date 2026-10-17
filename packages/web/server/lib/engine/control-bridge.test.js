import { describe, it, expect } from 'bun:test';
import { ControlBridge } from './control-bridge.js';
import { StreamHub } from './stream-hub.js';

describe('ControlBridge', () => {
  it('automatically approves requests when in bypassPermissions mode', async () => {
    const bridge = new ControlBridge();
    const result = await bridge.handleControlRequest('session-1', {
      requestId: 'req-1',
      toolName: 'Bash',
      command: 'ls',
    }, 'bypassPermissions');

    expect(result.behavior).toBe('allow');
    expect(bridge.getPendingRequests('session-1').length).toBe(0);
  });

  it('queues request and waits for manual user approval', async () => {
    const bridge = new ControlBridge();
    let resolved = null;

    const promise = bridge.handleControlRequest('session-1', {
      requestId: 'req-2',
      toolName: 'Bash',
      summary: 'rm -rf test',
    }, 'manual').then((res) => {
      resolved = res;
    });

    const pending = bridge.getPendingRequests('session-1');
    expect(pending.length).toBe(1);
    expect(pending[0].requestId).toBe('req-2');
    expect(pending[0].summary).toBe('rm -rf test');

    // Simulate user approving
    const success = bridge.resolvePendingRequest('session-1', 'req-2', 'allow');
    expect(success).toBe(true);

    await promise;
    expect(resolved).toEqual({ behavior: 'allow' });
    expect(bridge.getPendingRequests('session-1').length).toBe(0);
  });

  it('handles user denial', async () => {
    const bridge = new ControlBridge();
    const promise = bridge.handleControlRequest('session-1', {
      requestId: 'req-3',
      toolName: 'Write',
    }, 'manual');

    bridge.resolvePendingRequest('session-1', 'req-3', 'deny');
    const result = await promise;
    expect(result.behavior).toBe('deny');
  });

  // The session summary reads pending requests from here, so every way a request
  // starts or stops waiting must be announced, the silent timeout included.
  it('announces each change to a session\'s pending requests', async () => {
    const bridge = new ControlBridge();
    const changes = [];
    const unsubscribe = bridge.subscribe((sessionId) => changes.push([sessionId, bridge.getPendingRequests(sessionId).length]));

    const answered = bridge.handleControlRequest('session-1', { requestId: 'req-a' }, 'manual');
    bridge.resolvePendingRequest('session-1', 'req-a', 'allow');
    await answered;
    const timedOut = await bridge.handleControlRequest('session-2', { requestId: 'req-b' }, 'manual', 5);
    void bridge.handleControlRequest('session-3', { requestId: 'req-c' }, 'manual');
    bridge.clearSession('session-3');
    bridge.clearSession('session-3');
    await bridge.handleControlRequest('session-4', { requestId: 'req-d' }, 'bypassPermissions');

    expect(timedOut).toEqual({ behavior: 'deny', reason: 'timeout' });
    expect(changes).toEqual([
      ['session-1', 1], ['session-1', 0],
      ['session-2', 1], ['session-2', 0],
      ['session-3', 1], ['session-3', 0],
    ]);
    unsubscribe();
    void bridge.handleControlRequest('session-5', { requestId: 'req-e' }, 'manual');
    expect(changes).toHaveLength(6);
    bridge.clearSession('session-5');
  });
  it('allows every pending and later request of a session once it is allowed for the chat', async () => {
    const bridge = new ControlBridge();
    const first = bridge.handleControlRequest('session-1', { requestId: 'req-1' }, 'manual');
    const second = bridge.handleControlRequest('session-1', { requestId: 'req-2' }, 'manual');
    const other = bridge.handleControlRequest('session-2', { requestId: 'req-3' }, 'manual');

    expect(bridge.isSessionAllowed('session-1')).toBe(false);
    expect(bridge.allowSession('session-1')).toEqual(['req-1', 'req-2']);
    expect(bridge.isSessionAllowed('session-1')).toBe(true);
    expect(bridge.isSessionAllowed('session-2')).toBe(false);
    expect(await first).toEqual({ behavior: 'allow' });
    expect(await second).toEqual({ behavior: 'allow' });
    expect(await bridge.handleControlRequest('session-1', { requestId: 'req-4' }, 'manual')).toEqual({ behavior: 'allow' });
    expect(bridge.getPendingRequests('session-1')).toEqual([]);
    expect(bridge.getPendingRequests('session-2').map((item) => item.requestId)).toEqual(['req-3']);

    bridge.clearSession('session-2');
    expect(await other).toEqual({ behavior: 'deny', reason: 'session_closed' });
  });

  it('keeps a session allowed for the chat when its process ends', async () => {
    const bridge = new ControlBridge();
    bridge.allowSession('session-1');
    bridge.clearSession('session-1');

    expect(await bridge.handleControlRequest('session-1', { requestId: 'req-1' }, 'manual')).toEqual({ behavior: 'allow' });
  });

  it('asks again once a session allowed for the chat is forgotten', async () => {
    const bridge = new ControlBridge();
    const waiting = bridge.handleControlRequest('session-2', { requestId: 'req-0' }, 'manual');
    bridge.allowSession('session-1');
    bridge.forgetSession('session-1');
    bridge.forgetSession('session-2');
    expect(await waiting).toEqual({ behavior: 'deny', reason: 'session_closed' });

    void bridge.handleControlRequest('session-1', { requestId: 'req-1' }, 'manual');
    expect(bridge.getPendingRequests('session-1').map((item) => item.requestId)).toEqual(['req-1']);
    bridge.clearSession('session-1');
  });
});

describe('StreamHub', () => {
  it('broadcasts events to subscribed clients', () => {
    const hub = new StreamHub();
    const received = [];

    const mockRes = {
      write: (data) => received.push(data),
      writeHead: () => {},
      end: () => {},
      on: () => {},
    };

    const unsubscribe = hub.subscribe('session-abc', mockRes);
    hub.broadcast('session-abc', { type: 'text_delta', text: 'Hello' });

    expect(received.length).toBe(2);
    expect(received[0]).toBe(': keep-alive\n\n');
    expect(received[1]).toContain('event: message');
    expect(received[1]).toContain('"text":"Hello"');

    unsubscribe();
    hub.broadcast('session-abc', { type: 'text_delta', text: 'World' });
    expect(received.length).toBe(2);
  });
});
