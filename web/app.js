import { scanAccount } from '../src/scan.js';
import { buildPlan, toBatches } from '../src/plan.js';

const $ = (id) => document.getElementById(id);
const LABEL = { trustline: 'Trust line', dex_offer: 'DEX offer', nft_offers: 'NFT offers', check: 'Check', delegate: 'Delegate', ticket: 'Ticket' };
const fmt = (x) => (Math.round(x * 1e6) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });
const ADDR = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
let state = null;

function itemText(it) {
  if (it.kind === 'trustline') return `${it.currency.length > 3 ? hexName(it.currency) : it.currency} from ${it.peer}`;
  if (it.kind === 'nft_offers') return `${it.count} offer${it.count > 1 ? 's' : ''} you made`;
  if (it.kind === 'delegate') return it.why;
  if (it.kind === 'dex_offer') return `Order #${it.tx.OfferSequence}`;
  return it.why || it.id.slice(0, 16) + '…';
}
function hexName(h) {
  try { const s = h.replace(/(00)+$/, '').match(/../g).map((b) => String.fromCharCode(parseInt(b, 16))).join(''); return /^[\x20-\x7e]+$/.test(s) ? s : h.slice(0, 8) + '…'; } catch { return h.slice(0, 8) + '…'; }
}
const objCount = (it) => (it.kind === 'nft_offers' ? it.count : 1);

