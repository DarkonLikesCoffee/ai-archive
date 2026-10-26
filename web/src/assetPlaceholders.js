const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'" };

function decodeAttribute(value) {
  return String(value).replace(/&(?:amp|lt|gt|quot|#0?39);/g, (entity) => ENTITIES[entity]);
}

/**
 * List the asset paths referenced by the reader's image/attachment
 * placeholders in rendered message HTML. Reading them back from the rendered
 * output, rather than re-parsing the Markdown source with a simpler pattern,
 * keeps every link Marked recognized: exported labels escape brackets and
 * parentheses (`Screenshot \[2\].png`), which a `[^\]]*` label pattern misses.
 *
 * `attribute` is the value exactly as it appears in the HTML (for replacing
 * the placeholder); `path` is the decoded asset path (for looking it up).
 */
export function assetPlaceholderPaths(html) {
  const seen = new Set();
  const result = [];
  for (const match of String(html ?? '').matchAll(/data-md-(?:image|attachment)="([^"]*)"/g)) {
    const attribute = match[1];
    if (seen.has(attribute)) continue;
    seen.add(attribute);
    result.push({ path: decodeAttribute(attribute), attribute });
  }
  return result;
}
