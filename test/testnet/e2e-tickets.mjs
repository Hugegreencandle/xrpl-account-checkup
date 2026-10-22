// Manual end-to-end test on XRPL TESTNET (no real money): unused tickets.
// Account A: 3 tickets + 1 empty trust line, cleaned up in ONE Batch (ticket inner txs use TicketSequence, Sequence 0).
// Account B: 2 tickets, cleaned up as single transactions (batch: false).
// Pass = every ticket gone and the owner count back to 0 on both. Throwaway keys in memory only.
//   node test/testnet/e2e-tickets.mjs   (needs xrpl.js: npm i --no-save xrpl, or XRPLJS=<path>)
import { createRequire } from 'module';
import { scanAccount } from '../../src/scan.js';
import { buildPlan, toBatches } from '../../src/plan.js';
const require = createRequire(import.meta.url);
const xrpl = require(process.env.XRPLJS || 'xrpl');

const WS = 'wss://s.altnet.rippletest.net:51233';
const SERVERS = ['https://s.altnet.rippletest.net:51234', 'https://testnet.xrpl-labs.com'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = new xrpl.Client(WS);
await client.connect();
const { wallet: a } = await client.fundWallet();
const { wallet: b } = await client.fundWallet();
const { wallet: issuer } = await client.fundWallet();
const send = async (tx, w) => (await client.submitAndWait(tx, { wallet: w, autofill: true })).result.meta.TransactionResult;
console.log('A TicketCreate x3', await send({ TransactionType: 'TicketCreate', Account: a.address, TicketCount: 3 }, a));
console.log('A TrustSet', await send({ TransactionType: 'TrustSet', Account: a.address, LimitAmount: { currency: 'USD', issuer: issuer.address, value: '10' } }, a));
console.log('B TicketCreate x2', await send({ TransactionType: 'TicketCreate', Account: b.address, TicketCount: 2 }, b));
await sleep(4000);

async function clean(w, batch) {
  const before = await scanAccount(w.address, { servers: SERVERS });
  const plan = buildPlan(before);
  const txs = [...plan.cleanup, ...plan.optionalCleanup.filter((t) => t.TicketSequence != null)];
  const out = toBatches(w.address, txs, { sequence: before.accountData.Sequence, baseFeeDrops: Number(before.baseFee || 10), batch });
  console.log(`${w.address} owner count ${before.accountData.OwnerCount}, ${txs.length} actions -> ${out.map((t) => t.TransactionType).join(',')}`);
  for (const t of out) {
    const cur = await client.request({ command: 'ledger_current' });
    const signed = w.sign({ ...t, LastLedgerSequence: cur.result.ledger_current_index + 20 });
    const sub = await client.request({ command: 'submit', tx_blob: signed.tx_blob });
    console.log(`  ${t.TransactionType}${t.TicketSequence ? ' ticket ' + t.TicketSequence : ''}: submit ${sub.result.engine_result}`);
  }
  await sleep(9000);
  const after = await scanAccount(w.address, { servers: SERVERS });
  const tickets = after.objects.filter((o) => o.LedgerEntryType === 'Ticket').length;
  console.log(`  owner count ${before.accountData.OwnerCount} -> ${after.accountData.OwnerCount}, tickets left ${tickets}`);
  return after.accountData.OwnerCount === 0 && tickets === 0;
}
const okA = await clean(a, true);
const okB = await clean(b, false);
console.log(okA && okB ? 'E2E PASS' : 'E2E FAIL', '(A Batch:', okA, '| B singles:', okB, ')');
await client.disconnect();
process.exit(okA && okB ? 0 : 2);
