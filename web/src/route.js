// Hash routes for the viewer, so a conversation can be reloaded, bookmarked,
// or linked, and the browser's Back button returns to the list:
//   #/c/<provider>/<account>/<id>          an open conversation
//   #/?q=<search>&provider=<p>&account=<a>  the list (defaults omitted)

const DEFAULT_LIST = Object.freeze({ view: 'list', provider: 'all', account: 'all', q: '' });

export function formatRoute(route) {
  if (route?.view === 'conversation') {
    return `#/c/${[route.provider, route.account, route.id].map((part) => encodeURIComponent(String(part ?? ''))).join('/')}`;
  }
  const params = new URLSearchParams();
  if (route?.q) params.set('q', route.q);
  if (route?.provider && route.provider !== 'all') params.set('provider', route.provider);
  if (route?.account && route.account !== 'all') params.set('account', route.account);
  const query = params.toString();
  return query ? `#/?${query}` : '#/';
}

export function parseRoute(hash) {
  const value = String(hash ?? '').replace(/^#/, '');
  const conversation = value.match(/^\/c\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (conversation) {
    try {
      const [provider, account, id] = conversation.slice(1).map(decodeURIComponent);
      return { view: 'conversation', provider, account, id };
    } catch {
      return { ...DEFAULT_LIST };
    }
  }
  if (value === '' || value === '/' || value.startsWith('/?')) {
    const params = new URLSearchParams(value.startsWith('/?') ? value.slice(2) : '');
    return {
      view: 'list',
      provider: params.get('provider') || 'all',
      account: params.get('account') || 'all',
      q: params.get('q') || '',
    };
  }
  return { ...DEFAULT_LIST };
}
