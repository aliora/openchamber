import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LocalSessionStore } from './store.js';
import { buildTitlePrompt, cleanGeneratedTitle, createSessionTitler, deriveSessionTitle } from './session-title.js';

const adapter = { id: 'fake', displayName: 'Fake' };
const quietLogger = { warn: () => {} };

describe('deriveSessionTitle', () => {
  it('keeps the first seven words of the message', () => {
    expect(deriveSessionTitle('  Mac sunucusunda oturum başlıkları neden hep Untitled kalıyor, bakar mısın?  '))
      .toBe('Mac sunucusunda oturum başlıkları neden hep Untitled');
  });

  it('leaves out code blocks and markdown marks', () => {
    expect(deriveSessionTitle('## Fix the **login** page\n```js\nconst a = 1;\n```')).toBe('Fix the login page');
  });

  it('falls back to the raw words when the message is only code', () => {
    expect(deriveSessionTitle('```\nnpm test\n```')).toBe('``` npm test ```');
  });

  it('stays within sixty characters, cut at a word', () => {
    const title = deriveSessionTitle('internationalization localization accessibility responsiveness maintainability observability');
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith(' ')).toBe(false);
    expect('internationalization localization accessibility responsiveness'.startsWith(title)).toBe(true);
  });
});

describe('cleanGeneratedTitle', () => {
  it('takes the first line without quotes, prefix or trailing period', () => {
    expect(cleanGeneratedTitle('<think>hmm</think>\n\n"Title: Session titles."\nmore')).toBe('Session titles');
    expect(cleanGeneratedTitle('**Oturum başlıkları**')).toBe('Oturum başlıkları');
  });

  it('answers empty for an empty reply', () => {
    expect(cleanGeneratedTitle('  \n ')).toBe('');
    expect(cleanGeneratedTitle(undefined)).toBe('');
  });

  it('caps a long reply', () => {
    expect(cleanGeneratedTitle('word '.repeat(40)).length).toBeLessThanOrEqual(80);
  });
});

describe('buildTitlePrompt', () => {
  it('quotes the message as source material and asks for its language', () => {
    const prompt = buildTitlePrompt('Merhaba dünya');
    expect(prompt).toContain('<message>\nMerhaba dünya\n</message>');
    expect(prompt).toContain('same language as the user message');
  });
});

describe('session titler', () => {
  let tmpDir;
  let store;
  let titled;
  let prompts;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-title-test-'));
    store = new LocalSessionStore({ storagePath: path.join(tmpDir, 'sessions.json') });
    titled = [];
    prompts = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const titlerWith = (generateText) => createSessionTitler({
    store,
    generateText: async (input) => {
      prompts.push(input);
      return generateText(input);
    },
    onTitle: (sessionId, title) => titled.push({ sessionId, title }),
    logger: quietLogger,
  });

  const sessionWithPrompts = async (texts, data = {}) => {
    const session = await store.createSession({ cwd: '/work', ...data });
    for (const text of texts) await store.appendMessage(session.id, { role: 'user', content: text });
    return session;
  };

  it('stores the generated title of the first message and announces it', async () => {
    const session = await sessionWithPrompts(['Why do session titles stay untitled?']);
    await titlerWith(async () => 'Session titles').titleSession(session.id, adapter);

    expect((await store.getSession(session.id)).title).toBe('Session titles');
    expect(titled).toEqual([{ sessionId: session.id, title: 'Session titles' }]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].adapter).toBe(adapter);
    expect(prompts[0].prompt).toContain('Why do session titles stay untitled?');
  });

  it('titles from the first message even when later prompts follow', async () => {
    const session = await sessionWithPrompts(['Dark mode for the settings page', 'continue']);
    await titlerWith(async () => '').titleSession(session.id, adapter);
    expect((await store.getSession(session.id)).title).toBe('Dark mode for the settings page');
    expect(prompts[0].prompt).toContain('Dark mode for the settings page');
  });

  it('derives the title from the message when generation fails', async () => {
    const session = await sessionWithPrompts(['Engine oturumlarında başlık üretimi çalışmıyor, düzeltelim lütfen hemen']);
    await titlerWith(async () => { throw new Error('Not logged in'); }).titleSession(session.id, adapter);
    expect((await store.getSession(session.id)).title).toBe('Engine oturumlarında başlık üretimi çalışmıyor, düzeltelim');
    expect(titled).toHaveLength(1);
  });

  it('never replaces a title the session already has', async () => {
    const session = await sessionWithPrompts(['Anything'], { title: 'My own name' });
    await titlerWith(async () => 'Generated').titleSession(session.id, adapter);
    expect((await store.getSession(session.id)).title).toBe('My own name');
    expect(prompts).toHaveLength(0);
    expect(titled).toHaveLength(0);
  });

  it('keeps a title the user set while the title was being generated', async () => {
    const session = await sessionWithPrompts(['Anything']);
    await titlerWith(async () => {
      await store.updateSession(session.id, { title: 'Typed by the user' });
      return 'Generated';
    }).titleSession(session.id, adapter);
    expect((await store.getSession(session.id)).title).toBe('Typed by the user');
    expect(titled).toHaveLength(0);
  });

  it('generates once per session, also for prompts that arrive while it runs', async () => {
    const session = await sessionWithPrompts(['First', 'Second']);
    let release;
    const titler = titlerWith(() => new Promise((resolve) => { release = resolve; }));
    const first = titler.titleSession(session.id, adapter);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await titler.titleSession(session.id, adapter);
    release('Once');
    await first;
    await titler.titleSession(session.id, adapter);
    expect(prompts).toHaveLength(1);
    expect(titled).toEqual([{ sessionId: session.id, title: 'Once' }]);
  });

  it('waits for a user message before titling', async () => {
    const session = await sessionWithPrompts([]);
    await titlerWith(async () => 'Never').titleSession(session.id, adapter);
    expect((await store.getSession(session.id)).title).toBeUndefined();
    expect(prompts).toHaveLength(0);
  });

  it('ignores a session that is gone', async () => {
    await titlerWith(async () => 'Never').titleSession('missing', adapter);
    expect(titled).toHaveLength(0);
  });
});
