const API = 'https://api.github.com';

export function encodePath(path) { return path.split('/').map(encodeURIComponent).join('/'); }

export async function githubRequest(settings, path, opts = {}) {
  const r = await fetch(`${API}/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function decodeBase64(b64) {
  const binary = atob(String(b64).replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function base64ToDataUrl(content, mime = 'application/octet-stream') {
  return `data:${mime};base64,${String(content).replace(/\n/g, '')}`;
}

export async function readText(settings, path) {
  const f = await githubRequest(settings, `/contents/${encodePath(path)}`);
  // GitHub's Contents API can omit content for files larger than its inline
  // response limit. Resolve the blob by SHA instead of decoding an empty value.
  if (f?.encoding === 'none' || (typeof f?.content !== 'string' && f?.sha)) {
    if (!f?.sha) throw new Error(`GitHub returned no readable content or blob SHA for ${path}.`);
    const blob = await githubRequest(settings, `/git/blobs/${encodeURIComponent(f.sha)}`);
    if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new Error(`GitHub could not return the full file contents for ${path}.`);
    }
    return decodeBase64(blob.content);
  }
  if (typeof f?.content !== 'string') {
    throw new Error(`GitHub returned an invalid Contents API response for ${path}.`);
  }
  return decodeBase64(f.content);
}

async function decompressSearchText(encoded) {
  if (typeof DecompressionStream !== 'function' || typeof Blob !== 'function' || typeof Response !== 'function') {
    throw new Error('This browser does not support decompression required by the archive search index.');
  }
  const binary = atob(String(encoded || '').replace(/\\n/g, ''));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export async function readIndex(settings) {
  const index = JSON.parse(await readText(settings, 'archive/index.json'));
  if (!Array.isArray(index?.conversations)) return index;

  // Keep memory bounded while inflating per-conversation search caches. Older
  // archives with plain search_text remain supported during gradual migration.
  const conversations = new Array(index.conversations.length);
  let nextIndex = 0;
  let firstError = null;

  async function worker() {
    while (!firstError) {
      const position = nextIndex++;
      if (position >= index.conversations.length) return;
      const entry = index.conversations[position];
      try {
        if (entry?.search_text_encoding === 'gzip-base64') {
          if (typeof entry.search_text_gzip !== 'string') {
            throw new Error('compressed search text is missing its payload');
          }
          const searchText = await decompressSearchText(entry.search_text_gzip);
          const { search_text_gzip, search_text_encoding, ...metadata } = entry;
          conversations[position] = { ...metadata, search_text: searchText };
        } else {
          conversations[position] = entry;
        }
      } catch (error) {
        if (!firstError) {
          firstError = new Error(
            `Could not read the search cache for "${entry?.title || entry?.id || 'unknown conversation'}": ${error?.message || 'invalid compressed data'}`,
          );
        }
        return;
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(4, Math.max(1, index.conversations.length)) },
    () => worker(),
  ));
  if (firstError) throw firstError;
  return { ...index, conversations };
}

export async function readAsset(settings, path, metadata = null) {
  const apiPath = `/contents/${encodePath(path)}`;
  const f = await githubRequest(settings, apiPath);
  const storedMime = String(metadata?.mime || '').split(';')[0].trim();
  const guessedMime = guessMime(path);
  const mime = f.type === 'file'
    ? (storedMime && storedMime !== 'application/octet-stream'
      ? storedMime
      : guessedMime || f.content_type || storedMime || 'application/octet-stream')
    : 'application/octet-stream';

  let dataUrl = '';

  const wantsImagePreview = /^image\//i.test(mime);

  // For private repositories, do not depend on download_url redirects or on
  // the Contents endpoint deciding whether to include inline content. For an
  // image, the blob API gives us authenticated base64 bytes for the exact file
  // SHA, which can be turned directly into a browser-safe data URL.
  if (wantsImagePreview && f.type === 'file' && f.sha) {
    try {
      const blob = await githubRequest(settings, `/git/blobs/${encodeURIComponent(f.sha)}`);
      if (blob?.encoding === 'base64' && blob.content) {
        dataUrl = base64ToDataUrl(blob.content, mime);
      }
    } catch {}
  }

  // Small image files may already be present on the Contents response.
  if (wantsImagePreview && !dataUrl && f.content) {
    dataUrl = base64ToDataUrl(f.content, mime);
  }

  // Last-resort raw fetch, used only for images. Keeping ZIP/PDF/etc. as
  // metadata prevents the dashboard from downloading large attachments just
  // to render a file card.
  if (wantsImagePreview && !dataUrl && f.download_url) {
    try {
      const r = await fetch(f.download_url, {
        headers: {
          Authorization: `Bearer ${settings.token}`,
          Accept: 'application/octet-stream',
        },
      });
      if (r.ok) {
        const blob = await r.blob();
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(new Blob([blob], { type: mime }));
        });
      }
    } catch {}
  }

  return {
    name: path.split('/').pop(),
    path,
    mime,
    dataUrl,
    sha: f.sha,
    htmlUrl: f.html_url,
    downloadUrl: f.download_url,
    size: f.size,
  };
}

function guessMime(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain',
    json: 'application/json', js: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain', css: 'text/css',
    html: 'text/html', md: 'text/markdown', py: 'text/plain', java: 'text/plain', zip: 'application/zip',
  })[ext] || null;
}

export async function readConversation(settings, path) {
  return parseConversationMarkdown(await readText(settings, path));
}

function normalizeMarkdown(markdown) {
  return String(markdown ?? '').replace(/\r\n?/g, '\n');
}

function parseMetadata(markdown) {
  const normalized = normalizeMarkdown(markdown);
  const m = normalized.match(/^<!--\s*AI_ARCHIVE_METADATA\s*\n([\s\S]*?)\n-->[ \t]*(?:\n[ \t]*)*/);
  if (!m) return { metadata: {}, body: normalized };
  try {
    return { metadata: JSON.parse(m[1]), body: normalized.slice(m[0].length) };
  } catch {
    return { metadata: {}, body: normalized.slice(m[0].length) };
  }
}

function splitMessageBlocks(content) {
  const lines = String(content).split('\n');
  const parts = [];
  let current = [];
  let fenceChar = null;
  let fenceLength = 0;

  const isFenceStart = (line) => {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    return match ? match[1] : null;
  };

  const isFenceClose = (line) => {
    if (!fenceChar) return false;
    const expression = new RegExp('^\\s*' + fenceChar + '{' + fenceLength + ',}\\s*$');
    return expression.test(line);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fenceChar) {
      current.push(line);
      if (isFenceClose(line)) { fenceChar = null; fenceLength = 0; }
      continue;
    }
    const fence = isFenceStart(line);
    if (fence) { fenceChar = fence[0]; fenceLength = fence.length; current.push(line); continue; }
    if (line.trim() === '---') {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next < lines.length && /^## /.test(lines[next])) {
        parts.push(current.join('\n'));
        current = [];
        i = next - 1;
        continue;
      }
    }
    current.push(line);
  }
  parts.push(current.join('\n'));
  return parts;
}

export function parseConversationMarkdown(markdown) {
  const { metadata, body } = parseMetadata(markdown);
  const titleMatch = body.match(/^# ([^\n]+)(?:\n\n|\n)/);
  const title = metadata.title || (titleMatch ? titleMatch[1].trim() : 'Untitled conversation');
  const content = titleMatch ? body.slice(titleMatch[0].length) : body;
  const parts = splitMessageBlocks(content);
  const messages = [];
  for (const part of parts) {
    const m = part.match(/^## ([^\n]+)\n(?:\n)?([\s\S]*?)(?:\n)?$/);
    if (!m) continue;
    const roleName = m[1].trim();
    const normalizedRole = roleName.toLowerCase();
    const role = normalizedRole === 'you'
      ? 'user'
      : normalizedRole === String(metadata.provider || '').toLowerCase()
        ? 'assistant'
        : normalizedRole;
    messages.push({ role, roleName, content: m[2].replace(/\n$/, '') });
  }
  return { ...metadata, title, messages };
}
