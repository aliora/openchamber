import crypto from 'crypto';

export const INTERNAL_AUTH_HEADER = 'x-openchamber-internal-auth';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const internalCredential = crypto.randomBytes(32).toString('base64url');
const internalCredentialDigest = crypto.createHash('sha256').update(internalCredential).digest();

const isLoopbackAddress = (address) =>
  typeof address === 'string' && (address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'));

export const internalAuthHeaders = () => ({ [INTERNAL_AUTH_HEADER]: internalCredential });

export const hasInternalCredential = (req) => {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  const candidate = req?.headers?.[INTERNAL_AUTH_HEADER];
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const candidateDigest = crypto.createHash('sha256').update(candidate).digest();
  return crypto.timingSafeEqual(candidateDigest, internalCredentialDigest);
};

export const isSelfTarget = (baseUrl, ownPort) => {
  if (typeof baseUrl !== 'string' || !ownPort) return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname) && Number(url.port) === Number(ownPort);
  } catch {
    return false;
  }
};
