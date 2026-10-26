// Archive-wide search over the index's title and search_text.
//
// Every term must appear somewhere in the conversation (words in any order;
// "quoted phrases" stay together). Results are ranked by title matches, then
// by how often the terms occur, then by recency, and carry a short snippet
// around the first match so the list shows why a conversation matched.

const MAX_COUNTED_OCCURRENCES = 50;

export function parseSearchQuery(query) {
  const terms = [];
  const pattern = /"([^"]*)"?|(\S+)/g;
  for (const match of String(query ?? '').matchAll(pattern)) {
    const term = (match[1] ?? match[2] ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  while (count < MAX_COUNTED_OCCURRENCES) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

// Split `text` into [{ text, match }] parts, marking every term occurrence.
function markTerms(text, terms) {
  const lower = text.toLowerCase();
  const parts = [];
  let position = 0;
  while (position < text.length) {
    let next = -1;
    let length = 0;
    for (const term of terms) {
      const at = lower.indexOf(term, position);
      if (at >= 0 && (next < 0 || at < next || (at === next && term.length > length))) {
        next = at;
        length = term.length;
      }
    }
    if (next < 0) {
      parts.push({ text: text.slice(position), match: false });
      break;
    }
    if (next > position) parts.push({ text: text.slice(position, next), match: false });
    parts.push({ text: text.slice(next, next + length), match: true });
    position = next + length;
  }
  return parts;
}

function makeSnippet(text, terms, radius) {
  const lower = text.toLowerCase();
  let first = -1;
  let firstLength = 0;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) {
      first = at;
      firstLength = term.length;
    }
  }
  if (first < 0) return null;
  const start = Math.max(0, first - radius);
  const end = Math.min(text.length, first + firstLength + radius);
  const window = text.slice(start, end).replace(/\s+/g, ' ');
  const parts = markTerms(window, terms);
  if (start > 0) parts.unshift({ text: '…', match: false });
  if (end < text.length) parts.push({ text: '…', match: false });
  return parts;
}

/**
 * Search index entries. Returns null for an empty query (show the normal
 * list), otherwise ranked [{ conversation, score, snippet }].
 */
export function searchConversations(conversations, query, { snippetRadius = 70 } = {}) {
  const terms = parseSearchQuery(query);
  if (!terms.length) return null;

  const results = [];
  for (const conversation of conversations || []) {
    const title = String(conversation?.title || '').toLowerCase();
    const body = String(conversation?.search_text || '');
    const bodyLower = body.toLowerCase();
    let score = 0;
    let matchesAll = true;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const occurrences = countOccurrences(bodyLower, term);
      if (!inTitle && !occurrences) {
        matchesAll = false;
        break;
      }
      score += (inTitle ? 1000 : 0) + occurrences;
    }
    if (!matchesAll) continue;
    results.push({ conversation, score, snippet: makeSnippet(body, terms, snippetRadius) });
  }

  return results.sort((a, b) => (b.score - a.score)
    || String(b.conversation.updated_at || '').localeCompare(String(a.conversation.updated_at || '')));
}
