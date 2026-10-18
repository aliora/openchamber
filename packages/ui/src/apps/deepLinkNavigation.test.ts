import { describe, expect, test } from 'bun:test';

import { buildPairingConnectionPayload, encodePairingConnectionPayload, type PairingConnectionPayload } from '@/lib/connectionPayload';

import { applyDeepLinkUrl, createLaunchUrlGate, pushSessionIntent, registerDeepLinkPairingHandler } from './deepLinkNavigation';

const pairingLink = (pairingId: string): string => encodePairingConnectionPayload(buildPairingConnectionPayload({
  pairingId,
  secret: 'one-time',
  candidates: [{ type: 'lan', url: 'http://192.168.1.20:4096' }],
}));

describe('pairing deep links', () => {
  test('wait for a pairing handler, then reach it without waiting for the app to be ready', () => {
    const received: PairingConnectionPayload[] = [];
    applyDeepLinkUrl(pairingLink('pair_cold'));
    expect(received).toHaveLength(0);

    const unregister = registerDeepLinkPairingHandler((payload) => { received.push(payload); });
    expect(received.map((payload) => payload.pairingId)).toEqual(['pair_cold']);

    applyDeepLinkUrl(pairingLink('pair_warm'));
    expect(received.map((payload) => payload.pairingId)).toEqual(['pair_cold', 'pair_warm']);
    unregister();

    applyDeepLinkUrl(pairingLink('pair_later'));
    expect(received).toHaveLength(2);
    const unregisterNext = registerDeepLinkPairingHandler((payload) => { received.push(payload); });
    expect(received.map((payload) => payload.pairingId)).toEqual(['pair_cold', 'pair_warm', 'pair_later']);
    unregisterNext();
  });

  test('ignore navigation links and broken pairing links', () => {
    const received: PairingConnectionPayload[] = [];
    const unregister = registerDeepLinkPairingHandler((payload) => { received.push(payload); });
    applyDeepLinkUrl('openchamber://session/abc');
    applyDeepLinkUrl('openchamber://connect?v=2&p=broken');
    expect(received).toHaveLength(0);
    unregister();
  });
});

describe('createLaunchUrlGate', () => {
  test('a launch URL already delivered as an open event is not applied again', () => {
    const gate = createLaunchUrlGate();
    expect(gate.acceptOpenedUrl('openchamber://connect?v=2&p=a')).toBe(true);
    expect(gate.acceptLaunchUrl('openchamber://connect?v=2&p=a')).toBe(false);
  });

  test('an open event repeating the applied launch URL is dropped once', () => {
    const gate = createLaunchUrlGate();
    expect(gate.acceptLaunchUrl('openchamber://session/abc')).toBe(true);
    expect(gate.acceptOpenedUrl('openchamber://session/abc')).toBe(false);
    expect(gate.acceptOpenedUrl('openchamber://session/abc')).toBe(true);
  });

  test('no launch URL lets every open event through', () => {
    const gate = createLaunchUrlGate();
    expect(gate.acceptLaunchUrl(null)).toBe(false);
    expect(gate.acceptOpenedUrl('openchamber://session/abc')).toBe(true);
  });
});

describe('pushSessionIntent', () => {
  test('a push from the server the phone named opens there', () => {
    expect(pushSessionIntent({ sessionId: 'ses_1', cid: 'conn-pi' })).toEqual({ type: 'push-session', sessionId: 'ses_1', connectionId: 'conn-pi' });
  });

  test('a push without a connection id opens on the current server, as before', () => {
    expect(pushSessionIntent({ sessionId: 'ses_1' })).toEqual({ type: 'session', sessionId: 'ses_1' });
    expect(pushSessionIntent({ sessionId: 'ses_1', cid: '' })).toEqual({ type: 'session', sessionId: 'ses_1' });
    expect(pushSessionIntent({ sessionId: 'ses_1', cid: 7 })).toEqual({ type: 'session', sessionId: 'ses_1' });
  });

  test('a push without a session opens nothing', () => {
    expect(pushSessionIntent({ cid: 'conn-pi' })).toBeNull();
    expect(pushSessionIntent(undefined)).toBeNull();
  });
});
