// AI Archive background service worker.
// Sync state lives here so the popup can open/close without losing progress.
const API = 'https://api.github.com';
let syncAbortController = null;
let cancelRequested = false;
let syncRunning = false;
let lastSyncState = { stage: 'idle' };

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

async function gh(path, opts = {}) {
  assertNotCancelled();
  const s = await settings();
  if (!s.github_owner || !s.github_repo || !s.github_token) throw Error('Configure GitHub settings in the extension popup first.');
  const headers = {
    Authorization: `Bearer ${s.github_token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const controller = syncAbortController;
  const r = await fetch(`${API}/repos/${encodeURIComponent(s.github_owner)}/${encodeURIComponent(s.github_repo)}${path}`, {
    ...opts,
    headers,
    signal: controller?.signal,
  });
  const text = await r.text();
  if (!r.ok) throw Error(`GitHub ${r.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
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

function conversationPath(c, provider, accountSlug) {
  const shortId = String(c.external_id || 'unknown').slice(0, 8);
  return `archive/conversations/${provider}/${accountSlug}/${filenameSlug(c.title)}--${shortId}.md`;
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
  let path = `archive/conversations/${provider}/${accountSlug}/assets/${String(c.external_id).slice(0, 8)}/${name}`;
  let n = 2;
  while (usedPaths.has(path)) {
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    name = `${hash}-${stem}-${n}${ext}`;
    path = `archive/conversations/${provider}/${accountSlug}/assets/${String(c.external_id).slice(0, 8)}/${name}`;
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

function assetMarkdown(asset, path) {
  const label = asset.name || 'file';
  const rel = `assets/${String(path).split('/assets/').pop()}`;
  if (isImageAsset(asset)) return `![${label}](${rel})`;
  return `[${label}](${rel})`;
}

function isReplyExcerptAttachment(file) {
  const name = String(file?.file_name || file?.name || '').trim().toLowerCase();
  return name === 'excerpt_from_previous_claude_message.txt' || name.startsWith('excerpt_from_previous_claude_message.');
}

function assetMatchesMessage(asset, message) {
  if (!asset || !message) return false;
  const messageId = message.external_id || message.uuid || message.id || null;
  if (asset.message_external_id && messageId && asset.message_external_id === messageId) return true;

  const names = new Set();
  for (const file of (message.files || [])) {
    if (file?.file_uuid) names.add(`id:${file.file_uuid}`);
    if (file?.uuid) names.add(`id:${file.uuid}`);
    if (file?.file_name) names.add(`name:${String(file.file_name).toLowerCase()}`);
    if (file?.name) names.add(`name:${String(file.name).toLowerCase()}`);
  }
  for (const attachment of (message.attachments || [])) {
    if (attachment?.file_name) names.add(`name:${String(attachment.file_name).toLowerCase()}`);
    if (attachment?.name) names.add(`name:${String(attachment.name).toLowerCase()}`);
  }

  if (asset.file_uuid && (names.has(`id:${asset.file_uuid}`))) return true;
  if (asset.name && names.has(`name:${String(asset.name).toLowerCase()}`)) return true;

  // Claude-generated sandbox files are usually mentioned by basename/path in the
  // tool_use block that created them. Use that as a fallback association so the
  // file stays beside the corresponding Claude response instead of at the end.
  const haystack = JSON.stringify(message.metadata || message).toLowerCase();
  const sourcePath = String(asset.source_path || '').toLowerCase();
  const baseName = String(asset.name || '').toLowerCase();
  if (sourcePath && haystack.includes(sourcePath)) return true;
  if (baseName && baseName.length > 1 && haystack.includes(baseName)) return true;
  return false;
}

function findMessageAssets(message, allAssets) {
  return allAssets.filter((asset) => assetMatchesMessage(asset, message));
}

function attachmentMarkdown(message, assetMap, allAssets) {
  const parts = [];
  const assets = findMessageAssets(message, allAssets);
  const used = new Set();

  const addAsset = (asset) => {
    if (!asset || used.has(asset.path)) return;
    used.add(asset.path);
    parts.push(assetMarkdown(asset, asset.path));
  };

  for (const file of (message.files || [])) {
    const id = file?.file_uuid || file?.uuid || null;
    const name = file?.file_name || file?.name || null;
    const asset = (id && assetMap.get(`id:${id}`)) ||
      (name && assetMap.get(`name:${name}`)) ||
      assets.find((x) => (id && x.file_uuid === id) || (name && String(x.name).toLowerCase() === String(name).toLowerCase()));
    addAsset(asset);
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

    const asset = assetMap.get(`name:${name}`) || assets.find((x) => String(x.name).toLowerCase() === nameKey);
    if (asset) {
      addAsset(asset);
    } else {
      // Do not inline extracted file contents. If Claude exposes only an extraction,
      // the content-side collector materializes it as a text asset before rendering.
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

    // User attachments/reply excerpts are shown before the user's message, matching
    // Claude's UI. Claude-generated files stay with the Claude response that produced
    // or referenced them, rather than being dumped into a trailing Files section.
    const body = role === 'You'
      ? [attachments, m.content].filter(Boolean).join('\n\n')
      : [m.content, attachments].filter(Boolean).join('\n\n');
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
    preview: String(c.messages.find((m) => m.content)?.content || '').slice(0, 300),
    search_text: [c.title, ...c.messages.map((m) => m.content)].join('\n').slice(0, 250000),
  };
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
    const account = s.archive_account?.trim() || 'personal';
    const accountSlug = slugify(account);
    const provider = 'claude';
    let ref = await getRef();
    assertNotCancelled();
    let branch = ref ? ref.ref.split('/').pop() : 'main';
    let baseCommit = ref ? await gh(`/git/commits/${ref.object.sha}`) : null;
    let baseTree = baseCommit ? await gh(`/git/trees/${baseCommit.tree.sha}`) : null;

    let index = { version: 2, updated_at: new Date().toISOString(), conversations: [] };
    const indexFile = ref ? await getFile('archive/index.json', branch) : null;
    if (indexFile?.content) {
      try { index = JSON.parse(base64DecodeContent(indexFile.content)); } catch { /* rebuild below */ }
    }

    const map = new Map((index.conversations || []).map((x) => [`${x.provider}:${x.account}:${x.id}`, x]));
    const changes = [];
    let changedConversations = 0;
    const total = conversations.length;

    for (let i = 0; i < total; i++) {
      assertNotCancelled();
      const c = conversations[i];
      const path = conversationPath(c, provider, accountSlug);
      const normalizedAssets = normalizeAssetList(c, provider, accountSlug);
      const markdown = conversationMarkdown(c, provider, account, normalizedAssets.byKey, normalizedAssets.assets);
      const entry = indexEntry(c, path, provider, account, normalizedAssets.assets);
      entry.content_sha256 = await sha256(markdown);
      const key = `${provider}:${account}:${c.external_id}`;
      const previous = map.get(key);
      const previousAssets = Array.isArray(previous?.assets) ? previous.assets : [];
      const currentAssetSignature = JSON.stringify(entry.assets);
      const previousAssetSignature = JSON.stringify(previousAssets);
      const changed = !previous
        || previous.updated_at !== entry.updated_at
        || previous.message_count !== entry.message_count
        || previous.title !== entry.title
        || previous.path !== path
        || previous.format_version !== 4
        || previous.content_sha256 !== entry.content_sha256
        || previousAssetSignature !== currentAssetSignature;

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
          if (!previousAsset) {
            changes.push({ path: asset.path, content: asset.base64, encoding: 'base64' });
          }
        }
      }
      onProgress?.({ stage: 'checking', current: i + 1, total, changed: changedConversations });
    }

    const nextIndex = {
      version: 2,
      updated_at: new Date().toISOString(),
      conversations: [...map.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')),
    };

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
      baseTree = await gh(`/git/trees/${baseCommit.tree.sha}`);
    }

    if (changedConversations === 0 && ref) {
      onProgress?.({ stage: 'done', total, changed: 0, commit: null, message: 'Everything is already up to date. No GitHub commit was needed.' });
      return { total, changed: 0, commit: null };
    }

    const treeEntries = [];
    const uploadTotal = changes.filter((x) => !x.delete).length + 1;
    onProgress?.({ stage: 'uploading', current: 0, total: uploadTotal, changed: changedConversations });
    let uploaded = 0;
    for (let i = 0; i < changes.length; i++) {
      assertNotCancelled();
      const change = changes[i];
      if (change.delete) {
        treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: null });
        continue;
      }
      const blob = await createBlob(change.content, change.encoding || 'utf-8');
      treeEntries.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha });
      uploaded += 1;
      onProgress?.({ stage: 'uploading', current: uploaded, total: uploadTotal, changed: changedConversations });
    }
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
    await gh(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
    onProgress?.({ stage: 'done', current: 1, total: 1, changed: changedConversations, commit: commit.sha, message: `Sync complete: ${changedConversations} conversation${changedConversations === 1 ? '' : 's'} changed in 1 GitHub commit.` });
    return { total, changed: changedConversations, commit: commit.sha };
  } finally {
    syncRunning = false;
    syncAbortController = null;
    activeProgressCallback = null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getSyncState') {
    sendResponse({ running: syncRunning, ...lastSyncState });
    return false;
  }
  if (msg.type === 'cancelSync') {
    cancelRequested = true;
    syncAbortController?.abort();
    broadcast({ stage: 'cancelled', message: 'Sync cancelled.' });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === 'syncNormalized') {
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
