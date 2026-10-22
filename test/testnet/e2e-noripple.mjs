// Manual TESTNET check (no real money): a trust line with limit 0 and balance 0 still holds the
// owner's reserve when its NoRipple flag does not match the owner's DefaultRipple
// (rippled TrustSet.cpp:504-506). The census sample of 2026-10-22 found this in 68 of 70 such lines.
// One TrustSet that puts NoRipple in line with DefaultRipple must release the reserve.
//   node test/testnet/e2e-noripple.mjs   (needs xrpl.js: npm i --no-save xrpl, or set XRPLJS to its path)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const xrpl = require(process.env.XRPLJS || 'xrpl');

const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const { wallet: owner } = await client.fundWallet();
const { wallet: peer } = await client.fundWallet();
console.log('owner', owner.address, 'peer', peer.address);
const send = async (tx, w) => (await client.submitAndWait(tx, { wallet: w, autofill: true })).result.meta.TransactionResult;
const state = async () => {
  const a = (await client.request({ command: 'account_info', account: owner.address, ledger_index: 'validated' })).result.account_data;
  const l = (await client.request({ command: 'account_lines', account: owner.address, ledger_index: 'validated' })).result.lines;
  return { ownerCount: a.OwnerCount, defaultRipple: !!(a.Flags & 0x00800000), lines: l.map((x) => ({ limit: x.limit, balance: x.balance, no_ripple: !!x.no_ripple })) };
};
const line = (value, Flags) => ({ TransactionType: 'TrustSet', Account: owner.address, LimitAmount: { currency: 'USD', issuer: peer.address, value }, Flags });
const tfSetNoRipple = 0x00020000, tfClearNoRipple = 0x00040000;

console.log('AccountSet DefaultRipple', await send({ TransactionType: 'AccountSet', Account: owner.address, SetFlag: 8 }, owner));
console.log('TrustSet limit 100 + SetNoRipple', await send(line('100', tfSetNoRipple), owner));
const s1 = await state(); console.log('1', JSON.stringify(s1));
console.log('TrustSet limit 0 (NoRipple left set)', await send(line('0', 0), owner));
const s2 = await state(); console.log('2', JSON.stringify(s2));
console.log('TrustSet limit 0 + ClearNoRipple', await send(line('0', tfClearNoRipple), owner));
const s3 = await state(); console.log('3', JSON.stringify(s3));
const pass = s1.ownerCount === 1 && s2.ownerCount === 1 && s2.lines.length === 1 && s3.ownerCount === 0;
console.log(pass ? 'PASS: limit 0 alone keeps the reserve; matching NoRipple releases it' : 'FAIL');
await client.disconnect();
process.exit(pass ? 0 : 1);
