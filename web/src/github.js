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
  return decodeBase64(f.content);
}

export async function readIndex(settings) {
  return JSON.parse(await readText(settings, 'archive/index.json'));
}

export async function readAsset(settings, path) {
  const apiPath = `/contents/${encodePath(path)}`;
  const f = await githubRequest(settings, apiPath);
  const mime = f.type === 'file'
    ? (guessMime(path) || f.content_type || 'application/octet-stream')
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
  })[ext] || 'application/octet-stream';
}

export async function readConversation(settings, path) {
  return parseConversationMarkdown(await readText(settings, path));
}

function parseMetadata(markdown) {
  const m = markdown.match(/^<!--\s*AI_ARCHIVE_METADATA\s*\n([\s\S]*?)\n-->\s*\n\n?/);
  if (!m) return { metadata: {}, body: markdown };
  try { return { metadata: JSON.parse(m[1]), body: markdown.slice(m[0].length) }; }
  catch { return { metadata: {}, body: markdown.slice(m[0].length) }; }
}

export function parseConversationMarkdown(markdown) {
  const { metadata, body } = parseMetadata(markdown);
  const titleMatch = body.match(/^# ([^\n]+)\n\n/);
  const title = metadata.title || (titleMatch ? titleMatch[1].trim() : 'Untitled conversation');
  const content = titleMatch ? body.slice(titleMatch[0].length) : body;
  const parts = content.split(/\n---\n\n(?=## )/g);
  const messages = [];
  for (const part of parts) {
    const m = part.match(/^## ([^\n]+)\n\n([\s\S]*?)(?:\n)?$/);
    if (!m) continue;
    const roleName = m[1].trim();
    const role = roleName.toLowerCase() === 'you' ? 'user' : roleName.toLowerCase() === metadata.provider ? 'assistant' : roleName.toLowerCase();
    messages.push({ role, roleName, content: m[2].replace(/\n$/, '') });
  }
  return { ...metadata, title, messages };
}
