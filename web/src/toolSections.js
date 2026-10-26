// The exporter closes tool sections that contain more than one fenced block
// (tool metadata plus readable bodies such as artifact content) with this
// line. GitHub hides it as an HTML comment; older archives never contain it.
export const TOOL_SECTION_END = '<!-- /tool -->';

function isToolHeading(line) {
  return /^### (Claude tool|Tool result): /.test(line);
}

/**
 * Return the index of the end marker that closes the tool section whose
 * heading is at `start`, or -1 when the section has no marker (a legacy
 * single-fence section). Fenced content is skipped, so code that contains a
 * heading-like line or the marker itself cannot end the section early.
 */
export function terminatedToolSectionEnd(lines, start) {
  let fence = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (fence.test(line)) fence = null;
      continue;
    }
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (open) {
      fence = new RegExp(`^\\s*${open[1][0]}{${open[1].length},}\\s*$`);
      continue;
    }
    if (line.trim() === TOOL_SECTION_END) return i;
    if (isToolHeading(line) || /^#{1,2} /.test(line)) return -1;
  }
  return -1;
}
