// Manual end-to-end test on XRPL TESTNET (no real money): "clean up and give". Creates junk on a
// throwaway account, runs the checkup, adds a gift of the freed reserve to a third throwaway account,
// signs the all-or-nothing Batch with the throwaway key (in memory only), and checks
// the objects are gone and the reserve came back. The product itself stays keyless.
//   node test/testnet/e2e-gift.mjs   (needs xrpl.js: npm i --no-save xrpl, or set XRPLJS to its path)
import { createRequire } from 'module';
import { scanAccount } from '../../src/scan.js';
import { buildPlan, toBatches, giftTx } from '../../src/plan.js';
const require = createRequire(import.meta.url);
const xrpl = require(process.env.XRPLJS || 'xrpl');

const WS = 'wss://s.altnet.rippletest.net:51233';
const SERVERS = ['https://s.altnet.rippletest.net:51234', 'https://testnet.xrpl-labs.com'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new xrpl.Client(WS);
await client.connect();
const { wallet: user } = await client.fundWallet();
const { wallet: issuer } = await client.fundWallet();
const { wallet: fund } = await client.fundWallet();
console.log('user', user.address, 'issuer', issuer.address, 'gift to', fund.address);

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

const giftDrops = plan.cleanup.length * Number(before.reserveInc);
const gift = giftTx(user.address, { destination: fund.address, drops: giftDrops });
const bal = async (a) => Number((await client.request({ command: 'account_info', account: a, ledger_index: 'validated' })).result.account_data.Balance);
const fundBefore = await bal(fund.address);
const [batch] = toBatches(user.address, plan.cleanup, { sequence: before.accountData.Sequence, baseFeeDrops: Number(before.baseFee || 10), gift });
console.log('Batch flags', '0x' + batch.Flags.toString(16), '| inner', batch.RawTransactions.map((r) => r.RawTransaction.TransactionType).join(','));
const cur = await client.request({ command: 'ledger_current' });
batch.LastLedgerSequence = cur.result.ledger_current_index + 20;
const signed = user.sign(batch);
const sub = await client.request({ command: 'submit', tx_blob: signed.tx_blob });
console.log('Batch submit:', sub.result.engine_result);
await sleep(9000);
const tx = await client.request({ command: 'tx', transaction: signed.hash });
console.log('Batch result:', tx.result.meta?.TransactionResult, '| validated', tx.result.validated);

const after = await scanAccount(user.address, { servers: SERVERS });
const freed = before.accountData.OwnerCount - after.accountData.OwnerCount;
console.log('owner count', before.accountData.OwnerCount, '->', after.accountData.OwnerCount, `(freed ${freed} objects = ${freed * Number(after.reserveInc) / 1e6} XRP reserve)`);
console.log('remaining objects:', after.objects.map((o) => o.LedgerEntryType).join(',') || 'none');
const got = (await bal(fund.address)) - fundBefore;
console.log('gift received', got, 'drops (expected', giftDrops + ')');
const ok = freed === plan.cleanup.length && got === giftDrops;
console.log(ok ? 'E2E GIFT PASS' : 'E2E GIFT FAIL');
await client.disconnect();
process.exit(ok ? 0 : 2);
