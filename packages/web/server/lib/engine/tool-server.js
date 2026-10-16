// Helpers every adapter needs to hand a CLI its `toolServer`
// (DOCUMENTATION.md, *Tool server*).

/**
 * Environment that keeps the tool server's host away from a proxy. The CLI
 * sends the token with every call, and a proxy from the user's environment
 * would otherwise receive it for a non-loopback callback (a listener bound to
 * one concrete address). Spread it over the child's environment.
 */
export const toolServerProxyExemption = (url, env = process.env) => {
  if (!URL.canParse(url)) return {};
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const exemption = {};
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const entries = (env[key] || '').split(',').map((entry) => entry.trim()).filter(Boolean);
    exemption[key] = (entries.includes(host) ? entries : [...entries, host]).join(',');
  }
  return exemption;
};
