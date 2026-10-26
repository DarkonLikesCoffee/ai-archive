// AI Archive background service worker.
// Sync state lives here so the popup can open/close without losing progress.
const API = 'https://api.github.com';
const BLOB_UPLOAD_CONCURRENCY = 4;
const SEARCH_TEXT_ENCODING = 'gzip-base64';
let activeGitHubSettings = null;
let syncAbortController = null;
let cancelRequested = false;
let syncRunning = false;
let lastSyncState = { stage: 'idle' };
// The fetching phase runs in the Claude tab's content script. Remember its
// progress so a reopened popup still shows the running sync and can cancel
// it. Content progress older than this is treated as finished (for example
// when the Claude tab was closed mid-fetch).
const CONTENT_PROGRESS_STALE_MS = 5 * 60 * 1000;
const CONTENT_ACTIVE_STAGES = ['fetching', 'preparing'];
let contentSyncState = null;

function contentSyncRunning() {
  return Boolean(contentSyncState
    && CONTENT_ACTIVE_STAGES.includes(contentSyncState.stage)
    && Date.now() - contentSyncState.at <= CONTENT_PROGRESS_STALE_MS);
}

async function settings() {
  return chrome.storage.local.get(['github_owner', 'github_repo', 'github_token', 'archive_account']);
}

function broadcast(payload) {
  lastSyncState = { ...payload };
  chrome.runtime.sendMessage({ type: 'syncProgress', ...payload }).catch(() => {});
}

function assertNotCancelled() {
  if (cancelRequested) throw new Error('__SYNC_CANCELLED__');
}

const GITHUB_MAX_ATTEMPTS = 3;
const GITHUB_RETRY_BASE_DELAY_MS = 1000;
const GITHUB_MAX_RETRY_AFTER_MS = 60000;

