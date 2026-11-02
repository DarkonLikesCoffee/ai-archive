const MIME_TYPE_PATTERN = new RegExp('^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$', 'i');
const SAFE_INLINE_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/bmp', 'image/avif', 'image/x-icon',
]);
const SAFE_GITHUB_HOSTS = new Set(['github.com', 'raw.githubusercontent.com']);

export function normalizeMimeType(value, fallback = 'application/octet-stream') {
  const candidate = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return MIME_TYPE_PATTERN.test(candidate) ? candidate : fallback;
}

export function isSafeImagePreviewMime(value) {
  return SAFE_INLINE_IMAGE_MIMES.has(normalizeMimeType(value, ''));
}

const SAFE_IMAGE_DATA_URL = new RegExp(
  '^data:image/(?:png|jpeg|gif|webp|bmp|avif|x-icon);base64,[a-z0-9+/]+={0,2}$',
  'i',
);

export function isSafeImageDataUrl(value) {
  return SAFE_IMAGE_DATA_URL.test(String(value ?? ''));
}

function trustedHttpsUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase())
    || url.username || url.password || url.port) return null;
  return url.href;
}

// Attachment links may point only to GitHub or its official raw-content host.
export function safeGitHubAttachmentUrl(value) {
  return trustedHttpsUrl(value, SAFE_GITHUB_HOSTS);
}

// This URL is fetched with the private GitHub token, so its host is restricted
// to raw.githubusercontent.com before the Authorization header is sent.
export function safeRawGitHubDownloadUrl(value) {
  return trustedHttpsUrl(value, new Set(['raw.githubusercontent.com']));
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

export function renderInlineImageHtml(dataUrl, name) {
  if (!isSafeImageDataUrl(dataUrl)) return '';
  return '<img class="md-image" src="' + escapeHtml(dataUrl)
    + '" alt="' + escapeHtml(name) + '" />';
}

export function renderImageLinkHtml({ href, dataUrl, name }) {
  if (!isSafeImageDataUrl(dataUrl)) return '';
  const safeHref = escapeHtml(safeGitHubAttachmentUrl(href) || '#');
  return '<a class="md-image-link" href="' + safeHref
    + '" target="_blank" rel="noopener noreferrer"><img class="md-image" src="'
    + escapeHtml(dataUrl) + '" alt="' + escapeHtml(name)
    + '" loading="lazy" /></a>';
}

export function renderAttachmentCardHtml({ href, name, mime }) {
  const safeHref = escapeHtml(safeGitHubAttachmentUrl(href) || '#');
  const type = String(mime || 'file').replace(/^application\//, '').replace(/^text\//, '');
  return '<a class="md-attachment-card" href="' + safeHref
    + '" target="_blank" rel="noopener noreferrer"><span class="attachment-icon">↗</span>'
    + '<span class="attachment-info"><strong>' + escapeHtml(name)
    + '</strong><small>' + escapeHtml(type) + '</small></span></a>';
}
