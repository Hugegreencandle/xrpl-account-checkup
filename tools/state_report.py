#!/usr/bin/env python3
"""State of the XRP Ledger report, built from a finished census (ledger_census.py, all shards).

Checks before it writes anything:
  1. every shard finished, all at the same ledger index and ledger hash, shards 0..n-1 all present
  2. the ledger hash at that index matches on a second server (s2.ripple.com, full history)
  3. reserves are read from the FeeSettings object AT THAT LEDGER (not from today's server_state)
  4. spot check: one ledger_data page per shard is re-read from the second server and re-counted;
     object ids and counts must match the first server's page exactly
Then writes report.json (canonical: sorted keys, no spaces), report.sha256 and report.md.
Signing and anchoring are separate steps that need the publisher's OK.
usage: state_report.py <census_dir> <out_dir> [--tally <tally_dir>]
env: KVT_REPORT_A / KVT_REPORT_B / KVT_NETWORK for another network (e.g. Xahau)
"""
import glob, hashlib, json, os, sys, urllib.request

A = os.environ.get('KVT_REPORT_A', 'https://xrplcluster.com')   # the server the census walked
B = os.environ.get('KVT_REPORT_B', 'https://s2.ripple.com:51234')  # second server (full history)
NET = os.environ.get('KVT_NETWORK', 'XRP Ledger')
FEE_SETTINGS = '4BC50C9B0D8515D3EAAE1E74B29A95804346C491EE1A95BF25E4AAB854A6A651'  # keylet::fees()

def rpc(host, method, params):
    body = json.dumps({'method': method, 'params': [params]}).encode()
    req = urllib.request.Request(host, data=body, headers={'Content-Type': 'application/json', 'User-Agent': 'kvt-state-report/0.1'})
    r = json.load(urllib.request.urlopen(req, timeout=120))['result']
    if r.get('status') == 'error': raise RuntimeError(f"{host} {method}: {r.get('error')} {r.get('error_message', '')}")
    return r

def load(d):
    sh = [json.load(open(f)) for f in sorted(glob.glob(os.path.join(d, 'census_state_*.json')))]
    n = int(sh[0]['shard'].split('/')[1])
    idx = sorted(int(s['shard'].split('/')[0]) for s in sh)
    assert idx == list(range(n)), f'{d}: shards present {idx}, expected 0..{n-1}'
    assert all('result' in s for s in sh), f'{d}: not every shard finished'
    assert len({s['ledger'] for s in sh}) == 1 and len({s['ledger_hash'] for s in sh}) == 1, f'{d}: shards disagree on ledger'
    return sh

def page_counts(state, close_time):
    c = {'objects': 0, 'reclaimable': 0}
    for o in state:
        c['objects'] += 1
        et = o['LedgerEntryType']
        if et == 'RippleState':
            f = o.get('Flags', 0); z = float(o['Balance']['value']) == 0
            for res, deep in ((0x10000, 0x2000000), (0x20000, 0x4000000)):
                if f & res and z and not f & deep: c['reclaimable'] += 1
        elif et in ('Offer', 'NFTokenOffer', 'Check') and o.get('Expiration') is not None and o['Expiration'] <= close_time:
            c['reclaimable'] += 1
    return c

