// The reader's outline: one entry per prompt you sent, so a long
// conversation can be navigated by question.

function plainText(markdown) {
  return String(markdown ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, ' [code] ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function promptOutline(messages, { maxLength = 80 } = {}) {
  const outline = [];
  (messages || []).forEach((message, index) => {
    if (message?.role !== 'user') return;
    let label = plainText(message.content);
    if (!label) label = 'Attachment';
    else if (label.length > maxLength) label = `${label.slice(0, maxLength - 1).trimEnd()}…`;
    outline.push({ index, label });
  });
  return outline;
}
