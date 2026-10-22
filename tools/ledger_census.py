#!/usr/bin/env python3
"""Ledger-wide census: how much XRP reserve sits in objects their owners could remove today.

Reads the whole XRPL state at ONE pinned validated ledger with `ledger_data` (type-filtered),
over IPv6 when the host has an IPv6 address (some operators grant a higher rate limit per IPv6 /64).
A full walk is about 20 million objects: check your rate limit with the operator before running it.
Needs a server that accepts a synthetic marker: xrplcluster.com, xahau.network and xahau.org do;
s2.ripple.com (Clio) does not (markerDoesNotExist). Measured 2026-10-21/22.
Counts, per the rules the checkup uses (rippled TrustSet.cpp:501-514 etc.):
  - trust lines: each side that holds the reserve flag AND holds 0 of the token, not deep-frozen
  - DEX offers, NFT offers, checks: only EXPIRED ones (Expiration <= ledger close_time)
Read-only. Resumable: progress is saved after every page to the state file.
usage: ledger_census.py <out_dir> [--ledger N] [--shard i/n] [--tally] [--why] [--max-pages N]
--tally also counts removable objects per token (currency.issuer, for trust lines) and per owner account.
--why counts WHY each removable trust-line side still holds its reserve (TrustSet.cpp:504-511):
  own limit set / own freeze / quality / none of those ("limit 0" lines). For the limit-0 lines it
  keeps [owner, NoRipple set] and the list of DefaultRipple accounts, so half_removed.py can split
  them into NoRipple-vs-DefaultRipple mismatch and stale flags after the walk.
--max-pages stops early (smoke tests only; the shard is then NOT finished).
KVT_CENSUS_HOST overrides the server (default xrplcluster.com).
Shards split the 256-bit key space into n equal ranges (keys are uniform hashes); run n workers
with the same --ledger, then merge their census_state_i.json.
"""
import json, os, socket, sys, time, urllib.request

HOST = os.environ.get('KVT_CENSUS_HOST', 'https://xrplcluster.com')
LSF = dict(LowReserve=0x00010000, HighReserve=0x00020000, LowDeepFreeze=0x02000000, HighDeepFreeze=0x04000000,
           LowNoRipple=0x00100000, HighNoRipple=0x00200000, LowFreeze=0x00400000, HighFreeze=0x00800000)
LSF_DEFAULT_RIPPLE = 0x00800000  # AccountRoot
QUALITY_ONE = 1000000000  # TrustSet treats quality 1e9 as 0
TYPES = [None]  # one unfiltered pass: a type filter makes the server walk the whole ledger per type

_orig = socket.getaddrinfo
def _v6_only(host, *a, **k):
    return [r for r in _orig(host, *a, **k) if r[0] == socket.AF_INET6] or _orig(host, *a, **k)
socket.getaddrinfo = _v6_only

def rpc(method, params, tries=6):
    body = json.dumps({'method': method, 'params': [params]}).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(HOST, data=body, headers={'Content-Type': 'application/json', 'User-Agent': 'kvt-ledger-census/0.1'})
            r = json.load(urllib.request.urlopen(req, timeout=120))['result']
            if r.get('status') == 'error':
                if r.get('error') in ('slowDown', 'tooBusy', 'noNetwork'): raise RuntimeError(r['error'])
                raise ValueError(f"{method}: {r.get('error')} {r.get('error_message','')}")
            return r
        except ValueError:
            raise
        except Exception as e:
            time.sleep(min(60, 2 ** i))
    raise RuntimeError(f'{method}: gave up after {tries} tries')

