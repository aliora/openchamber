import { describe, expect, it } from 'vitest';
import { CHROME_NOT_FOUND_MESSAGE, resolveChromePath } from './chrome-path.js';

const fsWith = (files, directories = {}) => ({
  exists: (candidate) => files.includes(candidate),
  list: (directory) => {
    if (!(directory in directories)) throw new Error('ENOENT');
    return directories[directory];
  },
});

describe('resolveChromePath', () => {
  it('prefers an explicit executable', () => {
    const found = resolveChromePath({ env: { OPENCHAMBER_CHROME_PATH: '/opt/chrome' }, platform: 'linux', ...fsWith(['/opt/chrome', '/usr/bin/chromium']) });
    expect(found).toEqual({ path: '/opt/chrome', source: 'env' });
  });

  it('does not fall back when the explicit path is wrong', () => {
    expect(resolveChromePath({ env: { OPENCHAMBER_CHROME_PATH: '/nope' }, platform: 'linux', ...fsWith(['/usr/bin/chromium']) })).toBeNull();
  });

  it('finds Chrome on macOS before other browsers', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    expect(resolveChromePath({ env: {}, platform: 'darwin', ...fsWith([edge, chrome]) })).toEqual({ path: chrome, source: 'system' });
  });

  it('finds Edge on a Windows machine that has no Chrome', () => {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const found = resolveChromePath({
      env: { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' },
      platform: 'win32',
      ...fsWith([edge]),
    });
    expect(found).toEqual({ path: edge, source: 'system' });
  });

  it('finds chromium on the PATH of a Linux server', () => {
    const found = resolveChromePath({ env: { PATH: '/bin:/usr/bin' }, platform: 'linux', ...fsWith(['/usr/bin/chromium']) });
    expect(found).toEqual({ path: '/usr/bin/chromium', source: 'system' });
  });

  it('uses the newest Playwright download when no browser is installed', () => {
    const root = '/home/pi/.cache/ms-playwright';
    const binary = `${root}/chromium-1300/chrome-linux/chrome`;
    const found = resolveChromePath({
      env: {},
      platform: 'linux',
      homedir: '/home/pi',
      ...fsWith([binary, `${root}/chromium-1200/chrome-linux/chrome`], { [root]: ['chromium-1200', 'chromium-1300', 'ffmpeg-1011'] }),
    });
    expect(found).toEqual({ path: binary, source: 'playwright' });
  });

  it('reports nothing when no browser exists', () => {
    expect(resolveChromePath({ env: {}, platform: 'linux', homedir: '/home/pi', ...fsWith([]) })).toBeNull();
    expect(CHROME_NOT_FOUND_MESSAGE).toContain('OPENCHAMBER_CHROME_PATH');
  });
});
