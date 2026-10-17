import fs from 'fs';
import os from 'os';
import path from 'path';

const MAC_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

const LINUX_NAMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];

const windowsInstalls = (env) => {
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  return roots.flatMap((root) => [
    path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.win32.join(root, 'Chromium', 'Application', 'chrome.exe'),
  ]);
};

const playwrightRoots = ({ platform, env, homedir }) => {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') return [env.PLAYWRIGHT_BROWSERS_PATH];
  if (platform === 'darwin') return [path.join(homedir, 'Library', 'Caches', 'ms-playwright')];
  if (platform === 'win32') return [path.join(env.LOCALAPPDATA || homedir, 'ms-playwright')];
  return [path.join(homedir, '.cache', 'ms-playwright')];
};

const playwrightBinaries = (platform, arch) => {
  if (platform === 'darwin') {
    const dir = arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac';
    return [
      ['chromium-', path.join(dir, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')],
      ['chromium-', path.join(dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')],
    ];
  }
  if (platform === 'win32') return [['chromium-', path.join('chrome-win', 'chrome.exe')]];
  return [['chromium-', path.join('chrome-linux', 'chrome')]];
};

const searchPath = ({ env, platform, exists }) => {
  const separator = platform === 'win32' ? ';' : ':';
  const directories = (env.PATH || '').split(separator).filter(Boolean);
  return LINUX_NAMES.flatMap((name) => directories.map((directory) => path.join(directory, name))).filter(exists);
};

export const resolveChromePath = ({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homedir = os.homedir(),
  exists = (candidate) => fs.existsSync(candidate),
  list = (directory) => fs.readdirSync(directory),
} = {}) => {
  const override = env.OPENCHAMBER_CHROME_PATH;
  if (override) return exists(override) ? { path: override, source: 'env' } : null;

  const system = platform === 'darwin'
    ? MAC_APPS.filter(exists)
    : platform === 'win32'
      ? windowsInstalls(env).filter(exists)
      : searchPath({ env, platform, exists });
  if (system.length > 0) return { path: system[0], source: 'system' };

  for (const root of playwrightRoots({ platform, env, homedir })) {
    let entries = [];
    try {
      entries = list(root).sort().reverse();
    } catch {
      continue;
    }
    for (const [prefix, relative] of playwrightBinaries(platform, arch)) {
      for (const entry of entries.filter((name) => name.startsWith(prefix))) {
        const candidate = path.join(root, entry, relative);
        if (exists(candidate)) return { path: candidate, source: 'playwright' };
      }
    }
  }
  return null;
};

export const CHROME_NOT_FOUND_MESSAGE = 'No Chrome, Chromium or Edge was found on this server. Install one, or set OPENCHAMBER_CHROME_PATH to its executable.';