def main():
    out = sys.argv[1]; os.makedirs(out, exist_ok=True)
    shard = sys.argv[sys.argv.index('--shard') + 1] if '--shard' in sys.argv else '0/1'
    si, sn = (int(x) for x in shard.split('/'))
    lo = (si * 2**256) // sn; hi = ((si + 1) * 2**256) // sn
    sf = os.path.join(out, f'census_state_{si}.json')
    if os.path.exists(sf):
        st = json.load(open(sf))
    else:
        if '--ledger' in sys.argv:
            L = int(sys.argv[sys.argv.index('--ledger') + 1])
        else:
            L = int(rpc('ledger', {'ledger_index': 'validated'})['ledger_index'])
        hdr = rpc('ledger', {'ledger_index': L})['ledger']
        # reserves AT the pinned ledger (FeeSettings object), not today's server_state
        fee = rpc('ledger_entry', {'index': '4BC50C9B0D8515D3EAAE1E74B29A95804346C491EE1A95BF25E4AAB854A6A651', 'ledger_index': L})['node']
        st = {'ledger': L, 'close_time': hdr['close_time'], 'ledger_hash': hdr['ledger_hash'],
              'reserve_inc_drops': int(fee.get('ReserveIncrementDrops', fee.get('ReserveIncrement'))),  # pre-XRPFees ledgers use the old field names
              'reserve_base_drops': int(fee.get('ReserveBaseDrops', fee.get('ReserveBase'))),
              'type_i': 0, 'marker': (f'{lo - 1:064X}' if lo else None), 'shard': shard, 'pages': 0, 'started': time.time(),
              'c': {'lines': 0, 'line_sides_reserved': 0, 'line_sides_reclaimable': 0, 'lines_zero_balance': 0,
                    'offers': 0, 'offers_expired': 0, 'nft_offers': 0, 'nft_offers_expired': 0, 'checks': 0, 'checks_expired': 0}}
    c = st['c']; ct = st['close_time']
    tally = '--tally' in sys.argv
    if tally:
        st.setdefault('by_token', {}); st.setdefault('by_owner', {})
    bt, bo = st.get('by_token'), st.get('by_owner')
    why = '--why' in sys.argv
    if why:
        st.setdefault('limit0', []); st.setdefault('default_ripple', [])
        for k in ('why_limit_set', 'why_own_freeze', 'why_quality', 'why_limit0'): c.setdefault(k, 0)
    max_pages = int(sys.argv[sys.argv.index('--max-pages') + 1]) if '--max-pages' in sys.argv else None
    def owner(a):
        if tally: bo[a] = bo.get(a, 0) + 1
    while st['type_i'] < len(TYPES):
        t = TYPES[st['type_i']]
        p = {'ledger_index': st['ledger'], 'limit': 2048}
        if t: p['type'] = t
        if st['marker']: p['marker'] = st['marker']
        r = rpc('ledger_data', p)
        for o in r.get('state', []):
            if int(o['index'], 16) >= hi: continue  # belongs to the next shard
            et = o.get('LedgerEntryType')
            c['objects'] = c.get('objects', 0) + 1
            if et == 'AccountRoot':
                c['accounts'] = c.get('accounts', 0) + 1
                if why and o.get('Flags', 0) & LSF_DEFAULT_RIPPLE: st['default_ripple'].append(o['Account'])
                if tally:  # all owner reserve on the ledger, for "what would a reserve change free"
                    oc = o.get('OwnerCount', 0)
                    c['owner_count_sum'] = c.get('owner_count_sum', 0) + oc
                    if oc: c['accounts_with_objects'] = c.get('accounts_with_objects', 0) + 1
            if tally: ct_by = c.setdefault('objects_by_type', {}); ct_by[et] = ct_by.get(et, 0) + 1
            if et == 'RippleState':
                c['lines'] += 1
                f = o.get('Flags', 0); bal = float(o['Balance']['value'])
                if bal == 0: c['lines_zero_balance'] += 1
                for side, res, deep in (('low', LSF['LowReserve'], LSF['LowDeepFreeze']), ('high', LSF['HighReserve'], LSF['HighDeepFreeze'])):
                    if f & res:
                        c['line_sides_reserved'] += 1
                        if bal == 0 and not (f & deep):
                            c['line_sides_reclaimable'] += 1
                            if why:  # first reason that applies, in this order
                                L_ = 'LowLimit' if side == 'low' else 'HighLimit'
                                q = [o.get(('Low' if side == 'low' else 'High') + k, 0) for k in ('QualityIn', 'QualityOut')]
                                if float(o[L_]['value']) != 0: c['why_limit_set'] += 1
                                elif f & LSF['LowFreeze' if side == 'low' else 'HighFreeze']: c['why_own_freeze'] += 1
                                elif any(x not in (0, QUALITY_ONE) for x in q): c['why_quality'] += 1
                                else:
                                    c['why_limit0'] += 1
                                    st['limit0'].append([o[L_]['issuer'], bool(f & LSF['LowNoRipple' if side == 'low' else 'HighNoRipple'])])
                            if tally:
                                me, peer = (o['LowLimit']['issuer'], o['HighLimit']['issuer']) if side == 'low' else (o['HighLimit']['issuer'], o['LowLimit']['issuer'])
                                k = o['Balance']['currency'] + '.' + peer  # the peer is the token's issuer for the side that holds 0
                                bt[k] = bt.get(k, 0) + 1; owner(me)
            elif et == 'Offer':
                c['offers'] += 1
                if o.get('Expiration') is not None and o['Expiration'] <= ct: c['offers_expired'] += 1; owner(o['Account'])
            elif et == 'NFTokenOffer':
                c['nft_offers'] += 1
                if o.get('Expiration') is not None and o['Expiration'] <= ct: c['nft_offers_expired'] += 1; owner(o['Owner'])
            elif et == 'Check':
                c['checks'] += 1
                if o.get('Expiration') is not None and o['Expiration'] <= ct: c['checks_expired'] += 1; owner(o['Account'])
        st['pages'] += 1
        st['marker'] = r.get('marker')
        if st['marker'] and int(st['marker'], 16) >= hi: st['marker'] = None  # reached the next shard
        if not st['marker']:
            st['type_i'] += 1; st['marker'] = None
        stop = max_pages is not None and st['pages'] >= max_pages
        if st['pages'] % (100 if tally or why else 20) == 0 or not st['marker'] or stop:  # tally/why state is large: save less often
            json.dump(st, open(sf + '.tmp', 'w')); os.replace(sf + '.tmp', sf)
            print(f"{time.strftime('%H:%M:%S')} type={t} pages={st['pages']} {json.dumps(c)}", flush=True)
        if stop:
            print('STOPPED at --max-pages (shard not finished)'); return
    inc = st['reserve_inc_drops'] / 1e6
    removable = c['line_sides_reclaimable'] + c['offers_expired'] + c['nft_offers_expired'] + c['checks_expired']
    st['result'] = {'removable_objects': removable, 'xrp_locked_removable': removable * inc, 'finished': time.time()}
    json.dump(st, open(sf, 'w'), indent=1)
    print('DONE', json.dumps(st['result']), json.dumps(c))

main()
