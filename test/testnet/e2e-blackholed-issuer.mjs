// Manual TESTNET check (no real money): the issuer's side of a line is NOT default (the issuer set
// a limit toward the holder) and the issuer is blackholed, so nobody can ever reset that side.
// The holder resets their own side: their reserve is freed (OwnerCount 1 -> 0) even though the
// line itself stays, because a line is deleted only when BOTH sides are default
// (rippled TrustSet.cpp:504-514, 561-567, 617).
//   node test/testnet/e2e-blackholed-issuer.mjs   (needs xrpl.js: npm i --no-save xrpl, or set XRPLJS to its path)
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const xrpl = require(process.env.XRPLJS || 'xrpl');

const client = new xrpl.Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const { wallet: holder } = await client.fundWallet();
const { wallet: issuer } = await client.fundWallet();
console.log('holder', holder.address, 'issuer', issuer.address);
const send = async (tx, w) => (await client.submitAndWait(tx, { wallet: w, autofill: true })).result.meta.TransactionResult;
const info = async (a) => (await client.request({ command: 'account_info', account: a, ledger_index: 'validated' })).result.account_data;
const lines = async () => (await client.request({ command: 'account_lines', account: holder.address, ledger_index: 'validated' })).result.lines;

console.log('issuer DefaultRipple', await send({ TransactionType: 'AccountSet', Account: issuer.address, SetFlag: 8 }, issuer));
console.log('holder TrustSet 1000', await send({ TransactionType: 'TrustSet', Account: holder.address, LimitAmount: { currency: 'USD', issuer: issuer.address, value: '1000' }, Flags: 0x00020000 }, holder));
console.log('issuer TrustSet 5 toward holder (issuer side not default)', await send({ TransactionType: 'TrustSet', Account: issuer.address, LimitAmount: { currency: 'USD', issuer: holder.address, value: '5' } }, issuer));
console.log('issuer blackhole: RegularKey', await send({ TransactionType: 'SetRegularKey', Account: issuer.address, RegularKey: 'rrrrrrrrrrrrrrrrrrrrBZbvji' }, issuer));
console.log('issuer blackhole: disable master', await send({ TransactionType: 'AccountSet', Account: issuer.address, SetFlag: 4 }, issuer));
const iss = await info(issuer.address);
const black = !!(iss.Flags & 0x00100000) && iss.RegularKey === 'rrrrrrrrrrrrrrrrrrrrBZbvji';
const h1 = (await info(holder.address)).OwnerCount, i1 = iss.OwnerCount;
console.log('before: issuer blackholed', black, '| holder OwnerCount', h1, '| issuer OwnerCount', i1, '| lines', (await lines()).length);
console.log('holder TrustSet limit 0 + SetNoRipple', await send({ TransactionType: 'TrustSet', Account: holder.address, LimitAmount: { currency: 'USD', issuer: issuer.address, value: '0' }, Flags: 0x00020000 }, holder));
const h2 = (await info(holder.address)).OwnerCount, i2 = (await info(issuer.address)).OwnerCount, l2 = await lines();
console.log('after: holder OwnerCount', h2, '| issuer OwnerCount', i2, '| line still there', l2.length === 1, JSON.stringify(l2[0] || {}));
const pass = black && h1 === 1 && h2 === 0 && l2.length === 1 && i2 === i1;
console.log(pass ? 'PASS: holder reserve freed although the line stays (issuer side not default, issuer blackholed)' : 'FAIL');
await client.disconnect();
process.exit(pass ? 0 : 1);
