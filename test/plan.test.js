import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustLineItem, buildPlan, toBatches, giftTx, lsf, tf, MAX_BATCH } from '../src/plan.js';

const ME = 'rMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMe';
const ISS = 'rISSUERISSUERISSUERISSUERISSUERxx';

// ME is the LOW account when its address sorts lower; the tests set it explicitly.
function line({ meLow = true, balance = '0', flags = 0, limit = '1000' } = {}) {
  const me = { currency: 'USD', issuer: ME, value: limit };
  const peer = { currency: 'USD', issuer: ISS, value: '0' };
  return { index: 'A'.repeat(64), LedgerEntryType: 'RippleState', Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: balance }, LowLimit: meLow ? me : peer, HighLimit: meLow ? peer : me, Flags: flags };
}

test('zero-balance line I reserve, no DefaultRipple -> limit 0 + SetNoRipple', () => {
  const it = trustLineItem(ME, line({ flags: lsf.LowReserve }), 0);
  assert.equal(it.reclaimable, true);
  assert.equal(it.tx.TransactionType, 'TrustSet');
  assert.equal(it.tx.LimitAmount.value, '0');
  assert.equal(it.tx.LimitAmount.issuer, ISS);
  assert.equal(it.tx.Flags, tf.SetNoRipple);
});

test('account with DefaultRipple -> ClearNoRipple instead', () => {
  const it = trustLineItem(ME, line({ flags: lsf.LowReserve | lsf.LowNoRipple }), lsf.DefaultRipple);
  assert.equal(it.tx.Flags, tf.ClearNoRipple);
});

test('my side frozen -> also ClearFreeze', () => {
  const it = trustLineItem(ME, line({ flags: lsf.LowReserve | lsf.LowFreeze }), 0);
  assert.equal(it.tx.Flags, tf.SetNoRipple | tf.ClearFreeze);
});

test('still holding tokens -> not reclaimable', () => {
  const it = trustLineItem(ME, line({ balance: '5', flags: lsf.LowReserve }), 0);
  assert.equal(it.reclaimable, false);
  assert.match(it.why, /still hold/);
});

test('high side: balance sign flips (negative stored balance = I hold)', () => {
  const holds = trustLineItem(ME, line({ meLow: false, balance: '-5', flags: lsf.HighReserve }), 0);
  assert.equal(holds.reclaimable, false);
  const owes = trustLineItem(ME, line({ meLow: false, balance: '5', flags: lsf.HighReserve }), 0);
  assert.match(owes.why, /owe/);
  const empty = trustLineItem(ME, line({ meLow: false, balance: '0', flags: lsf.HighReserve }), 0);
  assert.equal(empty.reclaimable, true);
});

test('line where only the other side reserves -> nothing to reclaim', () => {
  assert.equal(trustLineItem(ME, line({ flags: lsf.HighReserve }), 0), null);
});

test('deep-frozen by me -> left for manual handling', () => {
  const it = trustLineItem(ME, line({ flags: lsf.LowReserve | lsf.LowFreeze | lsf.LowDeepFreeze }), 0);
  assert.equal(it.reclaimable, false);
});

test('buildPlan: counts reserve per object, NFT offers by count, delegates optional', () => {
  const scan = {
    account: ME, accountData: { Flags: 0, Sequence: 50 }, signerLists: [], reserveInc: 200000, agree: true, closeTime: 1000,
    objects: [
      line({ flags: lsf.LowReserve }),
      { LedgerEntryType: 'Offer', index: 'B'.repeat(64), Account: ME, Sequence: 7 },
      { LedgerEntryType: 'Offer', index: 'C'.repeat(64), Account: ISS, Sequence: 9 },
      { LedgerEntryType: 'NFTokenOffer', index: 'D'.repeat(64), Owner: ME, Expiration: 999 },
      { LedgerEntryType: 'NFTokenOffer', index: 'E'.repeat(64), Owner: ME, Expiration: 1000 },
      { LedgerEntryType: 'Delegate', index: 'F'.repeat(64), Account: ME, Authorize: ISS, Permissions: [{ Permission: { PermissionValue: 'Payment' } }] },
      { LedgerEntryType: 'Escrow', index: '1'.repeat(64) },
    ],
  };
  const p = buildPlan(scan);
  assert.equal(p.reclaimXrp, 0.6); // line + 2 NFT offers (the open DEX order is optional)
  assert.equal(p.optionalXrp, 0.4); // open order + delegate
  assert.equal(p.cleanup.length, 2); // TrustSet, one NFTokenCancelOffer
  assert.deepEqual(p.cleanup.find((t) => t.TransactionType === 'NFTokenCancelOffer').NFTokenOffers, ['D'.repeat(64), 'E'.repeat(64)]);
  assert.ok(p.risks.some((r) => r.kind === 'master_key'));
  assert.ok(p.items.some((i) => i.kind === 'Escrow' && !i.reclaimable));
});

