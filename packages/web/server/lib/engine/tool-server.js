// Helpers every adapter needs to hand a CLI its `toolServer`
// (DOCUMENTATION.md, *Tool server*).

/**
 * The child's whole environment, with the tool server's host kept away from
 * a proxy. The CLI sends the token with every call, and a proxy from the
 * user's environment would otherwise receive it for a non-loopback callback
 * (a listener bound to one concrete address). The rest of the environment is
 * passed through untouched, because binary lookup reads HOME and PATH from it.
 */
export const toolServerEnvironment = (url, env = process.env) => {
  if (!URL.canParse(url)) return env;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const next = { ...env };
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const entries = (env[key] || '').split(',').map((entry) => entry.trim()).filter(Boolean);
    next[key] = (entries.includes(host) ? entries : [...entries, host]).join(',');
  }
  return next;
};