// Only requests whose repetition cannot change the archive are retried:
// reads, and Git object creation (blobs and trees are content-addressed; a
// duplicate commit object stays unreferenced). The branch ref update and the
// empty-repository Contents PUT are never retried; the ref update has its own
// outcome verification in sync().
function isRetryableGitHubRequest(path, method) {
  if (method === 'GET') return true;
  return method === 'POST' && /^\/git\/(blobs|trees|commits)$/.test(path);
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || cancelRequested) {
      reject(new Error('__SYNC_CANCELLED__'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('__SYNC_CANCELLED__'));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function retryAfterMs(response) {
  const value = Number(response?.headers?.get?.('retry-after'));
  return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
}

// Error messages keep the "GitHub <status>:" prefix that callers match on
// (for example an expected 404 for a missing branch or file).
function gitHubError(response, text, s) {
  let message = '';
  try { message = String(JSON.parse(text)?.message || ''); } catch { message = String(text || ''); }
  const status = response.status;
  const remaining = response.headers?.get?.('x-ratelimit-remaining');
  const reset = Number(response.headers?.get?.('x-ratelimit-reset'));
  if (status === 401) {
    return new Error('GitHub 401: GitHub rejected the access token. Update the token in the extension popup. Nothing was published.');
  }
  if ((status === 403 || status === 429) && remaining === '0') {
    const when = Number.isFinite(reset) && reset > 0 ? ` it resets at ${new Date(reset * 1000).toISOString()}.` : ' try again later.';
    return new Error(`GitHub ${status}: GitHub API rate limit reached;${when} Nothing was published; sync again after that.`);
  }
  if (status === 403 && !/rate limit/i.test(message)) {
    return new Error(`GitHub 403: GitHub denied access to ${s.github_owner}/${s.github_repo}. The token needs read and write access to repository contents. Nothing was published. (${message.slice(0, 200)})`);
  }
  return new Error(`GitHub ${status}: ${String(text || '').slice(0, 400)}`);
}

async function gh(path, opts = {}, allowAfterCancel = false) {
  if (!allowAfterCancel) assertNotCancelled();
  const s = activeGitHubSettings || await settings();
  if (!s.github_owner || !s.github_repo || !s.github_token) throw Error('Configure GitHub settings in the extension popup first.');
  const headers = {
    Authorization: `Bearer ${s.github_token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const controller = syncAbortController;
  const signal = allowAfterCancel ? undefined : controller?.signal;
  const method = String(opts.method || 'GET').toUpperCase();
  const retryable = isRetryableGitHubRequest(path, method);

  for (let attempt = 1; ; attempt++) {
    let r;
    try {
      r = await fetch(`${API}/repos/${encodeURIComponent(s.github_owner)}/${encodeURIComponent(s.github_repo)}${path}`, {
        ...opts,
        headers,
        signal,
      });
    } catch (error) {
      // Network failures (not cancellation) are transient for safe requests.
      if (error?.name === 'AbortError' || !retryable || attempt >= GITHUB_MAX_ATTEMPTS) throw error;
      await waitForRetry(GITHUB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), signal);
      if (!allowAfterCancel) assertNotCancelled();
      continue;
    }
    const text = await r.text();
    if (r.ok) return text ? JSON.parse(text) : null;

    const error = gitHubError(r, text, s);
    const exhausted = r.headers?.get?.('x-ratelimit-remaining') === '0';
    const secondaryLimit = (r.status === 403 || r.status === 429) && !exhausted
      && (r.status === 429 || /secondary rate limit/i.test(text));
    const transient = [500, 502, 503, 504].includes(r.status) || secondaryLimit;
    const wait = retryAfterMs(r) ?? GITHUB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    if (!retryable || !transient || attempt >= GITHUB_MAX_ATTEMPTS || wait > GITHUB_MAX_RETRY_AFTER_MS) throw error;
    await waitForRetry(wait, signal);
    if (!allowAfterCancel) assertNotCancelled();
  }
}

async function getRef() {
  for (const branch of ['main', 'master']) {
    try {
      return await gh(`/git/ref/heads/${branch}`);
    } catch (e) {
      // A repository with no initial commit can return either 404 or 409
      // ("Git Repository is empty"). Treat both as an empty/no-ref repo.
      const message = String(e?.message || '').toLowerCase();
      if (message.includes('github 404') || message.includes('github 409') || message.includes('empty')) continue;
      throw e;
    }
  }
  return null;
}

async function getFile(path, ref) {
  try {
    return await gh(`/contents/${pathEncode(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
  } catch (e) {
    if (String(e?.message || '').startsWith('GitHub 404')) return null;
    throw e;
  }
}

function base64DecodeContent(content) {
  const binary = atob(content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function pathEncode(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function slugify(value) {
  return String(value || 'personal')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'personal';
}

function filenameSlug(value) {
  const normalized = String(value || 'Untitled conversation')
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 90)
    .replace(/[-.]+$/g, '');
  return normalized || 'Untitled-conversation';
}

function stableHash(value) {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function conversationPath(c, provider, accountSlug) {
  const externalId = String(c.external_id || 'unknown');
  // Titles and short ID prefixes are not unique. Include a normalized portion
  // of the full ID plus a stable hash so punctuation-normalized IDs also remain
  // distinct, while keeping the filename at a predictable length.
  const idSlug = filenameSlug(externalId).slice(0, 70);
  const idSuffix = stableHash(externalId);
  return `archive/conversations/${provider}/${accountSlug}/${filenameSlug(c.title)}--${idSlug}-${idSuffix}.md`;
}

function escapeMd(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function conversationMetadata(c, provider, account) {
  return {
    id: c.external_id,
    provider,
    account,
    title: c.title || 'Untitled conversation',
    model: c.model || null,
    created_at: c.source_created_at || null,
    updated_at: c.source_updated_at || c.source_created_at || null,
    message_count: c.message_count || c.messages.length,
  };
}

function assetPath(c, asset, provider, accountSlug, usedPaths) {
  const base = filenameSlug(asset.name || 'file');
  const hash = String(asset.sha256 || '').slice(0, 8) || 'asset';
  let name = `${hash}-${base}`;
  // Use the full, path-safe conversation ID as the directory identity.
  // An 8-character prefix can collide across conversations and let one sync
  // overwrite or delete an asset still referenced by another conversation.
  // Asset directories need the same collision resistance as Markdown paths.
  // Slug-only IDs such as "conversation/a" and "conversation:a" normalize to
  // the same directory and could otherwise overwrite or delete each other's files.
  const externalId = String(c.external_id || 'unknown');
  const conversationAssetId = `${filenameSlug(externalId).slice(0, 70)}-${stableHash(externalId)}`;
  let path = `archive/conversations/${provider}/${accountSlug}/assets/${conversationAssetId}/${name}`;
  let n = 2;
  while (usedPaths.has(path)) {
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    name = `${hash}-${stem}-${n}${ext}`;
    path = `archive/conversations/${provider}/${accountSlug}/assets/${conversationAssetId}/${name}`;
    n += 1;
  }
  usedPaths.add(path);
  return path;
}

function isImageAsset(asset) {
  const mime = String(asset?.mime || '').toLowerCase().split(';')[0].trim();
  if (mime.startsWith('image/')) return true;
  const name = String(asset?.name || '').toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(name);
}

function escapeMarkdownLabel(value) {
  return String(value || 'file')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, ' ')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/([*_\x60!])/g, '\\$1');
}

function assetMarkdown(asset, path) {
  const label = escapeMarkdownLabel(asset.name || 'file');
  const rel = `assets/${String(path).split('/assets/').pop()}`;
  if (isImageAsset(asset)) return `![${label}](${rel})`;
  return `[${label}](${rel})`;
}

function isReplyExcerptAttachment(file) {
  const name = String(file?.file_name || file?.name || '').trim().toLowerCase();
  return name === 'excerpt_from_previous_claude_message.txt' || name.startsWith('excerpt_from_previous_claude_message.');
}

function assetMatchesMessage(asset, message, allAssets = []) {
  if (!asset || !message) return false;
  const messageId = message.external_id || message.uuid || message.id || null;

  // Message IDs on a directly collected asset are authoritative. One file can
  // be referenced from multiple messages; retain all of those associations
  // without letting a matching basename attach it to unrelated messages.
  const scopedMessageIds = Array.isArray(asset.message_external_ids) && asset.message_external_ids.length
    ? asset.message_external_ids
    : (asset.message_external_id ? [asset.message_external_id] : []);
  if (scopedMessageIds.length && messageId) {
    return scopedMessageIds.includes(messageId);
  }

  const fileIds = new Set();
  const names = new Set();
  for (const file of (message.files || [])) {
    if (file?.file_uuid) fileIds.add(String(file.file_uuid));
    if (file?.uuid) fileIds.add(String(file.uuid));
    if (file?.file_name) names.add(String(file.file_name).toLowerCase());
    if (file?.name) names.add(String(file.name).toLowerCase());
  }
  for (const attachment of (message.attachments || [])) {
    if (attachment?.file_uuid) fileIds.add(String(attachment.file_uuid));
    if (attachment?.uuid) fileIds.add(String(attachment.uuid));
    if (attachment?.file_name) names.add(String(attachment.file_name).toLowerCase());
    if (attachment?.name) names.add(String(attachment.name).toLowerCase());
  }

  // When Claude provides IDs, a different ID is a mismatch even if filenames
  // happen to be the same. Only use filename fallback when the message has no IDs.
  if (asset.file_uuid && fileIds.size) {
    return fileIds.has(String(asset.file_uuid));
  }

  // A full sandbox path is the strongest available association for generated files.
  const haystack = JSON.stringify(message.metadata || message).toLowerCase();
  const sourcePath = String(asset.source_path || '').replace(/\\/g, '/').toLowerCase();
  const baseName = String(asset.name || '').toLowerCase();
  if (sourcePath && haystack.includes(sourcePath)) return true;

  // If multiple sandbox files share a basename, matching the basename alone is
  // ambiguous. Require an explicit path reference rather than attaching each
  // same-named file to every message that mentions the filename.
  const sourceBaseName = sourcePath.split('/').pop() || baseName;
  const ambiguousSandboxName = Boolean(asset.source_path) && allAssets.some((other) =>
    other !== asset &&
    other.source_path &&
    (String(other.source_path).replace(/\\/g, '/').split('/').pop() || String(other.name || '')).toLowerCase() === sourceBaseName
  );
  if (ambiguousSandboxName) return false;

  if (baseName && names.has(baseName)) return true;
  if (baseName.length > 1 && haystack.includes(baseName)) return true;
  return false;
}

function findMessageAssets(message, allAssets) {
  return allAssets.filter((asset) => assetMatchesMessage(asset, message, allAssets));
}

function attachmentAssetForMessage(message, descriptor, name, assetMap, matchedAssets, allAssets) {
  const id = descriptor?.file_uuid || descriptor?.uuid || null;
  if (id) {
    const byId = assetMap.get(`id:${id}`);
    if (byId && assetMatchesMessage(byId, message, allAssets)) return byId;
    return matchedAssets.find((asset) => String(asset.file_uuid || '') === String(id)) || null;
  }

  const nameKey = String(name || '').toLowerCase();
  const namedMatches = matchedAssets.filter((asset) => String(asset.name || '').toLowerCase() === nameKey);
  if (namedMatches.length === 1) return namedMatches[0];

  // A global filename lookup is only safe for legacy/unscoped assets. For
  // message-scoped assets it can attach the first same-named file to later
  // messages, even though findMessageAssets correctly identified another file.
  const fallback = name ? assetMap.get(`name:${name}`) : null;
  if (fallback && !fallback.message_external_id && !fallback.file_uuid && namedMatches.length === 0) {
    return fallback;
  }
  return null;
}

// Inline image marker indices restart in every message, and one asset can be
// shared by several messages, so positions are only meaningful together with
// the message they were recorded for.
function inlineIndicesForMessage(asset, message) {
  const messageId = message?.external_id || message?.uuid || message?.id || null;
  if (!messageId || !Array.isArray(asset?.inline_positions)) return [];
  return asset.inline_positions
    .filter((position) => position?.message_external_id === messageId)
    .map((position) => position.index);
}

// Inline image markers carry the conversation's random nonce (see
// content.js), so text that merely looks like a marker is never replaced.
const INLINE_ASSET_MARKER = /\[\[AI_ARCHIVE_INLINE_ASSET:([0-9a-f]{32}):(\d+)\]\]/g;

function isOwnInlineMarker(c, nonce) {
  return typeof c?.inline_marker_nonce === 'string' && nonce === c.inline_marker_nonce;
}

// Search text and previews are stored in index.json; keep this sync's
// internal markers out of them.
function contentWithoutInlineMarkers(c, content) {
  return String(content || '').replace(INLINE_ASSET_MARKER, (marker, nonce) => (isOwnInlineMarker(c, nonce) ? '' : marker));
}

function attachmentMarkdown(message, assetMap, allAssets) {
  const parts = [];
  const assets = findMessageAssets(message, allAssets);
  const used = new Set();

  const addAsset = (asset) => {
    // Inline content-block images are rendered at their original position in
    // this message body, so do not repeat them in its trailing attachment list.
    // Other messages sharing the asset still list it as a normal attachment.
    if (!asset || used.has(asset.path) || inlineIndicesForMessage(asset, message).length) return;
    used.add(asset.path);
    parts.push(assetMarkdown(asset, asset.path));
  };

  for (const file of (message.files || [])) {
    const name = file?.file_name || file?.name || null;
    addAsset(attachmentAssetForMessage(message, file, name, assetMap, assets, allAssets));
  }

  for (const attachment of (message.attachments || [])) {
    const name = attachment?.file_name || attachment?.name || 'attachment';
    const nameKey = String(name).toLowerCase();

    // Claude uses this synthetic attachment when the user replies to selected text
    // from an earlier Claude message. Keep the excerpt inline, before the user's
    // actual reply, instead of treating it as a downloadable file.
    if (isReplyExcerptAttachment(attachment)) {
      const excerpt = String(attachment.extracted_content || '').trim();
      if (excerpt) {
        parts.push(`**Attachment: ${name}**\n\n${fenceMarkdown(excerpt)}`);
      } else {
        parts.push(`**Attachment: ${name}**`);
      }
      continue;
    }

    const asset = attachmentAssetForMessage(message, attachment, name, assetMap, assets, allAssets);
    if (asset) {
      addAsset(asset);
    } else if (!assets.some((candidate) => String(candidate.name || '').toLowerCase() === nameKey)) {
      // Do not inline extracted file contents. If Claude exposes only an extraction,
      // the content-side collector materializes it as a text asset before rendering.
      // If multiple same-named assets are legitimately associated with this message,
      // let the loop below render each one rather than showing a misleading placeholder.
      parts.push(`**Attachment: ${name}**`);
    }
  }

  // Include generated sandbox files associated with this message even when Claude
  // did not expose a corresponding message.files/attachments entry.
  for (const asset of assets) addAsset(asset);
  return parts.join('\n\n');
}

function fenceMarkdown(text, language = '') {
  const value = String(text ?? '');
  const longest = Math.max(2, ...value.match(/`+/g)?.map((x) => x.length) || [2]);
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${language}\n${value}\n${ticks}`;
}

function conversationMarkdown(c, provider, account, assetMap, allAssets) {
  const metadata = conversationMetadata(c, provider, account);
  const sections = c.messages.map((m) => {
    const role = m.role === 'user'
      ? 'You'
      : m.role === 'assistant'
        ? provider[0].toUpperCase() + provider.slice(1)
        : m.role;
    const attachments = attachmentMarkdown(m, assetMap, allAssets);
    const content = String(m.content || '').replace(INLINE_ASSET_MARKER, (marker, nonce, rawIndex) => {
      // Marker-shaped text from the conversation itself stays verbatim.
      if (!isOwnInlineMarker(c, nonce)) return marker;
      const imageIndex = Number(rawIndex);
      const image = allAssets.find((asset) =>
        inlineIndicesForMessage(asset, m).includes(imageIndex)
        && assetMatchesMessage(asset, m, allAssets)
      );
      // Never publish an internal marker or guess another file for it.
      if (!image) {
        throw new Error(`Cannot safely export "${c.title || c.external_id}": inline image ${imageIndex} in message "${m.external_id}" has no archived asset. No archive changes were published.`);
      }
      return assetMarkdown(image, image.path);
    });

    // User attachments/reply excerpts are shown before the user's message, matching
    // Claude's UI. Claude-generated files stay with the Claude response that produced
    // or referenced them, rather than being dumped into a trailing Files section.
    const body = role === 'You'
      ? [attachments, content].filter(Boolean).join('\n\n')
      : [content, attachments].filter(Boolean).join('\n\n');
    return `## ${role}\n\n${body}\n`;
  });

  const metadataJson = JSON.stringify(metadata, null, 2).replace(/--/g, '-\\u002d');
  const hiddenMetadata = `<!-- AI_ARCHIVE_METADATA\n${metadataJson}\n-->`;
  return `${hiddenMetadata}\n\n# ${escapeMd(c.title || 'Untitled conversation')}\n\n${sections.join('\n---\n\n')}`;
}

function normalizeAssetList(c, provider, accountSlug) {
  const usedPaths = new Set();
  const byKey = new Map();
  const assets = [];
  for (const raw of (c.assets || [])) {
    if (!raw?.base64 || !raw?.sha256) continue;
    const path = assetPath(c, raw, provider, accountSlug, usedPaths);
    const asset = {
      ...raw,
      path,
      encoding: 'base64',
      base64: raw.base64,
    };
    assets.push(asset);
    if (raw.file_uuid) byKey.set(`id:${raw.file_uuid}`, asset);
    if (raw.name && !byKey.has(`name:${raw.name}`)) byKey.set(`name:${raw.name}`, asset);
    if (raw.source_path) byKey.set(`source:${raw.source_path}`, asset);
  }
  return { assets, byKey };
}

function indexEntry(c, path, provider, account, assets) {
  const contents = c.messages.map((m) => contentWithoutInlineMarkers(c, m.content));
  return {
    id: c.external_id,
    provider,
    account,
    path,
    title: c.title || 'Untitled conversation',
    model: c.model || null,
    created_at: c.source_created_at || null,
    updated_at: c.source_updated_at || c.source_created_at || null,
    message_count: c.message_count || c.messages.length,
    assets: assets.map((a) => ({ path: a.path, sha256: a.sha256, size: a.size, mime: a.mime, name: a.name })),
    format_version: 4,
    preview: String(contents.find(Boolean) || '').slice(0, 300),
    search_text: [c.title, ...contents].join('\n').slice(0, 250000),
  };
}

async function compressSearchText(text) {
  if (typeof CompressionStream !== 'function' || typeof Blob !== 'function' || typeof Response !== 'function') {
    return null;
  }
  const stream = new Blob([String(text ?? '')]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function createBlob(content, encoding = 'utf-8') {
  return gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content, encoding }) });
}

// GitHub's low-level Git Database endpoints (blobs/trees/commits) reject
// completely empty repositories with 409 "Git Repository is empty".
// Seed the repository with a harmless file first so the normal Git Database
// workflow can be used for the actual sync. This is only needed once.
async function initializeEmptyRepository() {
  onProgressSafe({ stage: 'initializing-repo', current: 0, total: 1, message: 'Initializing the empty GitHub repository…' });
  const seed = btoa('This file is created automatically by AI Archive.\n');
  await gh('/contents/.ai-archive-init', {
    method: 'PUT',
    body: JSON.stringify({
      message: 'Initialize AI Archive repository',
      content: seed,
    }),
  });
  onProgressSafe({ stage: 'initializing-repo', current: 1, total: 1, message: 'GitHub repository initialized.' });
}

let activeProgressCallback = null;
function onProgressSafe(payload) {
  activeProgressCallback?.(payload);
}

async function sync(conversations, onProgress) {
  syncRunning = true;
  cancelRequested = false;
  syncAbortController = new AbortController();
  activeProgressCallback = onProgress;
  try {
    const s = await settings();
    // Keep a consistent settings snapshot for this sync and avoid a storage read
    // for every blob request when exporting large archives.
    activeGitHubSettings = s;
    const account = s.archive_account?.trim() || 'personal';
    const accountSlug = slugify(account);
    const provider = 'claude';
    let ref = await getRef();
    assertNotCancelled();
    let branch = ref ? ref.ref.split('/').pop() : 'main';
    let baseCommit = ref ? await gh(`/git/commits/${ref.object.sha}`) : null;
    let baseTree = baseCommit ? await gh(`/git/trees/${baseCommit.tree.sha}?recursive=1`) : null;
    if (baseTree?.truncated) {
      throw new Error('The GitHub archive tree is too large to verify safely. No archive changes were published.');
    }
    let existingPaths = new Set((baseTree?.tree || []).map((item) => item.path));

    let index = { version: 2, updated_at: new Date().toISOString(), conversations: [] };
    const indexFile = ref ? await getFile('archive/index.json', branch) : null;
    if (indexFile) {
      let indexContent = indexFile.content;
      // The GitHub Contents API omits file content for larger files and reports
      // encoding "none". Never interpret that response as a missing index: a
      // limited sync would then publish an index containing only selected chats.
      if (typeof indexContent !== 'string' || (!indexContent && indexFile.sha)) {
        if (!indexFile.sha) {
          throw new Error('GitHub returned no readable content or blob SHA for archive/index.json. No archive changes were published.');
        }
        const blob = await gh(`/git/blobs/${encodeURIComponent(indexFile.sha)}`);
        if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') {
          throw new Error('GitHub could not return the full archive/index.json blob. No archive changes were published.');
        }
        indexContent = blob.content;
      }

      let parsedIndex;
      try {
        parsedIndex = JSON.parse(base64DecodeContent(indexContent));
      } catch {
        // Never silently replace a corrupt index with a partial one. The index is
        // the web app's navigation/search catalogue; rebuilding it from a limited
        // sync could make every unselected conversation disappear from the UI.
        throw new Error('archive/index.json is invalid JSON. Restore or repair it before syncing; no archive changes were published.');
      }
      if (!parsedIndex || !Array.isArray(parsedIndex.conversations)) {
        throw new Error('archive/index.json has an invalid structure. Expected a conversations array; no archive changes were published.');
      }
      index = parsedIndex;
    }

    const map = new Map(index.conversations.map((x) => [`${x.provider}:${x.account}:${x.id}`, x]));
    let changes = [];
    let changedConversations = 0;
    let indexNeedsUpdate = false;
    const total = conversations.length;

    for (let i = 0; i < total; i++) {
      assertNotCancelled();
      const c = conversations[i];
      const path = conversationPath(c, provider, accountSlug);
      const normalizedAssets = normalizeAssetList(c, provider, accountSlug);
      const markdown = conversationMarkdown(c, provider, account, normalizedAssets.byKey, normalizedAssets.assets);
      const entry = indexEntry(c, path, provider, account, normalizedAssets.assets);
      const rawSearchText = entry.search_text;
      entry.search_text_sha256 = await sha256(rawSearchText);
      const compressedSearchText = await compressSearchText(rawSearchText);
      if (compressedSearchText !== null) {
        entry.search_text_encoding = SEARCH_TEXT_ENCODING;
        entry.search_text_gzip = compressedSearchText;
        delete entry.search_text;
      } else {
        entry.search_text_encoding = 'plain';
      }
      entry.content_sha256 = await sha256(markdown);
      const key = `${provider}:${account}:${c.external_id}`;
      const previous = map.get(key);
      const previousAssets = Array.isArray(previous?.assets) ? previous.assets : [];
      const currentAssetSignature = JSON.stringify(entry.assets);
      const previousAssetSignature = JSON.stringify(previousAssets);
      const searchCacheChanged = previous?.search_text_encoding !== entry.search_text_encoding
        || previous?.search_text_sha256 !== entry.search_text_sha256
        || (entry.search_text_encoding === SEARCH_TEXT_ENCODING && typeof previous?.search_text_gzip !== 'string');
      if (searchCacheChanged) indexNeedsUpdate = true;
      const changed = !previous
        || previous.updated_at !== entry.updated_at
        || previous.message_count !== entry.message_count
        || previous.title !== entry.title
        || previous.path !== path
        || previous.format_version !== 4
        || previous.content_sha256 !== entry.content_sha256
        || previousAssetSignature !== currentAssetSignature
        || !existingPaths.has(path)
        || previousAssets.some((asset) => asset?.path && !existingPaths.has(asset.path));

      if (changed) changedConversations += 1;
      if (changed && previous?.path && previous.path !== path) {
        changes.push({ path: previous.path, delete: true });
      }

      const currentAssetPaths = new Set(entry.assets.map((a) => a.path));
      for (const oldAsset of previousAssets) {
        if (oldAsset?.path && !currentAssetPaths.has(oldAsset.path)) {
          changes.push({ path: oldAsset.path, delete: true });
        }
      }

      map.set(key, entry);
      if (changed) {
        changes.push({ path, content: markdown, encoding: 'utf-8' });
        for (const asset of normalizedAssets.assets) {
          const previousAsset = previousAssets.find((a) => a.path === asset.path && a.sha256 === asset.sha256);
          if (!previousAsset || !existingPaths.has(asset.path)) {
            changes.push({ path: asset.path, content: asset.base64, encoding: 'base64' });
          }
        }
      }
      onProgress?.({ stage: 'checking', current: i + 1, total, changed: changedConversations });
    }

    // Migrate older entries too, so a limited sync compacts the complete cache
    // instead of leaving large uncompressed search strings in untouched entries.
    for (const [key, archived] of map) {
      if (typeof archived.search_text !== 'string') continue;

      const searchTextSha256 = archived.search_text_sha256 || await sha256(archived.search_text);
      const compressedSearchText = await compressSearchText(archived.search_text);
      if (compressedSearchText !== null) {
        const compacted = {
          ...archived,
          search_text_sha256: searchTextSha256,
          search_text_encoding: SEARCH_TEXT_ENCODING,
          search_text_gzip: compressedSearchText,
        };
        delete compacted.search_text;
        map.set(key, compacted);
        indexNeedsUpdate = true;
      } else {
        const metadataChanged = archived.search_text_sha256 !== searchTextSha256
          || archived.search_text_encoding !== 'plain';
        map.set(key, {
          ...archived,
          search_text_sha256: searchTextSha256,
          search_text_encoding: 'plain',
        });
        if (metadataChanged) indexNeedsUpdate = true;
      }
    }

    const nextIndex = {
      version: 2,
      updated_at: new Date().toISOString(),
      conversations: [...map.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')),
    };

    // A path can be shared by older archives whose conversation IDs normalized
    // to the same asset directory. Never delete a path that any entry in the
    // next index still references, even when the selected conversation dropped it.
    const referencedPaths = new Set(nextIndex.conversations.flatMap((archived) => [
      archived.path,
      ...(Array.isArray(archived.assets) ? archived.assets.map((asset) => asset?.path) : []),
    ]).filter(Boolean));
    const plannedWritesBeforeCleanup = new Set(changes.filter((change) => !change.delete).map((change) => change.path));
    const seenDeletes = new Set();
    changes = changes.filter((change) => {
      if (!change.delete) return true;
      if (referencedPaths.has(change.path) || plannedWritesBeforeCleanup.has(change.path)) return false;
      if (seenDeletes.has(change.path)) return false;
      seenDeletes.add(change.path);
      return true;
    });

    // Do not publish an index that points to files missing from GitHub. Missing
    // files for selected conversations are repaired by the planned writes above;
    // missing files for unselected conversations require syncing those conversations.
    const plannedWrites = new Set(changes.filter((change) => !change.delete).map((change) => change.path));
    const plannedDeletes = new Set(changes.filter((change) => change.delete).map((change) => change.path));
    for (const archived of nextIndex.conversations) {
      const requiredPaths = [archived.path, ...(Array.isArray(archived.assets) ? archived.assets.map((asset) => asset?.path) : [])].filter(Boolean);
      const missing = requiredPaths.filter((requiredPath) =>
        plannedDeletes.has(requiredPath)
          ? !plannedWrites.has(requiredPath)
          : !existingPaths.has(requiredPath) && !plannedWrites.has(requiredPath)
      );
      if (missing.length) {
        throw new Error(`Archive integrity check failed: ${missing.length} file(s) referenced by "${archived.title || archived.id}" are missing from GitHub (${missing.slice(0, 3).join(', ')}). Sync that conversation to repair it; no archive changes were published.`);
      }
    }

    // An empty repository has no ref/base tree. GitHub will reject /git/blobs
    // with 409 until the repository has its first commit, so initialize it
    // before using the Git Database API.
    if (!ref) {
      await initializeEmptyRepository();
      assertNotCancelled();
      ref = await getRef();
      if (!ref) throw Error('GitHub repository was initialized but no branch could be found.');
      branch = ref.ref.split('/').pop();
      baseCommit = await gh(`/git/commits/${ref.object.sha}`);
      baseTree = await gh(`/git/trees/${baseCommit.tree.sha}?recursive=1`);
      if (baseTree?.truncated) {
        throw new Error('The GitHub archive tree is too large to verify safely. No archive changes were published.');
      }
      existingPaths = new Set((baseTree?.tree || []).map((item) => item.path));
    }

    if (changedConversations === 0 && !indexNeedsUpdate && ref) {
      onProgress?.({ stage: 'done', total, changed: 0, commit: null, message: 'Everything is already up to date. No GitHub commit was needed.' });
      return { total, changed: 0, commit: null };
    }

    const completionMessage = changedConversations === 0
      ? 'Sync complete: the search cache was compacted; no conversation Markdown changed in 1 GitHub commit.'
      : `Sync complete: ${changedConversations} conversation${changedConversations === 1 ? '' : 's'} changed in 1 GitHub commit.`;

    const treeEntries = new Array(changes.length);
    const uploadTotal = changes.filter((x) => !x.delete).length + 1;
    onProgress?.({ stage: 'uploading', current: 0, total: uploadTotal, changed: changedConversations });
    let uploaded = 0;
    let nextChangeIndex = 0;
    let firstUploadError = null;

    // Blob writes are independent, so upload a small bounded batch in parallel.
    // Keep tree entries indexed by the original change order so path updates and
    // deletions remain deterministic in the final tree payload.
    async function uploadWorker() {
      while (true) {
        if (firstUploadError) return;
        const i = nextChangeIndex++;
        if (i >= changes.length) return;
        const change = changes[i];
        try {
          assertNotCancelled();
          if (change.delete) {
            treeEntries[i] = { path: change.path, mode: '100644', type: 'blob', sha: null };
            continue;
          }

          const blob = await createBlob(change.content, change.encoding || 'utf-8');
          assertNotCancelled();
          treeEntries[i] = { path: change.path, mode: '100644', type: 'blob', sha: blob.sha };
          uploaded += 1;
          onProgress?.({ stage: 'uploading', current: uploaded, total: uploadTotal, changed: changedConversations });
        } catch (error) {
          if (!firstUploadError) firstUploadError = error;
          return;
        }
      }
    }

    const workerCount = Math.min(BLOB_UPLOAD_CONCURRENCY, Math.max(1, changes.length));
    await Promise.all(Array.from({ length: workerCount }, () => uploadWorker()));
    if (firstUploadError) throw firstUploadError;
    assertNotCancelled();
    assertNotCancelled();
    const indexBlob = await createBlob(JSON.stringify(nextIndex, null, 2));
    treeEntries.push({ path: 'archive/index.json', mode: '100644', type: 'blob', sha: indexBlob.sha });
    onProgress?.({ stage: 'uploading', current: uploadTotal, total: uploadTotal, changed: changedConversations });

    onProgress?.({ stage: 'creating-tree', current: 0, total: 1, changed: changedConversations });
    const treePayload = { tree: treeEntries };
    if (baseTree?.sha) treePayload.base_tree = baseTree.sha;
    const tree = await gh('/git/trees', { method: 'POST', body: JSON.stringify(treePayload) });

    onProgress?.({ stage: 'creating-commit', current: 0, total: 1, changed: changedConversations });
    const commit = await gh('/git/commits', {
      method: 'POST',
      body: JSON.stringify({
        message: `Sync ${changes.length} AI conversation${changes.length === 1 ? '' : 's'}`,
        tree: tree.sha,
        ...(baseCommit ? { parents: [baseCommit.sha] } : {}),
      }),
    });
    onProgress?.({ stage: 'creating-commit', current: 1, total: 1, changed: changedConversations });

    onProgress?.({ stage: 'finalizing', current: 0, total: 1, changed: changedConversations });

    // The tree and commit were built against baseCommit. If someone else pushed
    // during this sync, do not try to publish a sibling commit over their update.
    // The non-force PATCH below remains the final race guard between this check
    // and the ref update itself.
    const latestRef = await gh(`/git/ref/heads/${branch}`);
    if (baseCommit && latestRef?.object?.sha !== baseCommit.sha) {
      throw new Error('The GitHub branch changed during this sync. Nothing was published; run sync again to include the latest archive.');
    }
    try {
      await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
    } catch (publishError) {
      // A timeout or cancellation can happen after GitHub accepted the PATCH but
      // before the response reaches this client. Verify the branch head without
      // the aborted sync signal before reporting cancellation or failure.
      let observedRef;
      try {
        observedRef = await gh(`/git/ref/heads/${branch}`, {}, true);
      } catch (verificationError) {
        const error = new Error(
          `The GitHub ref update returned an error and its outcome could not be verified. Check the "${branch}" branch on GitHub before retrying. Update error: ${String(publishError?.message || publishError)}. Verification error: ${String(verificationError?.message || verificationError)}`,
        );
        error.name = 'PublicationUncertainError';
        throw error;
      }

      if (observedRef?.object?.sha === commit.sha) {
        // The server committed the ref update despite the lost/aborted response.
        // Report success rather than incorrectly telling the user it was cancelled.
        onProgress?.({
          stage: 'done',
          current: 1,
          total: 1,
          changed: changedConversations,
          commit: commit.sha,
          message: `${completionMessage} The response to the final update was interrupted, but GitHub confirms the commit is published.`,
        });
        return { total, changed: changedConversations, commit: commit.sha };
      }

      if (baseCommit && observedRef?.object?.sha === baseCommit.sha) {
        // The original head is still present, so the attempted update did not
        // become visible. Preserve the original error (including cancellation).
        throw publishError;
      }

      const error = new Error(
        `The GitHub ref update returned an error and the branch now points to a different commit. The sync commit may or may not have been published before another update; inspect the "${branch}" branch history before retrying. Update error: ${String(publishError?.message || publishError)}`,
      );
      error.name = 'PublicationUncertainError';
      throw error;
    }

    onProgress?.({ stage: 'done', current: 1, total: 1, changed: changedConversations, commit: commit.sha, message: completionMessage });
    return { total, changed: changedConversations, commit: commit.sha };
  } finally {
    syncRunning = false;
    syncAbortController = null;
    activeProgressCallback = null;
    activeGitHubSettings = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'syncProgress' && sender?.tab) {
    const { type, ...progress } = msg;
    contentSyncState = { ...progress, tabId: sender.tab.id, at: Date.now() };
    return false;
  }
  if (msg.type === 'getSyncState') {
    if (!syncRunning && contentSyncRunning()) {
      const { at, tabId, ...progress } = contentSyncState;
      sendResponse({ running: true, ...progress });
    } else {
      sendResponse({ running: syncRunning, ...lastSyncState });
    }
    return false;
  }
  if (msg.type === 'cancelSync') {
    // The popup may have been reopened on another tab: stop the fetch in the
    // Claude tab that is actually running it.
    if (contentSyncRunning() && contentSyncState.tabId != null) {
      try { chrome.tabs?.sendMessage?.(contentSyncState.tabId, { type: 'cancelSync' })?.catch?.(() => {}); } catch {}
      contentSyncState = { ...contentSyncState, stage: 'cancelled' };
    }
    cancelRequested = true;
    syncAbortController?.abort();
    broadcast({ stage: 'cancelled', message: 'Sync cancelled.' });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'syncNormalized') {
    // A content script can finish collecting data before the GitHub sync has
    // completed. Ignore duplicate handoffs rather than creating competing
    // commits against the same branch head.
    if (syncRunning) {
      sendResponse({ ok: true, alreadyRunning: true });
      return false;
    }

    sync(msg.conversations, broadcast)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((e) => {
        if (e.name === 'AbortError' || e.message === '__SYNC_CANCELLED__') {
          broadcast({ stage: 'cancelled', message: 'Sync cancelled.' });
          sendResponse({ ok: false, cancelled: true });
        } else {
          broadcast({ stage: 'error', error: e.message });
          sendResponse({ ok: false, error: e.message });
        }
      });
    return true;
  }
});
