import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatProgressLine, estimateRemainingMs, formatDuration, mapLimit, createGitHubReader, createProgress, gitBlobSha,
} from './verifierRuntime.js';

const memoryStream = () => { const chunks = []; return { chunks, write: (text) => { chunks.push(text); }, get text() { return chunks.join(''); } }; };

test('progress and ETA are computed from the average rate, and only with enough data', () => {
  assert.equal(estimateRemainingMs({ done: 2, total: 10, elapsedMs: 10000 }), null, 'too few items');
  assert.equal(estimateRemainingMs({ done: 5, total: 10, elapsedMs: 1000 }), null, 'too little time');
  assert.equal(estimateRemainingMs({ done: 342, total: 812, elapsedMs: 19000 }), Math.round((19000 / 342) * 470));
  assert.equal(estimateRemainingMs({ done: 10, total: 10, elapsedMs: 5000 }), 0);
  assert.equal(formatProgressLine({ done: 342, total: 812, elapsedMs: 19000 }), '342 / 812 (42.1%) | 18 files/s | ETA: 26s | elapsed 19s');
  assert.equal(formatProgressLine({ done: 1240, total: 3500, elapsedMs: 100000, bytes: 420 * 1024 * 1024 }), '1,240 / 3,500 (35.4%) | 4.2 MB/s | ETA: 3m 2s | elapsed 1m 40s');
  assert.equal(formatProgressLine({ done: 0, total: 0, elapsedMs: 0 }), '0 / 0 (100.0%) | elapsed 0s');
  assert.equal(formatDuration(135000), '2m 15s');
  assert.equal(formatDuration(3725000), '1h 2m 5s');
});

