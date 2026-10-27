// Keyboard shortcuts for the viewer:
//   /        focus search (the list) or find (a conversation)
//   j / k    next / previous conversation in the list
//   Escape   leave a field; in a conversation, go back to the list
// Typing in a field or using a modifier never triggers a shortcut, except
// Escape, which always leaves the field.

function isEditable(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function shortcutFor(event) {
  if (!event || event.defaultPrevented || event.isComposing) return null;
  if (event.key === 'Escape') return isEditable(event.target) ? 'leave-field' : 'escape';
  if (event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return null;
  if (event.key === '/') return 'focus-search';
  if (event.key === 'j') return 'next';
  if (event.key === 'k') return 'previous';
  return null;
}

// Index of the item to focus after moving `step` from `current` (-1 when
// nothing is focused yet), clamped to the list.
export function moveFocusIndex(current, step, length) {
  if (!length) return -1;
  if (current < 0) return step > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + step));
}
