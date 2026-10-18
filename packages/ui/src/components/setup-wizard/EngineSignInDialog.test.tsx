import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { EngineSignInPanel } from './EngineSignInDialog';
import type { EngineLogin } from './engineSetupApi';

const login = (values: Partial<EngineLogin>): EngineLogin => ({
  state: 'waiting',
  url: null,
  code: null,
  needsInput: false,
  message: null,
  outputTail: '',
  ...values,
});

const render = (value: EngineLogin | null, draft = '') => renderToStaticMarkup(
  <I18nProvider>
    <EngineSignInPanel
      login={value}
      fallbackCommand="claude auth login"
      draft={draft}
      sending={false}
      onDraftChange={() => undefined}
      onPaste={() => undefined}
      onSubmit={() => undefined}
      onOpenUrl={() => undefined}
      onCopy={() => undefined}
    />
  </I18nProvider>,
);

describe('EngineSignInPanel', () => {
  test('a link that needs a pasted code offers the page and a code field', () => {
    const html = render(login({ url: 'https://claude.com/cai/oauth/authorize?x=1', needsInput: true, outputTail: 'Paste code here if prompted >' }));
    expect(html).toContain('Open sign-in page');
    expect(html).toContain('Paste the code the sign-in page shows you.');
    expect(html).toContain('>Paste<');
    expect(html).toContain('Submit');
    expect(html).toContain('Show raw output');
    expect(html).not.toContain('claude auth login');
  });

  test('a device code is shown to copy, and a code can still be typed', () => {
    const html = render(login({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' }));
    expect(html).toContain('ABCD-1234');
    expect(html).toContain('Copy code');
    expect(html).toContain('Only if the sign-in page gives you a code.');
  });

  test('while the server starts there is no link yet', () => {
    const html = render(null);
    expect(html).toContain('Starting the sign-in on the server');
    expect(html).not.toContain('Open sign-in page');
  });

  test('a failed sign-in gives the reason and the terminal command', () => {
    const html = render(login({ state: 'failed', url: 'https://x.example', message: 'Sign-in timed out' }));
    expect(html).toContain('Sign-in timed out');
    expect(html).toContain('claude auth login');
    expect(html).not.toContain('Open sign-in page');
    expect(html).not.toContain('Submit');
  });

  test('a finished sign-in says so', () => {
    const html = render(login({ state: 'succeeded' }));
    expect(html).toContain('Signed in.');
    expect(html).not.toContain('claude auth login');
  });
});
