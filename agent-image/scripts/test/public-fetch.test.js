import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fetchPublicText } from '../src/public-fetch.js';
function fixture(replies = [{}], dns = async () => ['93.184.216.34']) {
  const calls = [];
  return { calls, options: { resolve4: dns, request(url, options, callback) {
    calls.push({ url, options });
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const spec = replies.shift() ?? {}; if (spec.hang) return;
      const response = new PassThrough(); response.statusCode = spec.status ?? 200;
      response.headers = { 'content-type': 'text/plain', ...spec.headers };
      callback(response); if (!response.destroyed) response.end(spec.body ?? 'public evidence');
    }); return req;
  } } };
}
test('pins DNS address while retaining TLS hostname and fixed unauthenticated GET headers', async () => {
  let lookups = 0;
  const f = fixture([{}], async () => { lookups++; return ['93.184.216.34', '8.8.8.8']; });
  assert.equal((await fetchPublicText('https://docs.vendor.com/path', f.options)).text, 'public evidence');
  const { url, options } = f.calls[0];
  assert.equal(url.hostname, 'docs.vendor.com'); assert.equal(options.agent, false); assert.equal(options.method, 'GET');
  options.lookup(url.hostname, {}, (_e, address, family) => { assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
  options.lookup(url.hostname, { all: true }, (_e, addresses) => assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]));
  assert.equal(lookups, 1);
  assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Accept-Encoding', 'User-Agent']);
});
test('rejects private/alternate IPs, IPv6, userinfo, ports, protocols and local names', async () => {
  for (const input of ['http://docs.vendor.com', 'https://docs.vendor.com:8443', new URL(Object.assign(new URL('https://docs.vendor.com'), { username: 'fixture-user', password: 'fixture-password' })).href,
    'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://0177.0.0.1', 'https://[::1]', 'https://[::ffff:8.8.8.8]',
    'https://10.1.2.3', 'https://169.254.169.254', 'https://100.64.0.1', 'https://192.0.2.1', 'https://198.51.100.1',
    'https://203.0.113.1', 'https://224.0.0.1', 'https://localhost.', 'https://service.internal']) {
    const f = fixture(); await assert.rejects(fetchPublicText(input, f.options), /Public fetch:/); assert.equal(f.calls.length, 0, input);
  }
});
test('rejects mixed DNS, IPv6-only, empty DNS and bounded DNS errors', async () => {
  for (const dns of [async () => ['8.8.8.8', '10.0.0.1'], async () => [], async () => ['::1'], async () => { throw new Error('sensitive'); }]) {
    const f = fixture([], dns); await assert.rejects(fetchPublicText('https://docs.vendor.com', f.options), e => !e.message.includes('sensitive')); assert.equal(f.calls.length, 0);
  }
});
test('redirect validation prevents private redirects and same-host DNS rebinding', async () => {
  for (const location of ['https://10.0.0.1/private', 'https://docs.vendor.com/again']) {
    let n = 0; const f = fixture([{ status: 302, headers: { location } }], async () => ++n === 1 ? ['8.8.8.8'] : ['10.0.0.1']);
    await assert.rejects(fetchPublicText('https://docs.vendor.com', f.options), /not public/); assert.equal(f.calls.length, 1);
  }
  const f = fixture(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/next' } })));
  await assert.rejects(fetchPublicText('https://docs.vendor.com', f.options), /redirect limit/); assert.equal(f.calls.length, 4);
});
test('successful redirect returns final URL and text', async () => {
  const f = fixture([{ status: 301, headers: { location: '/final' } }, { body: '{}', headers: { 'content-type': 'application/json' } }]);
  assert.deepEqual(await fetchPublicText('https://docs.vendor.com', f.options), { url: 'https://docs.vendor.com/final', text: '{}', contentType: 'application/json' });
});
test('rejects oversized, unsuccessful, binary, compressed and malformed UTF8 responses', async () => {
  for (const spec of [{ status: 401, body: 'sensitive' }, { headers: { 'content-type': 'image/png' } }, { headers: { 'content-encoding': 'gzip' } },
    { body: Buffer.from([0xff]) }, { body: 'binary\0content' }, { body: 'x'.repeat(1048577) }, { headers: { 'content-length': '1048577' } }]) {
    await assert.rejects(fetchPublicText('https://docs.vendor.com', fixture([spec]).options), e => e.message.startsWith('Public fetch:') && !e.message.includes('sensitive'));
  }
});
test('total deadline bounds DNS and response waits', async () => {
  for (const f of [fixture([], () => new Promise(() => {})), fixture([{ hang: true }])]) {
    await assert.rejects(fetchPublicText('https://docs.vendor.com', { ...f.options, timeoutMs: 10 }), /timeout/);
  }
});