test('progress refreshes one line on a terminal and prints periodic lines otherwise', () => {
  let clock = 0;
  const tty = memoryStream();
  const p = createProgress({ stream: tty, isTTY: true, now: () => clock });
  p.start({ total: 3 });
  for (let i = 0; i < 3; i++) { clock += 1000; p.tick(); }
  p.finish();
  assert.equal(tty.text.split('\n').length, 2, 'a single line, refreshed with \\r');
  assert.ok(tty.text.includes('\r'));
  assert.equal(/\x1b\[/.test(tty.text), false, 'no ANSI escape codes');

  clock = 0;
  const pipe = memoryStream();
  const q = createProgress({ stream: pipe, isTTY: false, intervalMs: 5000, now: () => clock });
  q.start({ total: 100 });
  for (let i = 0; i < 100; i++) { clock += 100; q.tick(); }
  q.finish();
  const lines = pipe.text.trim().split('\n');
  assert.ok(lines.length <= 5, `periodic, not one line per file (${lines.length})`);
  assert.equal(pipe.text.includes('\r'), false);
  assert.match(lines.at(-1), /100 \/ 100 \(100\.0%\)/);
});

test('mapLimit never runs more than the limit, keeps order, and stops scheduling when aborted', async () => {
  let active = 0; let peak = 0;
  const results = await mapLimit([...Array(25).keys()], 4, async (n) => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2 + (n % 3)));
    active -= 1;
    return n * 2;
  });
  assert.equal(peak, 4);
  assert.deepEqual(results, [...Array(25).keys()].map((n) => n * 2));

  const controller = new AbortController();
  let started = 0;
  await assert.rejects(mapLimit([...Array(50).keys()], 3, async (n) => {
    started += 1;
    if (n === 5) controller.abort();
    await new Promise((r) => setTimeout(r, 1));
  }, { signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.ok(started <= 8, `no new items after the abort (started ${started})`);
});

function scriptedFetch(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const headers = Object.fromEntries(Object.entries(next.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = next.bytes ?? new TextEncoder().encode(next.json !== undefined ? JSON.stringify(next.json) : '');
    return {
      ok: next.status >= 200 && next.status < 300, status: next.status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? (next.bytes ? 'application/octet-stream' : null) },
      text: async () => new TextDecoder().decode(body),
      arrayBuffer: async () => body.slice().buffer,
    };
  };
  return { fetch, calls };
}
const fastReader = (fetch, extra = {}) => {
  const waits = [];
  const reader = createGitHubReader({ owner: 'o', repo: 'r', token: 'ghp_SECRETSECRETSECRETSECRET', fetch, sleep: async (ms) => { waits.push(ms); }, random: () => 1, ...extra });
  return { reader, waits };
};

test('transient errors are retried with backoff; permanent ones are not; the token never appears in errors', async () => {
  const ok = { status: 200, json: { fine: true } };
  {
    const { fetch, calls } = scriptedFetch([{ status: 502, json: { message: 'Server Error' } }, new TypeError('fetch failed'), { status: 503 }, ok]);
    const { reader, waits } = fastReader(fetch);
    assert.deepEqual(await reader.json('/x'), { fine: true });
    assert.equal(calls.length, 4);
    assert.equal(reader.stats.retries, 3);
    assert.deepEqual(waits, [1000, 2000, 4000], 'exponential backoff');
    assert.ok(calls.every((call) => call.init.headers.Accept), 'GET only, with an Accept header');
    assert.ok(calls.every((call) => !call.init.method || call.init.method === 'GET'), 'read-only');
  }
  {
    const { fetch, calls } = scriptedFetch([{ status: 404, json: { message: 'Not Found' } }]);
    const { reader } = fastReader(fetch);
    await assert.rejects(reader.json('/git/blobs/abc'), (error) => error.permanent && error.status === 404 && /GitHub 404 for \/git\/blobs\/abc: Not Found/.test(error.message));
    assert.equal(calls.length, 1, 'a 404 is not retried');
  }
  {
    const { fetch, calls } = scriptedFetch(Array.from({ length: 5 }, () => ({ status: 500, json: { message: 'boom ghp_SECRETSECRETSECRETSECRET' } })));
    const { reader } = fastReader(fetch);
    await assert.rejects(reader.json('/y'), (error) => /after 5 attempts/.test(error.message));
    assert.equal(calls.length, 5, 'bounded attempts');
    const { fetch: f2 } = scriptedFetch([{ status: 401, json: { message: 'Bad credentials' } }]);
    await assert.rejects(fastReader(f2).reader.json('/z'), (error) => !error.message.includes('Authorization'));
  }
});

test('rate limits: wait for a near reset, honour Retry-After, give up on a far reset', async () => {
  const nowMs = 1_000_000;
  {
    const { fetch } = scriptedFetch([
      { status: 403, json: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowMs / 1000 + 60) } },
      { status: 429, json: { message: 'slow down' }, headers: { 'retry-after': '7' } },
      { status: 403, json: { message: 'You have exceeded a secondary rate limit' } },
      { status: 200, json: { ok: 1 } },
    ]);
    const { reader, waits } = fastReader(fetch, { now: () => nowMs });
    assert.deepEqual(await reader.json('/x'), { ok: 1 });
    assert.deepEqual(waits, [61000, 7000, 2000], 'reset + 1 s, Retry-After, then backoff');
    assert.equal(reader.stats.rateLimitWaitMs, 61000 + 7000 + 2000);
  }
  {
    const { fetch } = scriptedFetch([{ status: 403, json: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(nowMs / 1000 + 3600) } }]);
    const { reader, waits } = fastReader(fetch, { now: () => nowMs });
    await assert.rejects(reader.json('/x'), (error) => error.permanent && /rate limit reached.*resets in 60 min/.test(error.message));
    assert.deepEqual(waits, []);
  }
});

test('a downloaded blob must match its Git blob ID; a corrupt download is retried', async () => {
  const bytes = new TextEncoder().encode('attachment bytes');
  const sha = await gitBlobSha(bytes);
  const { fetch } = scriptedFetch([{ status: 200, bytes: new TextEncoder().encode('attachment byte') }, { status: 200, bytes }]);
  const { reader } = fastReader(fetch);
  assert.deepEqual(await reader.blob(sha), bytes);
  assert.equal(reader.stats.retries, 1);
  const { fetch: bad } = scriptedFetch(Array.from({ length: 5 }, () => ({ status: 200, bytes: new TextEncoder().encode('wrong') })));
  await assert.rejects(fastReader(bad).reader.blob(sha), /do not match its ID after 5 attempts/);
  // The JSON (base64) representation is accepted too.
  const { fetch: jsonFetch } = scriptedFetch([{ status: 200, json: { encoding: 'base64', content: Buffer.from(bytes).toString('base64') }, headers: { 'content-type': 'application/json; charset=utf-8' } }]);
  assert.deepEqual(await fastReader(jsonFetch).reader.blob(sha), bytes);
});
