import { afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test';

const execFileMock = mock();

mock.module('child_process', () => ({
  execFile: execFileMock,
}));

const { forgetGhCliToken, getGhCliToken } = await import('./gh-cli-credential.js');

const answer = (error, stdout = '') => {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(error, stdout, '');
  });
};

const answerLater = () => {
  const pending = [];
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    pending.push(callback);
  });
  return (stdout) => pending.forEach((callback) => callback(null, stdout, ''));
};

describe('gh CLI credential lookup', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T08:00:00Z'));
    execFileMock.mockReset();
    forgetGhCliToken();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('runs gh without a shell and hides the subprocess window on Windows', async () => {
    answer(null, 'token\n');

    await expect(getGhCliToken()).resolves.toBe('token');
    expect(execFileMock).toHaveBeenCalledWith(
      'gh',
      ['auth', 'token'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
      expect.any(Function),
    );
  });

  test('shares one lookup between concurrent callers', async () => {
    const finish = answerLater();

    const first = getGhCliToken();
    const second = getGhCliToken();
    finish('token\n');

    await expect(Promise.all([first, second])).resolves.toEqual(['token', 'token']);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test('reuses the token for a minute, then asks gh again', async () => {
    answer(null, 'token\n');

    await getGhCliToken();
    vi.setSystemTime(new Date('2026-10-20T08:00:59Z'));
    await expect(getGhCliToken()).resolves.toBe('token');
    expect(execFileMock).toHaveBeenCalledTimes(1);

    answer(null, 'rotated\n');
    vi.setSystemTime(new Date('2026-10-20T08:01:01Z'));
    await expect(getGhCliToken()).resolves.toBe('rotated');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test('remembers a missing gh login briefly, then rechecks', async () => {
    answer(new Error('gh unavailable'));

    await expect(getGhCliToken()).resolves.toBeNull();
    vi.setSystemTime(new Date('2026-10-20T08:00:09Z'));
    await expect(getGhCliToken()).resolves.toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);

    answer(null, 'token\n');
    vi.setSystemTime(new Date('2026-10-20T08:00:11Z'));
    await expect(getGhCliToken()).resolves.toBe('token');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test('treats empty output as no login', async () => {
    answer(null, '\n');

    await expect(getGhCliToken()).resolves.toBeNull();
  });

  test('asks gh again once the remembered answer is forgotten', async () => {
    answer(new Error('gh unavailable'));
    await getGhCliToken();

    answer(null, 'token\n');
    forgetGhCliToken();

    await expect(getGhCliToken()).resolves.toBe('token');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  test('a lookup forgotten mid-flight does not overwrite the fresh answer', async () => {
    const finishStale = answerLater();
    const stale = getGhCliToken();
    forgetGhCliToken();
    answer(null, 'fresh\n');

    await expect(getGhCliToken()).resolves.toBe('fresh');
    finishStale('stale\n');
    await stale;

    await expect(getGhCliToken()).resolves.toBe('fresh');
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
