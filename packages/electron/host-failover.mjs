// Failover addresses of a saved direct host: further addresses of the same
// server, tried in order when the main one does not answer at connect time.

// Nothing answered, or something other than a usable OpenChamber did.
const UNUSABLE_PROBE_STATUSES = new Set(['unreachable', 'wrong-service', 'incompatible']);

export const sanitizeFailoverUrlsForStorage = (raw, primaryUrl, sanitizeUrl) => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set([primaryUrl]);
  const urls = [];
  for (const value of raw) {
    const url = sanitizeUrl(value);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
};

export const hostDirectUrls = (host) => [host.apiUrl || host.url, ...(host.failoverUrls || [])];

/**
 * The first of `urls` whose probe answers, in order; the main address (the
 * first) when none does, so the caller's usual failure handling reports it.
 * A single address is returned unprobed: callers probe it themselves.
 */
export const selectAnsweringHostUrl = async (urls, probe) => {
  if (urls.length < 2) return urls[0];
  for (const url of urls) {
    const result = await probe(url);
    if (!UNUSABLE_PROBE_STATUSES.has(result?.status)) return url;
  }
  return urls[0];
};