test('toBatches: groups of 8, inner fee 0 + inner flag, consecutive sequences, single tx stays plain', () => {
  const txs = Array.from({ length: 9 }, (_, i) => ({ TransactionType: 'OfferCancel', Account: ME, OfferSequence: i + 1 }));
  const out = toBatches(ME, txs, { sequence: 100, baseFeeDrops: 10 });
  assert.equal(out.length, 2);
  const [b, single] = out;
  assert.equal(b.TransactionType, 'Batch');
  assert.equal(b.Flags, tf.Independent);
  assert.equal(b.Sequence, 100);
  assert.equal(b.RawTransactions.length, MAX_BATCH);
  assert.equal(b.Fee, String(10 * (2 + MAX_BATCH)));
  b.RawTransactions.forEach((r, k) => {
    assert.equal(r.RawTransaction.Sequence, 101 + k);
    assert.equal(r.RawTransaction.Fee, '0');
    assert.equal(r.RawTransaction.SigningPubKey, '');
    assert.ok(r.RawTransaction.Flags & tf.InnerBatchTxn);
  });
  assert.equal(single.TransactionType, 'OfferCancel');
  assert.equal(single.Sequence, 109);
});

test('expired DEX offer is junk; live one is optional', () => {
  const scan = { account: ME, accountData: { Flags: 0, Sequence: 1 }, signerLists: [], reserveInc: 200000, closeTime: 1000, agree: true,
    objects: [
      { LedgerEntryType: 'Offer', index: 'B'.repeat(64), Account: ME, Sequence: 7, Expiration: 999 },
      { LedgerEntryType: 'Offer', index: 'C'.repeat(64), Account: ME, Sequence: 8 },
    ] };
  const p = buildPlan(scan);
  assert.equal(p.cleanup.length, 1);
  assert.equal(p.cleanup[0].OfferSequence, 7);
  assert.equal(p.optionalCleanup[0].OfferSequence, 8);
});

const GIFT_TO = 'rBJW51DoReTh2wpikTADVFNyAyjTQeyX4L'; // a real-format address (KVT attester, public)

test('gift goes last in an all-or-nothing Batch', () => {
  const txs = Array.from({ length: 3 }, (_, k) => ({ TransactionType: 'OfferCancel', Account: ME, OfferSequence: k + 1 }));
  const gift = giftTx(ME, { destination: GIFT_TO, drops: 600000 });
  const out = toBatches(ME, txs, { sequence: 10, baseFeeDrops: 10, gift });
  assert.equal(out.length, 1);
  assert.equal(out[0].Flags, tf.AllOrNothing);
  assert.equal(out[0].RawTransactions.length, 4);
  assert.equal(out[0].RawTransactions[3].RawTransaction.TransactionType, 'Payment');
  assert.equal(out[0].RawTransactions[3].RawTransaction.Amount, '600000');
  assert.equal(out[0].RawTransactions[3].RawTransaction.Sequence, 14);
  assert.equal(out[0].Fee, String(10 * 6));
});

test('gift with 10 actions: first Batch independent, last all-or-nothing with 7 + gift', () => {
  const txs = Array.from({ length: 10 }, (_, k) => ({ TransactionType: 'OfferCancel', Account: ME, OfferSequence: k + 1 }));
  const out = toBatches(ME, txs, { sequence: 1, gift: giftTx(ME, { destination: GIFT_TO, drops: 1 }) });
  // head = 3 actions (Independent), tail = 7 + gift (AllOrNothing)
  assert.deepEqual(out.map((t) => [t.Flags, t.RawTransactions.length]), [[tf.Independent, 3], [tf.AllOrNothing, 8]]);
  assert.equal(out[1].Sequence, 5);
});

test('gift rejects bad input', () => {
  assert.throws(() => giftTx(ME, { destination: ME, drops: 1 }));
  assert.throws(() => giftTx(ME, { destination: GIFT_TO, drops: 0 }));
  assert.throws(() => giftTx(ME, { destination: GIFT_TO, drops: '1.5' }));
  assert.throws(() => giftTx(ME, { destination: 'nope', drops: 1 }));
});

test('live NFT offers and live checks are optional; expired ones are junk', () => {
  const scan = { account: ME, accountData: { Flags: 0, Sequence: 1 }, signerLists: [], reserveInc: 200000, closeTime: 1000, agree: true,
    objects: [
      { LedgerEntryType: 'NFTokenOffer', index: 'D'.repeat(64), Owner: ME, Expiration: 900 },
      { LedgerEntryType: 'NFTokenOffer', index: 'E'.repeat(64), Owner: ME },
      { LedgerEntryType: 'Check', index: '2'.repeat(64), Account: ME, Expiration: 999 },
      { LedgerEntryType: 'Check', index: '3'.repeat(64), Account: ME, Expiration: 2000 },
    ] };
  const p = buildPlan(scan);
  assert.equal(p.reclaimXrp, 0.4); // expired NFT offer + expired check
  assert.equal(p.optionalXrp, 0.4); // live NFT offer + live check
  assert.deepEqual(p.cleanup.find((t) => t.TransactionType === 'NFTokenCancelOffer').NFTokenOffers, ['D'.repeat(64)]);
  assert.equal(p.cleanup.find((t) => t.TransactionType === 'CheckCancel').CheckID, '2'.repeat(64));
});

test('buildPlan refuses when the servers did not agree', () => {
  const scan = { account: ME, accountData: { Flags: 0, Sequence: 1 }, signerLists: [], objects: [], agree: false };
  assert.throws(() => buildPlan(scan), /did not agree/);
  assert.throws(() => buildPlan({ ...scan, agree: undefined }), /did not agree/);
  assert.doesNotThrow(() => buildPlan(scan, { force: true }));
});
