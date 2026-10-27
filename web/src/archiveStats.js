// Totals for the archive overview, computed from the index alone (no
// conversation files are downloaded).

function time(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

function monthKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function countBy(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

export function archiveStats(conversations, { locale } = {}) {
  const list = Array.isArray(conversations) ? conversations : [];
  let messages = 0;
  let attachments = 0;
  let attachmentBytes = 0;
  let first = null;
  let last = null;
  const months = new Map();
  for (const c of list) {
    messages += Number(c?.message_count) || 0;
    for (const asset of (Array.isArray(c?.assets) ? c.assets : [])) {
      attachments += 1;
      attachmentBytes += Number(asset?.size) || 0;
    }
    // A conversation counts in the month it was started.
    const started = time(c?.created_at) ?? time(c?.updated_at);
    if (started !== null) {
      if (first === null || started < first) first = started;
      const latest = time(c?.updated_at) ?? started;
      if (last === null || latest > last) last = latest;
      const key = monthKey(started);
      months.set(key, (months.get(key) || 0) + 1);
    }
  }

  // Every month from the first to the last conversation, empty months included,
  // so gaps in activity are visible.
  const byMonth = [];
  if (first !== null) {
    const start = new Date(first);
    const end = new Date(Math.max(...[...months.keys()].map((k) => new Date(`${k}-01T00:00:00`).getTime())));
    for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= end; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const key = monthKey(d.getTime());
      byMonth.push({ key, label: d.toLocaleDateString(locale, { month: 'short', year: 'numeric' }), count: months.get(key) || 0 });
    }
  }

  return {
    conversations: list.length,
    messages,
    attachments,
    attachmentBytes,
    firstAt: first === null ? null : new Date(first).toISOString(),
    lastAt: last === null ? null : new Date(last).toISOString(),
    byMonth,
    byModel: countBy(list, (c) => c?.model || 'Unknown model').map(({ key, count }) => ({ model: key, count })),
    byAccount: countBy(list, (c) => `${c?.provider || 'unknown'} · ${c?.account || 'personal'}`).map(({ key, count }) => ({ account: key, count })),
  };
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
