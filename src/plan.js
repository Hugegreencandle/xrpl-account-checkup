// Turn a scan into (1) reclaimable items with unsigned cleanup transactions and (2) a list of
// who can act for the account. Rules are taken from rippled 3.4 source; see README "Rules".

// Ledger flags (include/xrpl/protocol/LedgerFormats.h)
export const lsf = {
  LowReserve: 0x00010000, HighReserve: 0x00020000,
  LowNoRipple: 0x00100000, HighNoRipple: 0x00200000,
  LowFreeze: 0x00400000, HighFreeze: 0x00800000,
  LowDeepFreeze: 0x02000000, HighDeepFreeze: 0x04000000,
  DefaultRipple: 0x00800000, DisableMaster: 0x00100000,
};
// Transaction flags (include/xrpl/protocol/TxFlags.h)
export const tf = {
  SetNoRipple: 0x00020000, ClearNoRipple: 0x00040000, ClearFreeze: 0x00200000,
  InnerBatchTxn: 0x40000000, Independent: 0x00080000, AllOrNothing: 0x00010000,
};
export const MAX_BATCH = 8; // kMaxBatchTxCount, Protocol.h:454
export const MAX_NFT_CANCEL = 500; // kMaxTokenOfferCancelCount, Protocol.h:79

const isZero = (v) => Number(v) === 0;

// A trust line returns your 0.2 XRP when YOUR side is back to default (TrustSet.cpp:501-514):
// limit 0, balance not positive for you, no quality, not frozen, and NoRipple == !DefaultRipple.
// We only offer it when your side is the one holding the reserve and you hold exactly 0.
export function trustLineItem(account, rs, accountFlags) {
  const low = rs.LowLimit.issuer === account;
  const mine = low ? rs.LowLimit : rs.HighLimit;
  const peer = low ? rs.HighLimit.issuer : rs.LowLimit.issuer;
  const reserveFlag = low ? lsf.LowReserve : lsf.HighReserve;
  if (!(rs.Flags & reserveFlag)) return null; // your side holds no reserve: nothing to reclaim
  const bal = Number(rs.Balance.value);
  const myBal = low ? bal : -bal; // Balance is stored from the low account's view
  const deep = rs.Flags & (low ? lsf.LowDeepFreeze : lsf.HighDeepFreeze);
  const base = { kind: 'trustline', id: rs.index, currency: rs.Balance.currency, peer, limit: mine.value, balance: String(myBal) };
  if (myBal !== 0) return { ...base, reclaimable: false, why: myBal > 0 ? 'you still hold this token' : 'you owe on this line (you are the issuer side)' };
  if (deep) return { ...base, reclaimable: false, why: 'deep-frozen by you; clear it manually first' };
  const defaultRipple = (accountFlags & lsf.DefaultRipple) !== 0;
  let flags = defaultRipple ? tf.ClearNoRipple : tf.SetNoRipple;
  if (rs.Flags & (low ? lsf.LowFreeze : lsf.HighFreeze)) flags |= tf.ClearFreeze;
  const tx = { TransactionType: 'TrustSet', Account: account, LimitAmount: { currency: rs.Balance.currency, issuer: peer, value: '0' }, Flags: flags };
  if (low ? rs.LowQualityIn || rs.LowQualityOut : rs.HighQualityIn || rs.HighQualityOut) { tx.QualityIn = 0; tx.QualityOut = 0; }
  // Pre-ticked: a 0-balance line is usually an old token. If you set a limit you can still receive
  // the token; removing the line stops that until you add it again, so say it.
  const why = Number(mine.value) !== 0 ? 'you hold 0; removing it means you cannot receive this token until you add it again' : 'limit 0 and 0 balance: only the reserve is left';
  return { ...base, reclaimable: true, why, tx };
}