def main():
    cen, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True)
    tal = sys.argv[sys.argv.index('--tally') + 1] if '--tally' in sys.argv else None
    sh = load(cen); L = sh[0]['ledger']; H = sh[0]['ledger_hash']; ct = sh[0]['close_time']
    checks = {}
    hb = rpc(B, 'ledger', {'ledger_index': L})['ledger']['ledger_hash']
    checks['second_server_ledger_hash_match'] = hb == H
    assert hb == H, f'second server hash {hb} != {H}'
    fee = rpc(A, 'ledger_entry', {'index': FEE_SETTINGS, 'ledger_index': L})['node']
    assert fee['LedgerEntryType'] == 'FeeSettings'
    fee_b = rpc(B, 'ledger_entry', {'index': FEE_SETTINGS, 'ledger_index': L})['node']
    assert fee_b == fee, 'the two servers disagree on FeeSettings at this ledger'
    base = int(fee.get('ReserveBaseDrops', fee.get('ReserveBase'))); inc = int(fee.get('ReserveIncrementDrops', fee.get('ReserveIncrement')))
    checks['reserve_from_fee_settings_at_ledger'] = {'base_drops': base, 'inc_drops': inc}
    assert inc == sh[0]['reserve_inc_drops'], 'census used a different owner reserve than the ledger held'
    # spot check: the first page of every shard, read from both servers
    spot = []
    for s in sh:
        i, n = (int(x) for x in s['shard'].split('/')); lo = (i * 2**256) // n
        p = {'ledger_index': L, 'limit': 256}
        if lo: p['marker'] = f'{lo - 1:064X}'
        first = rpc(A, 'ledger_data', p)['state']
        # s2.ripple.com is Clio, which accepts only a marker that is an existing object id
        # (markerDoesNotExist otherwise), so both servers start right after the first real id
        p2 = {'ledger_index': L, 'limit': 256, 'marker': first[0]['index']}
        pa = rpc(A, 'ledger_data', p2)['state']; pb = rpc(B, 'ledger_data', p2)['state']
        ia = [o['index'] for o in pa]; ib = [o['index'] for o in pb]
        k = min(len(ia), len(ib))  # servers may return different page sizes; compare the common prefix
        assert k > 0, f'spot check shard {i}: a server returned an empty page'
        same = ia[:k] == ib[:k] and page_counts(pa[:k], ct) == page_counts(pb[:k], ct)
        spot.append({'shard': i, 'objects_compared': k, 'match': same})
    checks['spot_check_pages'] = spot
    assert all(x['match'] for x in spot), 'spot check mismatch'

    tot = {}
    for s in sh:
        for k2, v in s['c'].items():
            if isinstance(v, int): tot[k2] = tot.get(k2, 0) + v
    removable = tot['line_sides_reclaimable'] + tot['offers_expired'] + tot['nft_offers_expired'] + tot['checks_expired']
    rep = {
        'title': 'State of the XRP Ledger: XRP held in removable objects',
        'publisher': 'Kairo Vault Technologies G.K.',
        'ledger': {'index': L, 'hash': H, 'close_time_ripple_epoch': ct},
        'reserves_drops': {'base': base, 'owner_increment': inc},
        'method': {
            'tool': 'xrpl-account-checkup/tools/ledger_census.py (8 key-space shards, one pinned ledger)',
            'removable_rules': [
                'trust line side holding the reserve flag, holding 0 of the token, not deep-frozen (rippled TrustSet.cpp:501-514)',
                'DEX offer, NFT offer or check whose Expiration <= ledger close time',
            ],
            'note': 'Most object ids are uniform hashes, but NFTokenPage ids begin with the owner account id, so large NFT collections cluster; shard sizes differ, counts do not.',
            'not_counted': ['live offers', 'trust lines holding a balance', 'tickets, escrows, channels, NFT pages, signer lists, AMM positions'],
        },
        'counts': tot,
        'removable': {
            'objects': removable,
            'drops': removable * inc,
            'by_kind': {'trust_line_sides': tot['line_sides_reclaimable'], 'expired_offers': tot['offers_expired'],
                        'expired_nft_offers': tot['nft_offers_expired'], 'expired_checks': tot['checks_expired']},
            'share_of_all_objects': round(removable / tot['objects'], 6),
        },
        'checks': checks,
        'limits': ['An owner must hold the key to remove an object; some accounts are lost or abandoned.',
                   'Some owners keep empty trust lines on purpose. This is the most that could come back, not money anyone forgot.'],
    }
    if NET != 'XRP Ledger':  # other networks only, so XRPL reports re-run byte-identical
        rep['title'] = f'State of {NET}: native reserve held in removable objects'
        rep['network'] = NET; rep['servers'] = [A, B]
    if tal:
        ts = load(tal)
        assert ts[0]['ledger'] == L and ts[0]['ledger_hash'] == H, 'tally pass is at a different ledger'
        bt, bo, tt = {}, {}, {}
        for s in ts:
            for k2, v in s['by_token'].items(): bt[k2] = bt.get(k2, 0) + v
            for k2, v in s['by_owner'].items(): bo[k2] = bo.get(k2, 0) + v
            for k2, v in s['c'].items():
                if isinstance(v, int): tt[k2] = tt.get(k2, 0) + v
            for k2, v in s['c'].get('objects_by_type', {}).items(): tt.setdefault('objects_by_type', {}); tt['objects_by_type'][k2] = tt['objects_by_type'].get(k2, 0) + v
        tr = tt['line_sides_reclaimable'] + tt['offers_expired'] + tt['nft_offers_expired'] + tt['checks_expired']
        assert tr == removable and tt['objects'] == tot['objects'], f'tally pass totals differ from census ({tr} vs {removable})'
        assert sum(bo.values()) == removable, 'per-owner counts do not add up to the removable total'
        top_tokens = sorted(bt.items(), key=lambda kv: -kv[1])[:25]
        owners_sorted = sorted(bo.values(), reverse=True)
        rep['tally'] = {
            'objects_by_type': tt['objects_by_type'],
            'owner_count_sum': tt['owner_count_sum'], 'accounts': tt['accounts'], 'accounts_with_objects': tt['accounts_with_objects'],
            'all_owner_reserve_drops': tt['owner_count_sum'] * inc, 'all_base_reserve_drops': tt['accounts'] * base,
            'top_tokens_by_empty_lines': [{'currency_issuer': k2, 'empty_line_sides': v, 'drops': v * inc} for k2, v in top_tokens],
            'distinct_tokens_with_empty_lines': len(bt),
            'owners_with_removable': len(bo),
            'largest_single_owner': {'objects': owners_sorted[0], 'drops': owners_sorted[0] * inc},  # account deliberately not named
        }
    blob = json.dumps(rep, sort_keys=True, separators=(',', ':')).encode()
    open(os.path.join(out, 'report.json'), 'wb').write(blob)
    digest = hashlib.sha256(blob).hexdigest()
    open(os.path.join(out, 'report.sha256'), 'w').write(digest + '  report.json\n')
    x = lambda d: f'{d / 1e6:,.1f}'
    md = [f"# {rep['title']}", '', f"Ledger {L} · hash `{H}`", '',
          f"**{x(rep['removable']['drops'])}** of owner reserve sits in {removable:,} removable reserve units "
          f"(trust-line sides plus expired offers, NFT offers and checks; one line can count twice, once per side), "
          f"{rep['removable']['share_of_all_objects']:.1%} of the {tot['objects']:,} ledger objects.", '',
          '| Kind | Objects | XRP |', '|---|---:|---:|']
    for k2, v in rep['removable']['by_kind'].items(): md.append(f'| {k2} | {v:,} | {x(v * inc)} |')
    md += ['', f"Checks: second-server hash match = {checks['second_server_ledger_hash_match']}; reserves from FeeSettings at the ledger "
           f"(base {base} drops, owner {inc} drops); spot-check pages matched {sum(s2['match'] for s2 in spot)}/{len(spot)}.", '',
           'This spot check shows the two servers agree on the ledger data. It does not re-count the census.', '',
           'Limits:'] + [f'- {l}' for l in rep['limits']] + ['', f"sha256(report.json) = `{digest}`"]
    open(os.path.join(out, 'report.md'), 'w').write('\n'.join(md) + '\n')
    print(digest); print('\n'.join(md))

main()
