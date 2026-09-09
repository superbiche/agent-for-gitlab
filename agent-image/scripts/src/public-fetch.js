import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 20_000;
const fail = (message) => new Error(`Public fetch: ${message}`);

// IPv4-only by design. Exclude special-purpose, documentation, multicast and
// reserved ranges as well as private/loopback/link-local space.
function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 ||
      (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function parseURL(input) {
  let url;
  try { url = new URL(input); } catch { throw fail('invalid URL'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') ||
      url.username || url.password || url.hostname.includes(':') ||
      !url.hostname || url.href.length > 8192) throw fail('URL is not permitted');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test|example|onion)$/.test(hostname)) {
    throw fail('hostname is not public');
  }
  url.hash = '';
  return url;
}

function textual(contentType) {
  return /^(?:text\/(?:plain|html|markdown|x-markdown|xml|javascript|css)|application\/(?:json|[a-z0-9.+-]+\+json|xml|[a-z0-9.+-]+\+xml|javascript|x-javascript))$/i.test(contentType.split(';')[0].trim());
}

/** Fetch untrusted public evidence. Never pass model-controlled options here.
 * resolve4/request injection exists exclusively for offline transport tests.
 * Caller owns native secret scanning of outbound URLs and returned evidence.
 */
export async function fetchPublicText(input, options = {}) {
  const dns = options.resolve4 ?? resolve4;
  const http = options.request ?? request;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  let activeRequest;
  let expired = false;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      activeRequest?.destroy();
      reject(fail('timeout'));
    }, timeoutMs);
  });
  const operation = async () => {
    let url = parseURL(input);
    for (let redirects = 0; ; redirects++) {
      let addresses;
      try { addresses = isIP(url.hostname) ? [url.hostname] : await dns(url.hostname); }
      catch { throw fail('DNS lookup failed'); }
      if (expired) throw fail('timeout');
      if (!addresses.length || !addresses.every(publicIPv4)) throw fail('destination is not public IPv4');
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        const stop = (error) => {
          if (settled) return;
          settled = true;
          activeRequest?.destroy();
          reject(error);
        };
        try {
          activeRequest = http(url, {
            method: 'GET', agent: false, family: 4,
            headers: { Accept: 'text/plain, text/html, text/markdown, application/json, application/xml, application/javascript', 'Accept-Encoding': 'identity', 'User-Agent': 'GitLab-review-public-evidence/1' },
            lookup: (_host, lookupOptions, callback) => {
              if (typeof lookupOptions === 'function') callback = lookupOptions;
              if (lookupOptions?.all) callback(null, [{ address: addresses[0], family: 4 }]);
              else callback(null, addresses[0], 4);
            },
          }, (response) => {
            response.on('error', () => stop(fail('response failed')));
            response.on('aborted', () => stop(fail('response interrupted')));
            const status = response.statusCode;
            if ([301, 302, 303, 307, 308].includes(status)) {
              const location = response.headers.location;
              settled = true;
              response.destroy();
              resolve({ location });
              return;
            }
            if (status !== 200) { stop(fail('HTTP response was not successful')); return; }
            const contentType = response.headers['content-type'] ?? '';
            const encoding = response.headers['content-encoding'];
            if ((encoding && encoding.toLowerCase() !== 'identity') || !textual(contentType)) {
              stop(fail('unsupported content type or encoding')); return;
            }
            if (Number(response.headers['content-length']) > MAX_BYTES) { stop(fail('response too large')); return; }
            const chunks = [];
            let bytes = 0;
            response.on('data', (chunk) => {
              bytes += chunk.length;
              if (bytes > MAX_BYTES) { stop(fail('response too large')); return; }
              chunks.push(chunk);
            });
            response.on('end', () => {
              if (settled) return;
              let text;
              try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
              catch { stop(fail('response is not UTF-8 text')); return; }
              if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) { stop(fail('response contains binary data')); return; }
              settled = true;
              resolve({ url: url.href, text, contentType });
            });
          });
          activeRequest.on('error', () => stop(fail('request failed')));
          activeRequest.end();
        } catch { stop(fail('request failed')); }
      });
      if ('text' in result) return result;
      if (redirects >= 3 || !result.location) throw fail('redirect limit or invalid location');
      try { url = parseURL(new URL(result.location, url).href); }
      catch { throw fail('redirect destination is not permitted'); }
    }
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { clearTimeout(timer); }
}
