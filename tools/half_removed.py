#!/usr/bin/env python3
"""Half-removed trust lines: limit 0, balance 0, still holding the owner's 0.2 XRP reserve.

Reads a finished `ledger_census.py --why` run (all shards) and splits the limit-0 sides by why
the reserve is still held (rippled TrustSet.cpp:504-506):
  - NoRipple set, owner has DefaultRipple    -> needs ClearNoRipple
  - NoRipple not set, owner has no DefaultRipple -> needs SetNoRipple
  - NoRipple already matches                 -> stale flag (any TrustSet recomputes it)
Checks: shards 0..n-1 finished on one ledger + hash; per shard the four reasons add up to the
removable trust-line sides; with --census, that total equals the census run's.
usage: half_removed.py <why_dir> <out_dir> [--census <census_dir>]
"""
import glob, hashlib, json, os, sys

def load(d):
    sh = [json.load(open(f)) for f in sorted(glob.glob(os.path.join(d, 'census_state_*.json')))]
    n = int(sh[0]['shard'].split('/')[1])
    assert sorted(int(s['shard'].split('/')[0]) for s in sh) == list(range(n)), f'{d}: missing shards'
    assert all('result' in s for s in sh), f'{d}: not every shard finished'
    assert len({(s['ledger'], s['ledger_hash']) for s in sh}) == 1, f'{d}: shards disagree on ledger'
    return sh

def main():
    wd, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True)
    sh = load(wd); inc = sh[0]['reserve_inc_drops']
    tot = dict.fromkeys(('line_sides_reclaimable', 'why_limit_set', 'why_own_freeze', 'why_quality', 'why_limit0'), 0)
    for s in sh:
        c = s['c']
        assert c['why_limit_set'] + c['why_own_freeze'] + c['why_quality'] + c['why_limit0'] == c['line_sides_reclaimable'], f"shard {s['shard']}: reasons do not add up"
        assert len(s['limit0']) == c['why_limit0'], f"shard {s['shard']}: limit0 list length"
        for k in tot: tot[k] += c[k]
    if '--census' in sys.argv:
        cen = load(sys.argv[sys.argv.index('--census') + 1])
        assert cen[0]['ledger_hash'] == sh[0]['ledger_hash'], 'census is at a different ledger'
        assert sum(s['c']['line_sides_reclaimable'] for s in cen) == tot['line_sides_reclaimable'], 'trust-line total differs from census'
    dr = set(a for s in sh for a in s['default_ripple'])
    split = {'noripple_set_defaultripple_on': 0, 'noripple_off_no_defaultripple': 0, 'stale_flag': 0}
    owners = {k: set() for k in split}
    for s in sh:
        for owner, nr in s['limit0']:
            has_dr = owner in dr
            k = 'stale_flag' if (not nr) == has_dr else ('noripple_set_defaultripple_on' if nr else 'noripple_off_no_defaultripple')
            split[k] += 1; owners[k].add(owner)
    all_owners = set().union(*owners.values())
    rep = {
        'ledger': {'index': sh[0]['ledger'], 'hash': sh[0]['ledger_hash']},
        'reserve_inc_drops': inc,
        'removable_line_sides': tot['line_sides_reclaimable'],
        'why': {'own_limit_set': tot['why_limit_set'], 'own_freeze': tot['why_own_freeze'], 'quality': tot['why_quality'], 'limit_0': tot['why_limit0']},
        'limit_0_split': split,
        'limit_0_owners': {k: len(v) for k, v in owners.items()} | {'distinct': len(all_owners)},
        'half_removed_drops': tot['why_limit0'] * inc,
        'default_ripple_accounts': len(dr),
        'rule': 'TrustSet.cpp:504-511: a side reserves while limit, balance > 0, freeze, quality, or NoRipple != !DefaultRipple',
    }
    blob = json.dumps(rep, sort_keys=True, separators=(',', ':')).encode()
    open(os.path.join(out, 'half_removed.json'), 'wb').write(blob)
    d = hashlib.sha256(blob).hexdigest()
    open(os.path.join(out, 'half_removed.sha256'), 'w').write(d + '  half_removed.json\n')
    print(d); print(json.dumps(rep, indent=1))

main()
