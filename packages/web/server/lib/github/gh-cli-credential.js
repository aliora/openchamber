import { execFile } from 'child_process';

const TOKEN_TTL_MS = 60_000;
const MISSING_TTL_MS = 10_000;

let remembered = null;
let pending = null;

function fetchGhCliToken() {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

export function forgetGhCliToken() {
  remembered = null;
  pending = null;
}

export function getGhCliToken() {
  if (remembered && remembered.expiresAt > Date.now()) {
    return Promise.resolve(remembered.token);
  }
  if (pending) {
    return pending;
  }
  const lookup = fetchGhCliToken().then((token) => {
    if (pending === lookup) {
      remembered = { token, expiresAt: Date.now() + (token ? TOKEN_TTL_MS : MISSING_TTL_MS) };
      pending = null;
    }
    return token;
  });
  pending = lookup;
  return lookup;
}
