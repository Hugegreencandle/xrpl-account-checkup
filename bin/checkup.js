#!/usr/bin/env node
// xrpl-checkup <rAccount> [--json] [--simulate]
// Read-only. Builds UNSIGNED transactions; never asks for a key, never submits.

import { scanAccount } from '../src/scan.js';
import { buildPlan, toBatches } from '../src/plan.js';
import { rpc } from '../src/rpc.js';

const KIND = { trustline: 'Trust line', dex_offer: 'DEX offer', nft_offers: 'NFT offers', check: 'Check', delegate: 'Delegate', ticket: 'Ticket' };
const fmt = (x) => (Math.round(x * 1e6) / 1e6).toString();

async function main() {
  const [account, ...flags] = process.argv.slice(2);
  if (!account || !/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(account)) {
    console.error('usage: xrpl-checkup <rAccount> [--json] [--simulate]');
    process.exit(1);
  }
  const scan = await scanAccount(account);
  if (!scan.agree) {
    console.error(`The two servers disagree on ${account} at ledger ${scan.ledgerIndex}. No plan built. Try again in a few seconds.`);
    process.exit(2);
  }
  const plan = buildPlan(scan);
  const txs = toBatches(account, plan.cleanup, { sequence: scan.accountData.Sequence, baseFeeDrops: Number(scan.baseFee || 10) });

  // Dry run. rippled's simulate rejects Batch (Simulate.cpp:361), so each cleanup action is
  // simulated on its own with server autofill. This checks every action; it does not prove the
  // Batch wrapper (see test/testnet for that).
  const SIM_SERVER = 'https://s1.ripple.com:51234'; // xrplcluster returns notImpl for simulate
  let sims = [];
  if (flags.includes('--simulate')) {
    for (const tx of plan.cleanup) {
      try {
        const r = await rpc(SIM_SERVER, 'simulate', { tx_json: tx });
        sims.push({ type: tx.TransactionType, result: r.engine_result });
      } catch (e) { sims.push({ type: tx.TransactionType, error: e.message }); }
    }
  }

  if (flags.includes('--json')) {
    console.log(JSON.stringify({ account, ledger: scan.ledgerIndex, serversAgree: scan.agree, plan, unsigned: txs, simulate: sims }, null, 2));
    return;
  }

  console.log(`Account checkup for ${account}`);
  console.log(`Ledger ${scan.ledgerIndex} · read from ${scan.servers.length} servers · both agree`);
  console.log(`Balance ${fmt(Number(scan.accountData.Balance) / 1e6)} XRP · owns ${scan.accountData.OwnerCount} objects\n`);
  console.log(`XRP you can get back: ${fmt(plan.reclaimXrp)} XRP${plan.optionalXrp ? ` (+ ${fmt(plan.optionalXrp)} XRP more if you also cancel live offers/checks or revoke delegates)` : ''}`);
  for (const it of plan.items) {
    const label = KIND[it.kind] || it.kind;
    const what = it.kind === 'trustline' ? `${it.currency} from ${it.peer}` : it.kind === 'nft_offers' ? `${it.count} offer(s)` : (it.id || '').slice(0, 12) + '…';
    console.log(`  ${it.reclaimable ? (it.optional ? '○' : '✓') : '·'} ${label}: ${what}${it.why ? ` (${it.why})` : ''}`);
  }
  console.log('\nWho can act for this account:');
  for (const r of plan.risks) {
    if (r.kind === 'master_key') console.log('  - Master key (can sign alone)');
    if (r.kind === 'regular_key') console.log(`  - Regular key ${r.who} (can sign alone)`);
    if (r.kind === 'signer_list') console.log(`  - Signer list, quorum ${r.quorum}: ${r.signers.map((s) => `${s.account} (w${s.weight})`).join(', ')}`);
    if (r.kind === 'delegate') console.log(`  - Delegate ${r.who}, permissions ${r.permissions.join(', ')}`);
  }
  console.log(`\nCleanup: ${txs.length} unsigned transaction(s) (${txs.filter((t) => t.TransactionType === 'Batch').length} Batch). Run with --json to get them.`);
  if (sims.length) for (const s of sims) console.log(`  simulate ${s.type}: ${s.result || s.error}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
