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
    if (result?.value) return { html: result.html || result.value, language: result.language || '' };
  } catch {
    // Unknown or unsupported code is still rendered as escaped text below.
  }

  return { html: escapeHtml(source), language: requestedLanguage };
}

/**
 * Render Markdown while allowing the archive reader to preserve its special
 * asset placeholders. Hooks must return a string to override default output;
 * returning undefined delegates to the safe default renderer.
 */
export function renderMarkdownWithMarked(markdown, options = {}) {
  const renderer = new marked.Renderer();

  renderer.code = ({ text, lang }) => {
    const { html, language } = highlightCode(text, lang);
    const languageClass = language ? ` language-${escapeHtml(language)}` : '';
    // The button's label comes from CSS, so it adds no text to find or copy.
    return `\n<div class="code-block"><button class="copy-code" type="button" aria-label="Copy code" title="Copy code" data-copy-code></button><pre><code class="hljs${languageClass}">${html}</code></pre></div>\n`;
  };

  // A regular function so Marked can bind `this.parser`. The raw `text` is
  // unescaped Markdown source, so it must never be emitted as HTML: render the
  // label's inline tokens instead, which routes raw HTML through renderer.html.
  renderer.link = function ({ href, title, text, tokens }) {
    const custom = options.renderLink?.({ href, title, text });
    if (typeof custom === 'string') return custom;

    const label = this.parser.parseInline(tokens);
    const url = safeUrl(href);
    if (!url) return label;

    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    const external = /^https?:\/\//i.test(url);
    const target = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeHtml(url)}"${titleAttribute}${target}>${label}</a>`;
  };

  renderer.image = ({ href, title, text }) => {
    const custom = options.renderImage?.({ href, title, text });
    if (typeof custom === 'string') return custom;

    const url = safeUrl(href);
    if (!url) return escapeHtml(text || '');
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}"${titleAttribute} loading="lazy" />`;
  };

  // Archived content is untrusted. Never allow raw HTML from the Markdown
  // source to become executable markup when inserted with innerHTML.
  renderer.html = ({ text }) => escapeHtml(text);

  return marked.parse(String(markdown ?? ''), {
    gfm: true,
    breaks: true,
    renderer,
  });
}
