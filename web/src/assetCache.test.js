import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_CACHE_NAME, assetCacheKey, clearAssetCache, readAssetCached } from './assetCache.js';

function fakeCacheStorage({ failOpen = false, failPut = false } = {}) {
  const caches = new Map();
  return {
    caches,
    async open(name) {
      if (failOpen) throw new Error('SecurityError');
      if (!caches.has(name)) caches.set(name, new Map());
      const entries = caches.get(name);
      return {
        async match(key) { return entries.has(key) ? new Response(entries.get(key)) : undefined; },
        async put(key, response) { if (failPut) throw new Error('QuotaExceededError'); entries.set(key, await response.text()); },
      };
    },
    async delete(name) { return caches.delete(name); },
  };
}

const settings = { owner: 'me', repo: 'archive', token: 't' };
const sha256 = 'ab'.repeat(32);
const path = 'archive/conversations/claude/personal/assets/c1/map #1.png';
const image = { name: 'map #1.png', path, mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', sha: 'git-sha', size: 3 };

function counter(result) {
  const calls = [];
  return { calls, read: async (...args) => { calls.push(args); return typeof result === 'function' ? result() : result; } };
}

test('a cached asset is served without contacting GitHub again', async () => {
  const cacheStorage = fakeCacheStorage();
  const { calls, read } = counter(image);
  const first = await readAssetCached(settings, path, { sha256 }, { read, cacheStorage });
  const second = await readAssetCached(settings, path, { sha256 }, { read, cacheStorage });
  assert.equal(calls.length, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(second, image);
});

test('keys are content-addressed and scoped to the repository and path', () => {
  const key = assetCacheKey(settings, path, { sha256: sha256.toUpperCase() });
  assert.equal(key, `https://ai-archive.cache/assets/me/archive/${sha256}/archive/conversations/claude/personal/assets/c1/map%20%231.png`);
  assert.notEqual(assetCacheKey({ ...settings, repo: 'other' }, path, { sha256 }), key);
  assert.notEqual(assetCacheKey(settings, path, { sha256: 'cd'.repeat(32) }), key);
  assert.equal(assetCacheKey(settings, path, null), null);
  assert.equal(assetCacheKey(settings, path, { sha256: 'not-a-hash' }), null);
});

test('assets without a recorded hash, and images whose preview failed, are not cached', async () => {
  const cacheStorage = fakeCacheStorage();
  const noHash = counter(image);
  await readAssetCached(settings, path, null, { ...noHash, cacheStorage });
  await readAssetCached(settings, path, null, { ...noHash, cacheStorage });
  assert.equal(noHash.calls.length, 2);

  const failed = counter({ ...image, dataUrl: '' });
  await readAssetCached(settings, path, { sha256 }, { ...failed, cacheStorage });
  await readAssetCached(settings, path, { sha256 }, { ...failed, cacheStorage });
  assert.equal(failed.calls.length, 2);

  const pdf = counter({ name: 'a.pdf', path: 'x/a.pdf', mime: 'application/pdf', dataUrl: '' });
  await readAssetCached(settings, 'x/a.pdf', { sha256 }, { ...pdf, cacheStorage });
  await readAssetCached(settings, 'x/a.pdf', { sha256 }, { ...pdf, cacheStorage });
  assert.equal(pdf.calls.length, 1, 'non-image metadata is complete without a preview');
});

test('an unavailable or full cache falls back to GitHub', async () => {
  for (const cacheStorage of [undefined, fakeCacheStorage({ failOpen: true }), fakeCacheStorage({ failPut: true })]) {
    const { calls, read } = counter(image);
    assert.deepEqual(await readAssetCached(settings, path, { sha256 }, { read, cacheStorage }), image);
    assert.deepEqual(await readAssetCached(settings, path, { sha256 }, { read, cacheStorage }), image);
    assert.equal(calls.length, 2);
  }
});

test('errors from GitHub are not cached', async () => {
  const cacheStorage = fakeCacheStorage();
  let fail = true;
  const { calls, read } = counter(() => { if (fail) throw new Error('GitHub 502'); return image; });
  await assert.rejects(readAssetCached(settings, path, { sha256 }, { read, cacheStorage }), /502/);
  fail = false;
  assert.deepEqual(await readAssetCached(settings, path, { sha256 }, { read, cacheStorage }), image);
  assert.equal(calls.length, 2);
});

test('clearing removes every cached asset', async () => {
  const cacheStorage = fakeCacheStorage();
  const { calls, read } = counter(image);
  await readAssetCached(settings, path, { sha256 }, { read, cacheStorage });
  await clearAssetCache(cacheStorage);
  assert.equal(cacheStorage.caches.has(ASSET_CACHE_NAME), false);
  await readAssetCached(settings, path, { sha256 }, { read, cacheStorage });
  assert.equal(calls.length, 2);
  await clearAssetCache(undefined);
});

test('concurrent reads of the same asset share one download', async () => {
  const cacheStorage = fakeCacheStorage();
  for (const metadata of [{ sha256 }, null]) {
    const { calls, read } = counter(image);
    const results = await Promise.all([1, 2, 3].map(() => readAssetCached(settings, path, metadata, { read, cacheStorage })));
    assert.equal(calls.length, 1);
    assert.ok(results.every((r) => r === results[0]));
    await clearAssetCache(cacheStorage);
  }
});
