// Ordering and date grouping for the conversation list.
//
// Sorts: 'auto' (see effectiveSort), 'updated', 'created', 'oldest' (created,
// oldest first) and 'title'. sortConversations keeps the incoming order for
// 'auto', which is the search ranking.

export const SORTS = ['auto', 'updated', 'created', 'oldest', 'title'];

export function sortOptions(searching) {
  return [
    { value: 'auto', label: searching ? 'Best match' : 'Recently updated' },
    ...(searching ? [{ value: 'updated', label: 'Recently updated' }] : []),
    { value: 'created', label: 'Recently created' },
    { value: 'oldest', label: 'Oldest first' },
    { value: 'title', label: 'Title A–Z' },
  ];
}

// 'auto' means search relevance while searching, otherwise recently updated.
export function effectiveSort(sort, searching) {
  const known = SORTS.includes(sort) ? sort : 'auto';
  return known === 'auto' && !searching ? 'updated' : known;
}

function time(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

// The date a sort is about: created for created/oldest, otherwise updated.
export function sortDate(conversation, sort) {
  return sort === 'created' || sort === 'oldest'
    ? conversation?.created_at || conversation?.updated_at || null
    : conversation?.updated_at || conversation?.created_at || null;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function sortConversations(conversations, sort = 'auto') {
  const items = [...(conversations || [])];
  if (sort === 'title') {
    return items.sort((a, b) => collator.compare(String(a?.title || ''), String(b?.title || '')));
  }
  if (sort === 'updated' || sort === 'created' || sort === 'oldest') {
    const direction = sort === 'oldest' ? 1 : -1;
    // Undated conversations always go last; ties keep the incoming order.
    return items.sort((a, b) => {
      const ta = time(sortDate(a, sort));
      const tb = time(sortDate(b, sort));
      if (ta === null || tb === null) return (ta === null) - (tb === null);
      return direction * (ta - tb);
    });
  }
  return items;
}

function startOfDay(t) {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dateGroupLabel(value, now = Date.now(), locale = undefined) {
  const t = time(value);
  if (t === null) return 'No date';
  const days = Math.round((startOfDay(now) - startOfDay(t)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  if (days < 30) return 'Previous 30 days';
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
}

/**
 * Split a list sorted by `sort` (an effective sort) into consecutive date
 * groups, or return null when the sort is not chronological.
 */
export function groupByDate(conversations, sort, { now = Date.now(), locale } = {}) {
  if (sort !== 'updated' && sort !== 'created' && sort !== 'oldest') return null;
  const groups = [];
  for (const conversation of conversations || []) {
    const label = dateGroupLabel(sortDate(conversation, sort), now, locale);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(conversation);
    else groups.push({ label, items: [conversation] });
  }
  return groups;
}
