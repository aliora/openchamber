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
