# Ledger census: method

How the "XRP tied up in removable objects" numbers are made, so anyone can re-run them and check.

## What it measures

At ONE pinned validated ledger, every ledger object is read once (`ledger_data`, unfiltered). An object counts as **removable** when its owner could free its owner reserve with their own transaction today:

| Object | Counts when | Rule source (rippled 3.4) |
|---|---|---|
| Trust line, per side | that side holds the reserve flag, the balance is 0, and that side has not deep-frozen the line | `TrustSet.cpp:504-514` (a side reserves while limit, balance > 0, freeze, quality, or NoRipple != !DefaultRipple) |
| DEX offer | `Expiration <= close_time` of the pinned ledger | `View.cpp` `hasExpired`: `parentCloseTime >= Expiration`, so it is expired for every tx in the next ledger |
| NFT offer | same expiry test | same |
| Check | same expiry test | same |

Each counted unit is worth one owner reserve increment, read from the `FeeSettings` object (`4BC50C9B…A651`) **at the pinned ledger**, not from today's `server_state`.

A trust line is counted **per side**: if both sides hold a reserve at 0 balance, it counts twice. The XRP total is exact (each side's reserve is separate); the "objects" count is slightly higher than the number of distinct objects.

## How it runs

```
# 1. pick a validated ledger L, then walk it in 8 key-space shards (run them in parallel)
python3 tools/ledger_census.py OUT --ledger L --shard 0/8      # ... up to 7/8
#    optional: --tally (per token, per owner), --why (why each trust-line side still reserves)

# 2. merge and check
python3 tools/state_report.py OUT REPORT [--tally OUT]

# 3. optional: split limit-0 sides into NoRipple/DefaultRipple mismatch vs stale flag
python3 tools/half_removed.py OUT HALF --census OUT
```

- Shards split the 256-bit key space into equal ranges `[lo, hi)`. Each starts from the synthetic marker `lo - 1` and stops at `hi`. The server must accept a synthetic marker (xrplcluster.com, xahau.network and xahau.org do; s2.ripple.com, which is Clio, does not).
- Progress is saved with an atomic replace, so a stopped shard resumes where it left off.
- A full XRPL walk is about 20 million objects (8 shards took about 1.5 to 2 hours on 2026-10-21). Agree a rate limit with the server operator first.

## Checks before a report is written (`state_report.py`)

1. All shards present, finished, and on the same ledger index and ledger hash.
2. The ledger hash matches on a second server.
3. Reserves read from `FeeSettings` at the ledger, identical on both servers, and equal to what the census used.
4. One page per shard is read from both servers: same object ids and the same counts. This shows the servers agree; it does **not** re-count the census.
5. With `--tally`: the per-token / per-owner pass must reproduce the census totals exactly, and per-owner counts must add up to the removable total.

The report is canonical JSON (sorted keys, no spaces) plus its sha256, so a re-run from the same shard files gives the same bytes.

## Limits

- An owner must still hold a key. Some accounts are blackholed or are pseudo-accounts (AMM, vaults); they are counted but can never act. In a random sample of 200 counted objects (2026-10-21), 9 belonged to blackholed accounts.
- Some owners keep empty trust lines on purpose (to receive a token later). This is the most that could come back, not money anyone forgot.
- Not counted (so the total is a lower bound for these): live checks and NFT offers, escrows past CancelAfter, expired credentials, tickets, issuer-side lines with a negative balance.
- The per-token tally keys a line by the other side. When the side holding the reserve is the issuer's own, the key names the holder, not the issuer.
- If the Sponsor amendment is ever enabled, a freed reserve on a sponsored object goes to the sponsor.

## Published runs

| Run | Ledger | Result | sha256(report.json) |
|---|---|---|---|
| XRPL census 2026-10-21 | 107804914 (hash 7E11609C…E595) | 544,453.0 XRP in 2,722,265 removable units | `16fb88992f6665e8f79499096378925dfa03065ee5ef70fa4f0362d4ea6ec688` ([report](reports/xrpl-2026-10-21/)) |
| half-removed split (`--why`) | 107804914 | 152,455 limit-0, 0-balance trust-line sides still reserving = 30,491 XRP (126,784 NoRipple set with DefaultRipple on; 21,075 NoRipple off without DefaultRipple; 4,596 stale flag); reasons add up to the census exactly | `bf843d76f75b57cde0f2887f7d6a5030a652369c3d7e65a678a51c531517e3c8` ([half_removed.json](reports/xrpl-2026-10-21/half_removed.json)) |
| same, with tally | totals identical; 661,272 owners | `a5c71f4c13bdae62f93bbf4521e49e8df718e86b39ee4f03a78bfad8c6f71322` (not published: it lists token issuers) |

The 2026-10-21 report was written before the 2026-10-22 wording changes to `report.md` (now "removable reserve units" plus a limits list); `report.json` re-runs byte-identical.

## Related checks (testnet, `test/testnet/`)

- `e2e-noripple.mjs`: limit 0 alone keeps a reserve when NoRipple does not match DefaultRipple; the matching TrustSet frees it.
- `e2e-blackholed-issuer.mjs`: a blackholed issuer with a non-default side keeps the line alive, but the holder's reserve is still freed.
