// Scan one account at one validated ledger on two independent servers.
// The plan is built only from data both servers agree on.

import { rpc, rpcAll, DEFAULT_SERVERS } from './rpc.js';

async function readOne(server, account, ledgerIndex) {
  const info = await rpc(server, 'account_info', { account, ledger_index: ledgerIndex, signer_lists: true });
  const objects = await rpcAll(server, 'account_objects', { account, ledger_index: ledgerIndex, limit: 400 }, 'account_objects');
  const state = await rpc(server, 'server_state', {});
  const vl = state.state.validated_ledger || {};
  return {
    accountData: info.account_data,
    signerLists: info.signer_lists || info.account_data.signer_lists || [],
    objects,
    reserveBase: vl.reserve_base,
    reserveInc: vl.reserve_inc,
    baseFee: vl.base_fee,
  };
}

// Stable string of what the plan uses, so two servers can be compared exactly: the account root
// fields, every object in full (keys sorted, by index), and the signer lists.
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
function canon(r) {
  const objs = [...r.objects].sort((a, b) => (a.index < b.index ? -1 : 1));
  const a = r.accountData;
  return JSON.stringify(sortKeys({ seq: a.Sequence, bal: a.Balance, flags: a.Flags, oc: a.OwnerCount, rk: a.RegularKey ?? null, objs, sl: r.signerLists }));
}

export async function scanAccount(account, { servers = DEFAULT_SERVERS } = {}) {
  const v = await rpc(servers[0], 'ledger', { ledger_index: 'validated' });
  const ledgerIndex = Number(v.ledger_index ?? v.ledger.ledger_index);
  const closeTime = v.ledger?.close_time; // ripple-epoch seconds, for offer Expiration
  const reads = await Promise.all(servers.map((s) => readOne(s, account, ledgerIndex)));
  const agree = reads.every((r) => canon(r) === canon(reads[0]));
  return { account, ledgerIndex, closeTime, servers, agree, ...reads[0] };
}
