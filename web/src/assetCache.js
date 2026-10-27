// Persistent cache for archived attachments. Assets are content-addressed by
// the sha256 the exporter records in archive/index.json, so a cached copy can
// never be stale: changed content has a different hash and a different key.
// Revisiting a conversation then needs no GitHub API calls for its images
// (each costs two). Disconnecting clears the cache.

import { encodePath } from './github.js';

export const ASSET_CACHE_NAME = 'ai-archive-assets-v1';

export function assetCacheKey(settings, path, metadata) {
  const sha256 = String(metadata?.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256) || !settings?.owner || !settings?.repo || !path) return null;
  return `https://ai-archive.cache/assets/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}/${sha256}/${encodePath(path)}`;
}

async function openCache(cacheStorage) {
  try {
    return cacheStorage ? await cacheStorage.open(ASSET_CACHE_NAME) : null;
  } catch {
    return null; // Unavailable (insecure context, storage blocked): use the network.
  }
}

// A conversation can reference one file several times (inline and as an
// attachment); concurrent reads of the same file share one download.
const inflight = new Map();

export function readAssetCached(settings, path, metadata, options = {}) {
  const id = `${settings?.owner}/${settings?.repo}/${assetCacheKey(settings, path, metadata) || path}`;
  if (!inflight.has(id)) {
    inflight.set(id, readThroughCache(settings, path, metadata, options).finally(() => inflight.delete(id)));
  }
  return inflight.get(id);
}

async function readThroughCache(settings, path, metadata, { read, cacheStorage = globalThis.caches } = {}) {
  const key = assetCacheKey(settings, path, metadata);
  const cache = key ? await openCache(cacheStorage) : null;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return await hit.json();
    } catch {}
  }
  const asset = await read(settings, path, metadata);
  // An image without a preview is a failed download; let the next visit retry.
  const complete = asset && (asset.dataUrl || !/^image\//i.test(String(asset.mime || '')));
  if (cache && complete) {
    try {
      await cache.put(key, new Response(JSON.stringify(asset), { headers: { 'Content-Type': 'application/json' } }));
    } catch {} // Quota exceeded or storage blocked: the asset is still shown.
  }
  return asset;
}

export async function clearAssetCache(cacheStorage = globalThis.caches) {
  try {
    await cacheStorage?.delete(ASSET_CACHE_NAME);
  } catch {}
}
