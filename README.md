# xrpl-account-checkup

Find the XRP locked in removable objects on an XRP Ledger account, see who can act for it, and get the **unsigned** transactions to clean it up in one Batch.

- **Read-only and keyless.** It reads two public servers at one validated ledger and builds unsigned transactions. It never asks for a key, never signs, never submits.
- **Two servers.** The plan is built only when both servers agree on the account at that ledger: account root fields, every object in full, and signer lists. Otherwise `buildPlan` throws and the CLI exits 2 with no transactions.
- **Never type your secret or seed anywhere for this.** This tool never asks for one; anything that does is not this tool.
- **No dependencies.** Plain Node 20+ (`fetch`), so the same code can run in a web page or an xApp.

Prototype (0.1.0, 2026-10-21). Kairo Vault Technologies G.K.

## Use

```
node bin/checkup.js <rAccount>             # plain-words report
node bin/checkup.js <rAccount> --json      # plan + unsigned transactions
node bin/checkup.js <rAccount> --simulate  # also dry-run each cleanup action (rippled `simulate`)
npm test                                   # unit tests
node test/testnet/e2e-batch.mjs            # TESTNET end-to-end with throwaway accounts (npm i --no-save xrpl, or XRPLJS=<path>)
node bin/checkup.js <rAccount> --json --no-batch  # one plain transaction per action (wallets without Batch signing)
```

## Ledger census

`tools/` holds the ledger-wide census (how much XRP sits in removable objects across the whole ledger). How it works, its checks and limits, and published runs: [METHOD.md](METHOD.md).

## Web page

`web/index.html` + `web/app.js` (same `src/` code, no build step). Serve the repo root over HTTP and open `/web/index.html`. In the browser it reads over WebSocket, because the public JSON-RPC ports refuse cross-origin requests (s2.ripple.com:51234 sends no CORS headers, measured 2026-10-21). Real junk is pre-ticked; open orders and delegates are optional; tickets and other kept objects are folded into one line per type. Tested headless at 390 px and 1100 px: no console errors, no sideways scroll.

## Use as a library (for wallets)

Any wallet can add the checkup. The library only reads and builds unsigned transactions; the wallet shows them and signs them in its own flow.

```js
import { scanAccount, buildPlan, toBatches, giftTx } from 'xrpl-account-checkup';

const scan = await scanAccount('r...');            // two servers, one validated ledger
if (!scan.agree) throw new Error('servers disagree, try again');
const plan = buildPlan(scan);                       // items, risks (who can sign), cleanup, reclaimXrp
const txs = toBatches(scan.account, plan.cleanup, {
  sequence: scan.accountData.Sequence,
  baseFeeDrops: Number(scan.baseFee || 10),
  // optional "clean up and give": a Payment in a final all-or-nothing Batch
  // gift: giftTx(scan.account, { destination: 'r...', drops: 600000 }),
});
// hand `txs` to the wallet to sign, in order
```

With `gift`, the Payment goes last in a `tfAllOrNothing` Batch (`TxFlags.h:202`) with up to 7 cleanup actions, so it is not sent if those fail. Testnet end-to-end 2026-10-21: 3 objects removed and 600000 drops received in one validated Batch (`test/testnet/e2e-gift.mjs`).

## What it cleans up

| Object | Cleanup | Default? |
|---|---|---|
| Trust line you reserve, holding 0 | `TrustSet` limit 0, NoRipple matched to your DefaultRipple, clear your freeze | yes (if you set a limit, you can no longer receive that token until you add the line again; the item says so) |
| Expired DEX offer | `OfferCancel` | yes |
| Expired NFT offers you made | `NFTokenCancelOffer` (up to 500 per tx) | yes |
| Live NFT offers you made | `NFTokenCancelOffer` | optional: it is your sale or bid |
| Expired checks you created | `CheckCancel` | yes |
| Live checks you created | `CheckCancel` | optional: it withdraws a payment you promised |
| Open (live) DEX offer | `OfferCancel` | optional: it is your trade |
| Delegate you granted | `DelegateSet` with empty `Permissions` (deletes it) | optional |
| Unused ticket | no-op `AccountSet` that uses it (`TicketSequence`, `Sequence` 0); works inside a Batch | optional: skip if a transaction you pre-signed uses that ticket |
| Escrows, channels, NFT pages, signer list, other | reported only | — |

Each removed object returns the owner reserve (0.2 XRP, read from `server_state` at scan time).