export function buildPlan(scan, { force = false } = {}) {
  // Refuse to plan from data the two servers did not agree on (scan.js sets scan.agree).
  if (scan.agree !== true && !force) throw new Error('servers did not agree on this account at one ledger: no plan built');
  const { account, objects, accountData } = scan;
  const items = [];
  const risks = [];
  const nftOffers = [];
  const liveNftOffers = [];
  const isExpired = (o) => o.Expiration != null && scan.closeTime != null && o.Expiration <= scan.closeTime;
  for (const o of objects) {
    switch (o.LedgerEntryType) {
      case 'RippleState': { const it = trustLineItem(account, o, accountData.Flags); if (it) items.push(it); break; }
      case 'Offer':
        if (o.Account === account) {
          // An expired offer is junk. A live one is an open order the user may want: optional.
          const expired = isExpired(o);
          items.push({ kind: 'dex_offer', id: o.index, reclaimable: true, optional: !expired, why: expired ? 'expired order' : 'open order: cancelling it removes your trade', tx: { TransactionType: 'OfferCancel', Account: account, OfferSequence: o.Sequence } });
        }
        break;
      case 'NFTokenOffer':
        // Expired = junk. A live offer may be a sale or bid the user still wants: optional.
        if (o.Owner === account) (isExpired(o) ? nftOffers : liveNftOffers).push(o.index);
        break;
      case 'Check':
        if (o.Account === account) {
          // A live check is a payment you promised someone: cancelling it is optional.
          const expired = isExpired(o);
          items.push({ kind: 'check', id: o.index, reclaimable: true, optional: !expired, why: expired ? 'expired check' : 'live check: cancelling it withdraws a payment you promised', tx: { TransactionType: 'CheckCancel', Account: account, CheckID: o.index } });
        }
        break;
      case 'Delegate':
        if (o.Account === account) {
          const perms = (o.Permissions || []).map((p) => p.Permission?.PermissionValue ?? p.PermissionValue);
          risks.push({ kind: 'delegate', who: o.Authorize, permissions: perms });
          items.push({ kind: 'delegate', id: o.index, reclaimable: true, optional: true, why: `revoking ${o.Authorize} also frees its reserve`, tx: { TransactionType: 'DelegateSet', Account: account, Authorize: o.Authorize, Permissions: [] } });
        }
        break;
      case 'Ticket':
        // A ticket is freed only by using it (Transactor ticketDelete -> owner count -1). The cleanup
        // uses it on a no-op AccountSet. Optional: a transaction you already pre-signed may rely on it.
        items.push({ kind: 'ticket', id: o.index, reclaimable: true, optional: true, why: `unused ticket #${o.TicketSequence}: using it frees its reserve (skip if something you pre-signed uses it)`, tx: { TransactionType: 'AccountSet', Account: account, Sequence: 0, TicketSequence: o.TicketSequence } });
        break;
      case 'SignerList':
        break; // reported from signer_lists below
      default:
        items.push({ kind: o.LedgerEntryType, id: o.index, reclaimable: false, why: 'not removed by this tool' });
    }
  }
  for (const [list, optional] of [[nftOffers, false], [liveNftOffers, true]]) {
    for (let i = 0; i < list.length; i += MAX_NFT_CANCEL) {
      const ids = list.slice(i, i + MAX_NFT_CANCEL);
      items.push({ kind: 'nft_offers', id: ids[0], count: ids.length, reclaimable: true, optional, why: optional ? 'live NFT offer(s): cancelling removes your sale or bid' : 'expired NFT offer(s)', tx: { TransactionType: 'NFTokenCancelOffer', Account: account, NFTokenOffers: ids } });
    }
  }

  // Who can act for the account (authority), beyond delegates found above.
  if (!(accountData.Flags & lsf.DisableMaster)) risks.push({ kind: 'master_key', note: 'the master key can sign' });
  if (accountData.RegularKey) risks.push({ kind: 'regular_key', who: accountData.RegularKey });
  for (const sl of scan.signerLists) risks.push({ kind: 'signer_list', quorum: sl.SignerQuorum, signers: (sl.SignerEntries || []).map((e) => ({ account: e.SignerEntry.Account, weight: e.SignerEntry.SignerWeight })) });

  const reclaimable = items.filter((i) => i.reclaimable && !i.optional);
  const optional = items.filter((i) => i.reclaimable && i.optional);
  // server_state reports reserves in drops; fall back to 0.2 XRP (measured 2026-10-21, ledger 107804521)
  const incDrops = scan.reserveInc != null ? Number(scan.reserveInc) : 200000;
  const objectsFreed = (list) => list.reduce((n, i) => n + (i.kind === 'nft_offers' ? i.count : 1), 0);
  return {
    items, risks,
    // ("optional" = live DEX offers, live NFT offers, live checks and delegates: things the user may want to keep)
    reclaimXrp: (objectsFreed(reclaimable) * incDrops) / 1e6, // whole drops first: no float drift
    optionalXrp: (objectsFreed(optional) * incDrops) / 1e6,
    cleanup: reclaimable.map((i) => i.tx),
    optionalCleanup: optional.map((i) => i.tx),
  };
}

