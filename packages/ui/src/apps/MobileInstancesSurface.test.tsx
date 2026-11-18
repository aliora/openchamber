import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

import { buildPairingConnectionPayload, encodePairingConnectionPayload, type PairingConnectionPayload } from '@/lib/connectionPayload';

type SaveInput = { id?: string; url?: string; label?: string; clientToken?: string; failoverUrls?: string[] };

const redeemed: PairingConnectionPayload[] = [];
const saved: SaveInput[] = [];

mock.module('./mobileConnections', () => ({
  connectionDisplayUrl: () => '',
  isActiveRuntimeConnection: () => false,
  secureTokenKeyOf: () => '',
  useMobileConnection: () => {
    const [error, setError] = React.useState<string | null>(null);
    return {
      connections: [],
      isBusy: false,
      isPasswordBusy: false,
      error,
      pendingConnection: null,
      connect: async () => undefined,
      redeemPairingConnection: async (payload: PairingConnectionPayload) => { redeemed.push(payload); },
      submitPassword: async () => undefined,
      cancelPassword: () => undefined,
      saveConnection: async (input: SaveInput) => { saved.push(input); return null; },
      removeConnection: async () => null,
      setError,
    };
  },
}));

const pairingLink = encodePairingConnectionPayload(buildPairingConnectionPayload({
  pairingId: 'pair_form',
  secret: 'one-time',
  candidates: [{ type: 'lan', url: 'http://192.168.1.20:4096' }],
}));

test('the add-by-address form redeems pairing links and refuses to save them as server URLs', async () => {
  const dom = new Window({ url: 'http://localhost', width: 390, height: 844 });
  Object.assign(globalThis, {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Node: dom.Node,
    MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  });

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { MobileInstancesSurface } = await import('./MobileInstancesSurface');

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider><MobileInstancesSurface onConnect={() => undefined} onActiveConnectionDeleted={() => undefined} /></I18nProvider>);
  });

  const buttonWithText = (text: string) => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text));
  const urlInput = () => container.querySelector<HTMLInputElement>('input[type="url"]');
  const typeUrl = (value: string) => act(async () => {
    const input = urlInput();
    if (!input) throw new Error('expected the server URL input');
    const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
    setValue?.call(input, value);
    input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  });
  const submit = () => act(async () => {
    container.querySelector('form')?.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
  });

  await act(async () => buttonWithText('Add by address')?.click());

  await typeUrl(pairingLink);
  expect(redeemed.map((payload) => payload.pairingId)).toEqual(['pair_form']);
  expect(saved).toHaveLength(0);

  await typeUrl('openchamber://connect?v=2&p=broken');
  await submit();
  expect(saved).toHaveLength(0);
  expect(redeemed).toHaveLength(1);
  expect(container.textContent).toContain('That pairing link is not valid or has expired.');

  await typeUrl('https://oc.example');
  await submit();
  expect(saved.map((input) => input.url)).toEqual(['https://oc.example']);

  const failoverInputs = () => [...container.querySelectorAll<HTMLInputElement>('input[data-failover-address]')];
  const typeInto = (input: HTMLInputElement | undefined, value: string) => act(async () => {
    if (!input) throw new Error('expected a failover address input');
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  });
  const clickLabelled = (label: string, index: number) => act(async () => {
    container.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)[index]?.click();
  });

  await act(async () => buttonWithText('Add address')?.click());
  await act(async () => buttonWithText('Add address')?.click());
  await act(async () => buttonWithText('Add address')?.click());
  await typeInto(failoverInputs()[0], '100.64.0.2');
  await typeInto(failoverInputs()[1], 'pi-ts:3000');
  await typeInto(failoverInputs()[2], 'gone.example');
  await clickLabelled('Move address up', 1);
  await clickLabelled('Remove address', 2);
  await submit();
  expect(saved.at(-1)?.failoverUrls).toEqual(['pi-ts:3000', '100.64.0.2']);
  // A bare IP is a valid failover address, so the browser's URL check must not block it.
  expect(failoverInputs().map((input) => input.type)).toEqual(['text', 'text']);

  await act(async () => root.unmount());
});