## Rules (from rippled source, 3.4 line)

- Trust line: your side stops reserving when your limit is 0, you hold nothing, no quality, not frozen, and NoRipple equals NOT DefaultRipple (`TrustSet.cpp:501-514`). Deep-frozen lines are left for manual handling.
- Ticket: using a ticket deletes it and lowers the owner count by one (`Transactor.cpp` `ticketDelete`, `decreaseOwnerCountForObject`, rippled develop 2026-10-22). A Batch inner tx has exactly one of Sequence / TicketSequence (`Batch.cpp` preflight).
- Batch: 2–8 inner transactions (`Protocol.h:454`), exactly one mode flag (we use `tfIndependent`), inner txs carry `tfInnerBatchTxn` (`0x40000000`), fee 0, empty `SigningPubKey`, consecutive `Sequence` after the outer (`Batch.cpp` preflight); outer fee = base + outer base + each inner base (`Batch.cpp` calculateBaseFeeImpl).
- NFT offer cancel: up to 500 ids (`Protocol.h:79`). Delegate: empty `Permissions` deletes the entry (`DelegateSet.cpp:86-89`).
- `simulate` rejects Batch (`Simulate.cpp:361`), so `--simulate` dry-runs each action on its own.

## Limits

- Multi-signed accounts: the outer Batch fee assumes one signature (`Batch.cpp` uses the transactor base fee, which grows with signers). A multi-signed submit will be rejected for fee, not misapplied.
- Sponsored reserves (Sponsor amendment, not enabled on mainnet on 2026-10-22): a freed reserve on a sponsored line goes back to the sponsor, not to you. Neither the planner nor the census reads the sponsor fields.
- Census (`tools/ledger_census.py`): counts trust-line SIDES, so one line can count twice (once per side); the XRP total is still right, the "objects" count is slightly high. It counts sides owned by accounts that cannot sign (blackholed, pseudo-accounts). It does not count live checks or NFT offers, escrows past CancelAfter, expired credentials, tickets, or issuer-side lines with a negative balance: for those it is a lower bound. The per-token tally keys a line by the other side, which is the holder (not the issuer) when the issuer's side holds the reserve.
- `tools/state_report.py` spot check: shows two servers agree on one page per shard. It does not re-count the census.

## Evidence

- Unit tests: 22/22 (`npm test`).
- Testnet end-to-end 2026-10-21: 2 trust lines + 1 expired offer created on a throwaway account; checkup found all 3 (servers agree); one signed Batch `tesSUCCESS` (validated); owner count 3 → 0, 0.6 XRP reserve freed.
- Testnet 2026-10-22 (`test/testnet/e2e-tickets.mjs`): unused tickets. Account A (3 tickets + 1 empty line) cleaned in one Batch whose ticket inner txs use TicketSequence with Sequence 0: owner count 4 → 0. Account B (2 tickets) cleaned as single transactions: 2 → 0.
- Testnet 2026-10-22 (`test/testnet/e2e-singles.mjs`): the no-Batch path (`--no-batch` / `batch: false`): OfferCancel + 2 TrustSet signed one by one in Sequence order, all applied; owner count 3 → 0, 0.6 XRP freed.
- Testnet 2026-10-22 (`test/testnet/e2e-noripple.mjs`): a limit-0, 0-balance line whose NoRipple does not match DefaultRipple keeps its reserve (OwnerCount stays 1); the TrustSet this tool builds (matching NoRipple) frees it (OwnerCount 0).
- Testnet 2026-10-22 (`test/testnet/e2e-blackholed-issuer.mjs`): issuer side not default (issuer set a limit) and issuer blackholed; the holder's TrustSet still frees the holder's reserve (OwnerCount 1 -> 0) while the line stays (issuer OwnerCount unchanged).
- Mainnet read-only: KVT attester `rBJW51…X4L` (0 objects, master key only); sample active accounts: per-action `simulate` → `tesSUCCESS`.

## Not done yet

- xApp packaging and hosting (the web page works locally).
- Xaman signing of Batch: WietseWind/Xaman-App PR #291 ("Batch signing for BatchV1_1 and the Batch Account signature") was still open on 2026-10-22. Its description says a Batch Account that owns 2 or more inner transactions was mishandled, which is this tool's cleanup shape, so test in Xaman after it ships.
- Unfunded-offer detection, AMM LP positions.