function render() {
  const { scan, plan } = state;
  const inc = Number(scan.reserveInc ?? 200000) / 1e6; // same fallback as plan.js
  const list = $('items'); list.innerHTML = '';
  if (!plan.items.some((it) => it.reclaimable)) list.innerHTML = '<li><span></span><span class="what">Nothing to clean up. This account is already tidy.</span><span></span></li>';
  plan.items.forEach((it, i) => {
    if (!it.reclaimable && it.kind !== 'trustline') return; // grouped below
    const li = document.createElement('li');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.id = 'it' + i;
    cb.disabled = !it.reclaimable; cb.checked = it.reclaimable && !it.optional && it.chosen !== false;
    if (it.chosen === true) cb.checked = true;
    cb.addEventListener('change', () => { it.chosen = cb.checked; render(); });
    const what = document.createElement('label'); what.className = 'what'; what.htmlFor = cb.id;
    what.innerHTML = `<span class="tag">${LABEL[it.kind] || it.kind}</span><br>${escapeHtml(itemText(it))}` + (it.kind === 'trustline' && !it.reclaimable ? `<div class="why">${escapeHtml(it.why)}</div>` : '') + (it.optional ? `<div class="why">${escapeHtml(it.kind === 'dex_offer' ? it.why : 'Optional')}</div>` : '');
    const amt = document.createElement('span'); amt.className = 'amt'; amt.textContent = it.reclaimable ? `+${fmt(objCount(it) * inc)} XRP` : '';
    if (!cb.checked) li.className = 'off';
    li.append(cb, what, amt);
    li.dataset.rank = it.reclaimable ? (it.optional ? 1 : 0) : 2; // junk, then optional, then kept
    list.appendChild(li);
  });
  [...list.children].sort((a, b) => a.dataset.rank - b.dataset.rank).forEach((li) => list.appendChild(li));
  // Everything this tool can't remove, one line per type.
  const kept = {};
  for (const it of plan.items) if (!it.reclaimable && it.kind !== 'trustline') (kept[it.kind] ||= { n: 0, why: it.why }).n++;
  for (const [kind, { n, why }] of Object.entries(kept)) {
    const li = document.createElement('li'); li.className = 'off';
    li.innerHTML = `<span></span><span class="what"><span class="tag">${escapeHtml(LABEL[kind] || kind)} × ${n}</span><div class="why">${escapeHtml(why)}</div></span><span></span>`;
    list.appendChild(li);
  }
  const chosen = plan.items.filter((it, i) => $('it' + i)?.checked);
  const xrp = chosen.reduce((n, it) => n + objCount(it), 0) * Number(scan.reserveInc ?? 200000) / 1e6;
  $('big').textContent = `${fmt(xrp)} XRP`;
  $('sub').textContent = `Balance ${fmt(Number(scan.accountData.Balance) / 1e6)} XRP · ${scan.accountData.OwnerCount} objects on the account · ${chosen.length} selected`;

  const who = $('who'); who.innerHTML = '';
  for (const r of plan.risks) {
    const li = document.createElement('li');
    if (r.kind === 'master_key') li.textContent = 'Master key: can sign alone.';
    if (r.kind === 'regular_key') li.textContent = `Regular key ${r.who}: can sign alone.`;
    if (r.kind === 'signer_list') li.textContent = `Signer list, quorum ${r.quorum}: ${r.signers.map((s) => `${s.account} (weight ${s.weight})`).join(', ')}.`;
    if (r.kind === 'delegate') li.textContent = `Delegate ${r.who} may send: ${r.permissions.join(', ')}.`;
    who.appendChild(li);
  }
  if (!plan.risks.length) who.innerHTML = '<li>Nobody: the master key is disabled and no other key is set.</li>';

  const useBatch = !$('nobatch').checked;
  const txs = toBatches(scan.account, chosen.map((it) => it.tx), { sequence: scan.accountData.Sequence, baseFeeDrops: Number(scan.baseFee || 10), batch: useBatch });
  state.txs = txs;
  const nb = txs.filter((t) => t.TransactionType === 'Batch').length;
  $('txnote').textContent = txs.length ? `${chosen.length} action${chosen.length > 1 ? 's' : ''} in ${txs.length} unsigned transaction${txs.length > 1 ? 's' : ''}${useBatch ? ` (${nb} Batch${nb === 1 ? '' : 'es'}, up to 8 actions each)` : ' (one per action, no Batch)'}. Sequence starts at ${scan.accountData.Sequence}; sign them in this order.` : 'Nothing selected.';
  $('txs').textContent = txs.length ? JSON.stringify(txs, null, 2) : '';
  $('copy').disabled = !txs.length;
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function run(account) {
  $('status').className = 'status'; $('status').textContent = 'Reading the ledger on two servers…'; $('go').disabled = true; $('out').hidden = true;
  try {
    const scan = await scanAccount(account);
    if (!scan.agree) { $('status').className = 'status bad'; $('status').textContent = `The two servers disagree at ledger ${scan.ledgerIndex}. Try again in a few seconds.`; return; }
    state = { scan, plan: buildPlan(scan) };
    $('status').textContent = `Ledger ${scan.ledgerIndex} · xrplcluster.com and s2.ripple.com agree.`;
    $('out').hidden = false; render();
  } catch (e) {
    $('status').className = 'status bad';
    $('status').textContent = e.code === 'actNotFound' ? 'That account does not exist on the ledger.' : `Could not read the ledger: ${e.message}`;
  } finally { $('go').disabled = false; }
}

$('f').addEventListener('submit', (e) => { e.preventDefault(); const a = $('acct').value.trim(); if (!ADDR.test(a)) { $('status').className = 'status bad'; $('status').textContent = 'That does not look like an XRPL address (it starts with r).'; return; } run(a); });
$('nobatch').addEventListener('change', () => { if (state) render(); });
$('ex').addEventListener('click', () => { $('acct').value = 'rBJW51DoReTh2wpikTADVFNyAyjTQeyX4L'; run($('acct').value); });
$('copy').addEventListener('click', async () => {
  const text = JSON.stringify(state.txs, null, 2);
  try { await navigator.clipboard.writeText(text); $('copied').textContent = 'Copied.'; }
  catch { const r = document.createRange(); r.selectNodeContents($('txs')); const s = getSelection(); s.removeAllRanges(); s.addRange(r); $('copied').textContent = 'Selected: press ⌘C to copy.'; }
});
