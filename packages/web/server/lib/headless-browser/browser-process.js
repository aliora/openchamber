import { spawn as nodeSpawn } from 'child_process';
import fs from 'fs';
import { connectCdp } from './cdp-client.js';

const LAUNCH_TIMEOUT_MS = 20_000;
const DEBUG_URL_PATTERN = /DevTools listening on (ws:\/\/\S+)/;

export const buildChromeArgs = ({ profileDir, runningAsRoot, platform }) => [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--hide-scrollbars',
  '--window-size=1280,800',
  '--disable-features=Translate,MediaRouter',
  '--disable-blink-features=AutomationControlled',
  ...(runningAsRoot ? ['--no-sandbox'] : []),
  ...(platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
  'about:blank',
];

export const launchBrowser = async ({
  chromePath,
  profileDir,
  spawn = nodeSpawn,
  connect = connectCdp,
  mkdir = (directory) => fs.mkdirSync(directory, { recursive: true }),
  platform = process.platform,
  runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0,
  timeoutMs = LAUNCH_TIMEOUT_MS,
}) => {
  mkdir(profileDir);
  const child = spawn(chromePath, buildChromeArgs({ profileDir, runningAsRoot, platform }), {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  const debugUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The browser did not start within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.once('error', (error) => fail(new Error(`The browser could not be started: ${error.message}`)));
    child.once('exit', (code) => fail(new Error(`The browser exited while starting (code ${code}). ${output.slice(-300)}`.trim())));
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
      const match = DEBUG_URL_PATTERN.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
  });

  child.stderr.on('data', () => undefined);
  const connection = await connect(debugUrl);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return {
    connection,
    exited,
    kill: () => child.kill(),
    async stop() {
      connection.close();
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    },
  };
};
