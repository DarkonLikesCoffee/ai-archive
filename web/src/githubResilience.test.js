import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRequest, mapWithConcurrency, retryPolicy } from './github.js';

const settings = { owner: 'me', repo: 'archive', token: 'token' };
retryPolicy.baseDelayMs = 1;

function reply(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

test('retries transient GitHub failures for viewer requests', async (t) => {
  for (const failure of [
    () => { throw new TypeError('Failed to fetch'); },
    () => reply(502, { message: 'Bad gateway' }),
    () => reply(429, { message: 'Too many requests' }, { 'retry-after': '0' }),
    () => reply(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '0' }),
  ]) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return calls < 3 ? failure() : reply(200, { ok: true });
    });
    assert.deepEqual(await githubRequest(settings, '/contents/archive/index.json'), { ok: true });
    assert.equal(calls, 3);
    t.mock.restoreAll();
  }
});

test('gives up after the retry budget and keeps the status prefix', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return reply(503, { message: 'Unavailable' }); });
  await assert.rejects(githubRequest(settings, '/contents/x'), /^Error: GitHub 503:|GitHub 503:/);
  assert.equal(calls, 3);
});

test('explains authentication, access, and rate-limit failures without retrying', async (t) => {
  const cases = [
    [reply(401, { message: 'Bad credentials' }), /GitHub 401: GitHub rejected the access token\. Disconnect and connect again with a valid token\./],
    [reply(403, { message: 'Resource not accessible by personal access token' }),
      /GitHub 403: GitHub denied access to me\/archive\. The token needs read access to repository contents\./],
    [reply(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1893456000' }),
      /GitHub 403: GitHub API rate limit reached; it resets at 2030-01-01T00:00:00\.000Z\./],
    [reply(404, { message: 'Not Found' }), /GitHub 404:/],
  ];
  for (const [response, expected] of cases) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls += 1; return response; });
    await assert.rejects(githubRequest(settings, '/contents/x'), expected);
    assert.equal(calls, 1);
    t.mock.restoreAll();
  }
});

test('maps items with a bounded number of concurrent tasks and keeps their order', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return value * 2;
  });
  assert.equal(maxActive, 4);
  assert.deepEqual(result, Array.from({ length: 20 }, (_, i) => i * 2));
});
