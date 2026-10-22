// Manual end-to-end test on XRPL TESTNET (no real money) for the NO-BATCH path (batch: false):
// same junk as e2e-batch.mjs, but the cleanup is signed and submitted as one plain transaction per
// action, in Sequence order, as a wallet without Batch support would. Throwaway key in memory only.
//   node test/testnet/e2e-singles.mjs   (needs xrpl.js: npm i --no-save xrpl, or set XRPLJS to its path)
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
const { wallet: user } = await client.fundWallet();
const { wallet: issuer } = await client.fundWallet();
console.log('user', user.address, 'issuer', issuer.address);

async function send(tx, w) {
  const r = await client.submitAndWait(tx, { wallet: w, autofill: true });
  return r.result.meta.TransactionResult;
}
console.log('TrustSet USD', await send({ TransactionType: 'TrustSet', Account: user.address, LimitAmount: { currency: 'USD', issuer: issuer.address, value: '1000' } }, user));
console.log('TrustSet EUR', await send({ TransactionType: 'TrustSet', Account: user.address, LimitAmount: { currency: 'EUR', issuer: issuer.address, value: '1000' } }, user));
const li = await client.request({ command: 'ledger', ledger_index: 'validated' });
const exp = li.result.ledger.close_time + 40;
console.log('OfferCreate (expires in ~40 s)', await send({ TransactionType: 'OfferCreate', Account: user.address, TakerGets: '1000000', TakerPays: { currency: 'USD', issuer: issuer.address, value: '1' }, Expiration: exp }, user));
await sleep(50000);

const before = await scanAccount(user.address, { servers: SERVERS });
const plan = buildPlan(before);
console.log('checkup: servers agree', before.agree, '| owner count', before.accountData.OwnerCount, '| reclaim', plan.reclaimXrp, 'XRP | cleanup txs', plan.cleanup.map((t) => t.TransactionType).join(','));

const singles = toBatches(user.address, plan.cleanup, { sequence: before.accountData.Sequence, baseFeeDrops: Number(before.baseFee || 10), batch: false });
console.log('unsigned singles:', singles.map((t) => `${t.TransactionType}#${t.Sequence}`).join(', '), '| any Batch:', singles.some((t) => t.TransactionType === 'Batch'));
for (const t of singles) {
  const cur = await client.request({ command: 'ledger_current' });
  const signed = user.sign({ ...t, LastLedgerSequence: cur.result.ledger_current_index + 20 });
  const sub = await client.request({ command: 'submit', tx_blob: signed.tx_blob });
  await sleep(5000);
  const tx = await client.request({ command: 'tx', transaction: signed.hash });
  console.log(`${t.TransactionType} #${t.Sequence}: submit ${sub.result.engine_result} | final ${tx.result.meta?.TransactionResult} | validated ${tx.result.validated}`);
}
await sleep(4000);

const after = await scanAccount(user.address, { servers: SERVERS });
const freed = before.accountData.OwnerCount - after.accountData.OwnerCount;
console.log('owner count', before.accountData.OwnerCount, '->', after.accountData.OwnerCount, `(freed ${freed} objects = ${freed * Number(after.reserveInc) / 1e6} XRP reserve)`);
console.log('remaining objects:', after.objects.map((o) => o.LedgerEntryType).join(',') || 'none');
console.log(freed === plan.cleanup.length ? 'E2E PASS' : 'E2E FAIL');
await client.disconnect();
process.exit(freed === plan.cleanup.length ? 0 : 2);