// Group unsigned transactions into Batches of up to 8 (tfIndependent: each inner tx stands alone,
// so one failure does not undo the others). Inner txs: fee 0, empty SigningPubKey, inner flag,
// consecutive Sequence after the outer (Batch.cpp preflight). A single tx is returned as-is.
// With `gift` (from giftTx), the gift Payment goes last, in a final tfAllOrNothing Batch with up to
// 7 cleanup actions: if any of those fails, the gift is not sent either.
// With `batch: false`, every action is its own plain transaction (Sequence and Fee set, in order),
// for wallets that cannot sign Batch yet. A gift then goes last as its own Payment, so it is NOT
// all-or-nothing with the cleanup: it is sent even if a cleanup action fails.
export function toBatches(account, txs, { sequence, baseFeeDrops = 10, gift, batch = true } = {}) {
  if (!batch) return toSingles(account, gift ? [...txs, gift] : txs, { sequence, baseFeeDrops });
  const out = [];
  let seq = sequence;
  const push = (group, flags) => {
    if (group.length === 1) {
      const [one] = toSingles(account, group, { sequence: seq, baseFeeDrops });
      out.push(one);
      if (!usesTicket(one)) seq += 1;
      return;
    }
    const outerSeq = seq;
    let next = outerSeq + 1;
    // An inner tx that uses a ticket has Sequence 0 and does not take a sequence number
    // (Batch.cpp preflight: exactly one of Sequence / TicketSequence).
    const inner = group.map((t) => ({
      RawTransaction: { ...t, Flags: (t.Flags || 0) | tf.InnerBatchTxn, Fee: '0', SigningPubKey: '', Sequence: usesTicket(t) ? 0 : next++ },
    }));
    // Batch fee = base (batch) + outer base fee + each inner base fee (Batch.cpp calculateBaseFeeImpl)
    out.push({ TransactionType: 'Batch', Account: account, Flags: flags, Sequence: outerSeq, Fee: String(baseFeeDrops * (2 + group.length)), RawTransactions: inner });
    seq = next;
  };
  const tail = gift ? txs.slice(Math.max(0, txs.length - (MAX_BATCH - 1))) : [];
  const head = gift ? txs.slice(0, txs.length - tail.length) : txs;
  for (let i = 0; i < head.length; i += MAX_BATCH) push(head.slice(i, i + MAX_BATCH), tf.Independent);
  if (gift) push([...tail, gift], tf.AllOrNothing);
  return out;
}

// One plain transaction per action, consecutive Sequence numbers, base fee each. Works in any
// wallet that can sign the single transaction types (TrustSet, OfferCancel, NFTokenCancelOffer, CheckCancel, ...).
export function toSingles(account, txs, { sequence, baseFeeDrops = 10 } = {}) {
  let seq = sequence;
  return txs.map((t) => ({ ...t, Account: account, Sequence: usesTicket(t) ? 0 : seq++, Fee: String(baseFeeDrops) }));
}

// A tx that consumes a ticket carries TicketSequence and Sequence 0.
export const usesTicket = (t) => t.TicketSequence != null;

// "Clean up and give": a plain XRP Payment of `drops` to `destination`, sent with the cleanup.
// The amount is whatever the owner chooses (often the reserve the cleanup frees).
export function giftTx(account, { destination, drops, destinationTag } = {}) {
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(destination || '')) throw new Error('gift: destination is not an XRPL address');
  if (destination === account) throw new Error('gift: destination is the same account');
  if (!/^[1-9][0-9]*$/.test(String(drops))) throw new Error('gift: drops must be a whole number above 0');
  const tx = { TransactionType: 'Payment', Account: account, Destination: destination, Amount: String(drops) };
  if (destinationTag !== undefined) tx.DestinationTag = Number(destinationTag);
  return tx;
}
