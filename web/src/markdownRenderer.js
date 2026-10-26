import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Keep links local or on well-known, non-executable URL schemes.
 * Escaping an attribute alone does not prevent javascript: URLs.
 */
function safeUrl(value) {
  const url = String(value ?? '').trim();
  if (!url) return null;

  // Permit relative links and in-page anchors used by archived documents.
  if (/^(?:#|\/|\.\/|\.\.\/)/.test(url)) return url;

  try {
    const parsed = new URL(url, 'https://archive.invalid/');
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return url;
  } catch {
    return null;
  }

  return null;
}

function highlightCode(code, language) {
  const source = String(code ?? '');
  const requestedLanguage = String(language ?? '').trim().toLowerCase();

  if (requestedLanguage && hljs.getLanguage(requestedLanguage)) {
    try {
      return {
        html: hljs.highlight(source, {
          language: requestedLanguage,
          ignoreIllegals: true,
        }).value,
        language: requestedLanguage,
      };
    } catch {
      // Fall back to automatic language detection.
    }
  }

  try {
    const result = hljs.highlightAuto(source);
    if (result?.value) return { html: result.value, language: result.language || '' };
  } catch {
    // Unknown or unsupported code is still rendered as escaped text below.
  }

  return { html: escapeHtml(source), language: requestedLanguage };
}

const renderer = new marked.Renderer();

renderer.code = ({ text, lang }) => {
  const { html, language } = highlightCode(text, lang);
  const languageClass = language ? ` language-${escapeHtml(language)}` : '';
  return `\n<div class="code-block"><pre><code class="hljs${languageClass}">${html}</code></pre></div>\n`;
};

renderer.link = ({ href, title, text }) => {
  const url = safeUrl(href);
  if (!url) return text;

  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
  const external = /^https?:\/\//i.test(url);
  const target = external ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<a href="${escapeHtml(url)}"${titleAttribute}${target}>${text}</a>`;
};

renderer.image = ({ href, title, text }) => {
  const url = safeUrl(href);
  if (!url) return escapeHtml(text || '');
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${titleAttribute} loading="lazy" />`;
};

// Archived content is untrusted. Never allow raw HTML from the Markdown source
// to become executable markup when the result is inserted with innerHTML.
renderer.html = ({ text }) => escapeHtml(text);

export function renderMarkdownWithMarked(markdown) {
  return marked.parse(String(markdown ?? ''), {
    gfm: true,
    breaks: true,
    renderer,
  });
}
