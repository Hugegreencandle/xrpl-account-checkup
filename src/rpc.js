// Read-only requests to public XRPL servers. Never sends keys, never submits.
// Node uses JSON-RPC over HTTPS. Browsers use WebSocket, because the public JSON-RPC ports
// refuse cross-origin requests (s2.ripple.com:51234 has no CORS headers, measured 2026-10-21).

export const DEFAULT_SERVERS = ['https://xrplcluster.com', 'https://s2.ripple.com:51234'];
const IN_BROWSER = typeof window !== 'undefined';
const WS_URL = { 'https://xrplcluster.com': 'wss://xrplcluster.com', 'https://s2.ripple.com:51234': 'wss://s2.ripple.com', 'https://s1.ripple.com:51234': 'wss://s1.ripple.com' };

function fail(server, method, r) {
  const e = new Error(`${server} ${method}: ${r.error}${r.error_message ? ' - ' + r.error_message : ''}`);
  e.code = r.error;
  return e;
}

async function httpRpc(server, method, params, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'xrpl-account-checkup/0.1' },
      body: JSON.stringify({ method, params: [params] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${server} ${method}: HTTP ${res.status}`);
    const r = (await res.json()).result;
    if (!r) throw new Error(`${server} ${method}: no result`);
    if (r.status === 'error') throw fail(server, method, r);
    return r;
  } finally {
    clearTimeout(t);
  }
}

const sockets = new Map();
function socket(url) {
  if (sockets.has(url)) return sockets.get(url);
  const p = new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    ws.onopen = () => resolve({
      send(cmd, params) {
        const id = nextId++;
        return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, command: cmd, ...params })); });
      },
    });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const h = pending.get(m.id);
      if (!h) return;
      pending.delete(m.id);
      h.res(m);
    };
    ws.onerror = () => { sockets.delete(url); reject(new Error(`cannot connect to ${url}`)); };
    ws.onclose = () => { sockets.delete(url); for (const h of pending.values()) h.rej(new Error(`${url} closed`)); };
  });
  sockets.set(url, p);
  return p;
}

async function wsRpc(server, method, params, timeoutMs) {
  const url = WS_URL[server] || server.replace(/^https:/, 'wss:');
  const s = await socket(url);
  const m = await Promise.race([s.send(method, params), new Promise((_, rej) => setTimeout(() => rej(new Error(`${url} ${method}: timeout`)), timeoutMs))]);
  if (m.status === 'error' || m.error) throw fail(server, method, { error: m.error, error_message: m.error_message });
  return m.result;
}

export async function rpc(server, method, params = {}, { timeoutMs = 30000 } = {}) {
  return IN_BROWSER ? wsRpc(server, method, params, timeoutMs) : httpRpc(server, method, params, timeoutMs);
}

// Follow `marker` pagination for list methods (account_objects etc.).
export async function rpcAll(server, method, params, listKey) {
  const out = [];
  let marker;
  for (let page = 0; page < 200; page++) {
    const r = await rpc(server, method, marker ? { ...params, marker } : params);
    out.push(...(r[listKey] || []));
    marker = r.marker;
    if (!marker) return out;
  }
  throw new Error(`${method}: more than 200 pages`);
}
