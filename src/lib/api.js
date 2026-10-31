// Thin JSON-RPC style client for one Claude Multiplayer server. Everything returned is untrusted data.
export class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code || 'ERROR';
    this.status = status || 0;
  }
}

export function normalizeServerUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  return /\.php$/i.test(url) ? url : `${url}/api.php`;
}

export function createApi(url, getToken) {
  return async function call(action, payload = {}, { timeout = 15000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const token = getToken ? await getToken() : null;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Deck-Token': token } : {}) },
        body: JSON.stringify({ action, ...payload }),
        signal: ctrl.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (err) {
      throw new ApiError(err?.name === 'AbortError' ? 'Server timed out' : 'Server unreachable', 'NETWORK', 0);
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      throw new ApiError(`Unexpected response (HTTP ${res.status})`, 'BAD_RESPONSE', res.status);
    }
    if (!res.ok || !data || data.ok === false) {
      throw new ApiError(String(data?.error || `HTTP ${res.status}`), data?.error_code, res.status);
    }
    return data;
  };
}
