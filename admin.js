let key = sessionStorage.getItem('cjp_admin_key') || '';
const $ = id => document.getElementById(id);
function esc(v) { return String(v ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function money(n) { return Number(n || 0).toFixed(6).replace(/\.?0+$/, ''); }
function date(v) { return v ? new Date(v).toLocaleString() : ''; }
async function api(url, opt = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Key': key, ...(opt.headers || {}) };
  const r = await fetch(url, { ...opt, headers });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || 'Request failed');
  return d;
}
function msg(text, error = false) { $('globalMsg').textContent = text || ''; $('globalMsg').className = 'msg' + (text && !error ? ' ok' : ''); }
function showPanel() { $('loginCard').classList.add('hidden'); $('panel').classList.remove('hidden'); }
const who = x => `${esc(x.firstName || x.username || 'Member')}${x.username ? ' (@' + esc(x.username) + ')' : ''} • ID: ${esc(x.userId ?? x.id)}`;
// Every dynamic value that lands in an attribute is esc()'d AND only ever read back through dataset (never evaluated as JS).
const copyBtn = text => `<button class="small" data-act="copy" data-copy="${esc(text)}">Copy</button>`;

async function login() {
  const v = $('adminKey').value.trim(); if (!v) return ($('loginMsg').textContent = 'Enter Admin Key');
  key = v;
  try { await api('/api/admin/stats'); sessionStorage.setItem('cjp_admin_key', key); $('loginMsg').textContent = ''; showPanel(); await loadAll(); }
  catch (e) { key = ''; $('loginMsg').textContent = e.message; }
}
async function loadStats() {
  const d = await api('/api/admin/stats');
  $('stats').innerHTML = [['Users', d.totalUsers], ['VIP Users', d.vipUsers], ['CJP', Math.floor(d.cjpInCirculation).toLocaleString()], ['USDT', money(d.usdtBalances)], ['Pending Deposits', d.pendingDeposits], ['Processing Withdrawals', d.pendingWithdrawals], ['Coin Withdrawals', d.pendingCoinWithdrawals], ['Coins (claimed)', money(d.coinBalances)]]
    .map(x => `<div class="stat"><b>${esc(x[1])}</b><span>${esc(x[0])}</span></div>`).join('');
}
function setBadge(id, n) { const b = $(id); if (!b) return; if (n) { b.textContent = n; b.classList.remove('hidden'); } else b.classList.add('hidden'); }

let usdtWdCount = 0, coinWdCount = 0;
async function loadWithdrawals() {
  const rows = await api('/api/admin/withdrawals'); usdtWdCount = rows.length; setBadge('wdBadge', usdtWdCount + coinWdCount);
  $('withdrawals').innerHTML = rows.length ? rows.map(w => {
    const feePercent = w.feePercent ?? 5, feeAmount = w.feeAmount != null ? money(w.feeAmount) : money(w.amount) * (feePercent / 100), netAmount = w.netAmount != null ? money(w.netAmount) : money(w.amount) - feeAmount;
    return `<div class="item"><div class="item-top"><div><div class="item-title">${money(w.amount)} USDT requested • ${esc(w.network)}</div><div class="muted">${who(w)} • ${date(w.createdAt)}</div></div><b>PROCESSING</b></div><div class="muted">Address: ${esc(w.address)} ${copyBtn(w.address)}</div><div class="muted">Fee (${esc(feePercent)}%): ${money(feeAmount)} USDT • <b style="color:#ffbd3e">Send exactly: ${money(netAmount)} USDT</b></div><div class="actions"><button class="primary" data-act="completeWithdrawal" data-id="${esc(w.id)}">Mark Completed</button><button class="danger" data-act="rejectWithdrawal" data-id="${esc(w.id)}">Reject &amp; Refund</button></div></div>`;
  }).join('') : '<div class="empty">No processing withdrawals.</div>';
}
async function completeWithdrawal(d) {
  const tx = prompt('Payout transaction hash (required - shown on the public Proof of Payouts page):', '');
  if (tx === null) return;
  if (!tx.trim()) { msg('Transaction hash is required.', true); return; }
  try { await api('/api/admin/withdrawals/' + encodeURIComponent(d.id) + '/complete', { method: 'POST', body: JSON.stringify({ txHash: tx.trim() }) }); msg('Withdrawal marked completed.'); await loadAll(); } catch (e) { msg(e.message, true); }
}
async function rejectWithdrawal(d) {
  if (!confirm('Reject this withdrawal and return the USDT to the member?')) return;
  try { await api('/api/admin/withdrawals/' + encodeURIComponent(d.id) + '/reject', { method: 'POST', body: '{}' }); msg('Withdrawal rejected and refunded.'); await loadAll(); } catch (e) { msg(e.message, true); }
}

async function loadCoinWithdrawals() {
  const rows = await api('/api/admin/coin-withdrawals'); coinWdCount = rows.length; setBadge('wdBadge', usdtWdCount + coinWdCount);
  $('coinWithdrawals').innerHTML = rows.length ? rows.map(w => `<div class="item"><div class="item-top"><div><div class="item-title">${money(w.amount)} CJP coin to a TON wallet</div><div class="muted">${who(w)} \u2022 ${date(w.createdAt)}</div></div><b>PROCESSING</b></div><div class="muted">Address: ${esc(w.address)} ${copyBtn(w.address)}</div><div class="actions"><button class="primary" data-act="completeCoinWithdrawal" data-id="${esc(w.id)}">Mark Sent</button><button class="danger" data-act="rejectCoinWithdrawal" data-id="${esc(w.id)}">Reject &amp; Refund</button></div></div>`).join('') : '<div class="empty">No coin withdrawals waiting.</div>';
}
async function completeCoinWithdrawal(d) {
  const tx = prompt('Transaction hash of your CJP coin transfer (required):', '');
  if (tx === null) return;
  if (!tx.trim()) { msg('Transaction hash is required.', true); return; }
  try { await api('/api/admin/coin-withdrawals/' + encodeURIComponent(d.id) + '/complete', { method: 'POST', body: JSON.stringify({ txHash: tx.trim() }) }); msg('Coin withdrawal marked sent.'); await loadAll(); } catch (e) { msg(e.message, true); }
}
async function rejectCoinWithdrawal(d) {
  if (!confirm('Reject this coin withdrawal and return the coins to the member?')) return;
  try { await api('/api/admin/coin-withdrawals/' + encodeURIComponent(d.id) + '/reject', { method: 'POST', body: '{}' }); msg('Coin withdrawal rejected and refunded.'); await loadAll(); } catch (e) { msg(e.message, true); }
}

async function loadDeposits() {
  const rows = await api('/api/admin/deposits'); setBadge('depBadge', rows.length);
  $('deposits').innerHTML = rows.length ? rows.map(d => `<div class="item"><div class="item-top"><div><div class="item-title">${money(d.amount)} USDT • ${esc(d.network)}</div><div class="muted">${who(d)} • ${date(d.createdAt)}</div></div><b>PENDING</b></div><div class="muted">TX Hash: ${esc(d.txHash)} ${copyBtn(d.txHash)}</div><div class="actions"><button class="primary" data-act="approveDeposit" data-id="${esc(d.id)}">Approve &amp; Credit</button><button class="danger" data-act="rejectDeposit" data-id="${esc(d.id)}">Reject</button></div></div>`).join('') : '<div class="empty">No pending deposits.</div>';
}
async function approveDeposit(d) {
  if (!confirm('Verify this deposit and credit the exact USDT amount?')) return;
  try { await api('/api/admin/deposits/' + encodeURIComponent(d.id) + '/approve', { method: 'POST', body: '{}' }); msg('Deposit verified and credited.'); await loadAll(); } catch (e) { msg(e.message, true); }
}
async function rejectDeposit(d) {
  if (!confirm('Reject this deposit?')) return;
  try { await api('/api/admin/deposits/' + encodeURIComponent(d.id) + '/reject', { method: 'POST', body: '{}' }); msg('Deposit rejected.'); await loadAll(); } catch (e) { msg(e.message, true); }
}

async function searchUsers() {
  try {
    const rows = await api('/api/admin/users?q=' + encodeURIComponent($('userQuery').value.trim()));
    $('users').innerHTML = rows.length ? rows.map(u => `<div class="item">${u.isBlocked ? '<b style="color:#ff5c5c">BLOCKED</b>' : ''}<div class="item-title">${esc(u.firstName || u.username || 'Member')} ${u.username ? '(@' + esc(u.username) + ')' : ''}</div><div class="muted">ID: ${esc(u.id)} • VIP: ${u.vipLevel ? 'VIP ' + esc(u.vipLevel) : 'None'} • Referrals ${esc(u.referralCount)}<br>CJP: ${money(u.cjpBalance)} • USDT: ${money(u.usdtBalance)} • Deposit-backed: ${money(u.depositUsdtBalance)} • Swap-backed: ${money(u.swapUsdtBalance)}</div><div class="edit-grid"><label>CJP Balance<input id="cjp_${esc(u.id)}" type="number" step="0.000001" value="${money(u.cjpBalance)}" data-orig="${money(u.cjpBalance)}"></label><label>USDT Balance<input id="usdt_${esc(u.id)}" type="number" step="0.000001" value="${money(u.usdtBalance)}" data-orig="${money(u.usdtBalance)}"></label><label>VIP Level (0-5)<input id="vip_${esc(u.id)}" type="number" min="0" max="5" step="1" value="${esc(u.vipLevel)}" data-orig="${esc(u.vipLevel)}"></label></div><div class="actions"><button class="primary" data-act="saveUser" data-id="${esc(u.id)}">Save User</button>${u.isBlocked ? `<button class="primary" data-act="unblockUser" data-id="${esc(u.id)}">Unblock</button>` : `<button class="danger" data-act="blockUser" data-id="${esc(u.id)}">Block (Fake/Spam)</button>`}</div></div>`).join('') : '<div class="empty">No users found.</div>';
  } catch (e) { msg(e.message, true); }
}
async function saveUser(d) {
  try {
    const id = d.id, body = {};
    for (const [field, prefix] of [['cjpBalance', 'cjp_'], ['usdtBalance', 'usdt_'], ['vipLevel', 'vip_']]) {
      const el = $(prefix + id); // send ONLY fields the admin actually changed, so stale values never overwrite fresh balances
      if (el && Number(el.value) !== Number(el.dataset.orig)) body[field] = Number(el.value);
    }
    if (!Object.keys(body).length) { msg('No changes to save.'); return; }
    await api('/api/admin/users/' + encodeURIComponent(id) + '/update', { method: 'POST', body: JSON.stringify(body) });
    msg('User updated.'); await searchUsers(); await loadStats();
  } catch (e) { msg(e.message, true); }
}
async function blockUser(d) {
  if (!confirm('Block this user? They will no longer be able to earn, deposit, swap or withdraw.')) return;
  try { await api('/api/admin/users/' + encodeURIComponent(d.id) + '/block', { method: 'POST', body: '{}' }); msg('User blocked.'); await searchUsers(); } catch (e) { msg(e.message, true); }
}
async function unblockUser(d) {
  try { await api('/api/admin/users/' + encodeURIComponent(d.id) + '/unblock', { method: 'POST', body: '{}' }); msg('User unblocked.'); await searchUsers(); } catch (e) { msg(e.message, true); }
}

async function loadSettings() {
  const s = await api('/api/admin/settings');
  const items = [
    ['channelJoinEnabled', 'Channel Join', 'Lifetime +100 points task'],
    ['dailyCheckinEnabled', 'Daily Check-in', '+10 points/day, growing with streak - once per calendar day'],
    ['miningEnabled', 'Mining', 'Every 8 hours: 100 points non-VIP, 200-1,500 by VIP level'],
    ['referralLeaderboardEnabled', 'Monthly Top Referrers', 'Top 10 VIP-referrers of the month win points (paid on the 1st, UTC)'],
    ['gamesEnabled', 'Spin Game', 'Free spins by VIP level (1-10 per day), extra spins 0.1 USDT (10 for 0.9)'],
    ['vipDailyUsdtEnabled', 'VIP Daily USDT', 'VIP members claim 10% of their plan price per month as daily USDT'],
    ['coinExchangeEnabled', 'CJP Coin Exchange', 'Points -> CJP coin (min 100,000 points, released over 90 days)']
  ];
  $('settings').innerHTML = items.map(([k, n, d]) => `<div class="setting"><div><b>${esc(n)}</b><span>${esc(d)}</span></div><button class="toggle ${s[k] !== false ? 'on' : 'off'}" data-act="toggleSetting" data-key="${esc(k)}" data-val="${s[k] === false}">${s[k] !== false ? 'ON' : 'OFF'}</button></div>`).join('');
}
async function toggleSetting(d) {
  try { await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ [d.key]: d.val === 'true' }) }); msg('Setting updated.'); await loadSettings(); } catch (e) { msg(e.message, true); }
}

async function loadProofs() {
  const rows = await api('/api/admin/completed-withdrawals');
  $('proofs').innerHTML = rows.length ? rows.map(w => `<div class="item"><div class="item-top"><div><div class="item-title">${money(w.netAmount != null ? w.netAmount : w.amount)} USDT • ${esc(w.network)}</div><div class="muted">${who(w)} • ${date(w.completedAt)}</div></div>${w.hiddenFromProof ? '<b style="color:#ff5c5c">HIDDEN</b>' : '<b style="color:#48c774">VISIBLE</b>'}</div><div class="muted">TX Hash: ${esc(w.txHash || 'None')} ${w.txHash ? copyBtn(w.txHash) : ''}</div><div class="actions">${w.hiddenFromProof ? `<button class="primary" data-act="toggleProof" data-id="${esc(w.id)}">Restore to Proof Page</button>` : `<button class="danger" data-act="toggleProof" data-id="${esc(w.id)}">Hide from Proof Page</button>`}</div></div>`).join('') : '<div class="empty">No completed withdrawals yet.</div>';
}
async function toggleProof(d) {
  try { await api('/api/admin/withdrawals/' + encodeURIComponent(d.id) + '/toggle-proof', { method: 'POST', body: '{}' }); await loadProofs(); } catch (e) { msg(e.message, true); }
}

async function loadRefBoard() {
  const d = await api('/api/admin/referral-leaderboard'), who = r => `${esc(r.name || 'Member')}${r.username ? ' (@' + esc(r.username) + ')' : ''} • ID ${esc(r.id || r.userId)}`;
  const cur = d.current.length ? d.current.map((r, i) => `<div class="item"><b>#${i + 1}</b> ${who(r)} <span class="muted">• ${esc(r.count)} VIP referrals${i < d.rewards.length && r.count >= d.minReferrals ? ' • reward ' + esc(d.rewards[i]) + ' points' : ''}</span></div>`).join('') : '<div class="empty">No referrals this month yet.</div>';
  const hist = d.history.length ? d.history.map(h => `<div class="item"><b>${esc(h.month)}</b>${h.skipped ? ' <span class="muted">(feature was off - nothing paid)</span>' : ''}<div class="muted">${h.winners.length ? h.winners.map(w => `#${esc(w.rank)} ${who(w)} • ${esc(w.count)} VIP refs • +${esc(w.points != null ? w.points + ' points' : w.usdt + ' USDT')}`).join('<br>') : 'No qualified winners (min ' + esc(d.minReferrals) + ' VIP referrals)'}</div></div>`).join('') : '<div class="empty">No finished months yet.</div>';
  $('refBoard').innerHTML = `<div class="muted">Month ${esc(d.month)} • rewards ${d.rewards.map(esc).join(' / ')} points • min ${esc(d.minReferrals)} VIP referrals</div>${cur}<h3>Past months</h3>${hist}`;
}
async function loadAll() {
  try { await Promise.all([loadStats(), loadRefBoard(), loadWithdrawals(), loadCoinWithdrawals(), loadDeposits(), loadSettings(), loadProofs(), searchUsers()]); }
  catch (e) { msg(e.message, true); if (/authorization/i.test(e.message)) { sessionStorage.removeItem('cjp_admin_key'); key = ''; location.reload(); } }
}
async function copyText(text) { try { await navigator.clipboard.writeText(text); msg('Copied to clipboard.'); } catch { prompt('Copy manually:', text); } }

async function downloadBackup() {
  try {
    const r = await fetch('/api/admin/backup/export', { headers: { 'X-Admin-Key': key } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Download failed'); }
    const url = URL.createObjectURL(await r.blob()), a = document.createElement('a');
    a.href = url; a.download = `cjp-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); msg('Backup downloaded.');
  } catch (e) { msg(e.message, true); }
}
async function copyToNeon() {
  const connStr = $('neonConnStr').value.trim();
  if (!connStr) { $('neonCopyResult').innerHTML = '<b style="color:#ff5c5c">Paste the connection string first.</b>'; return; }
  if (!confirm('Copy the current live database to this new connection string?\n\nThis does NOT switch the app over yet - you still need to update DATABASE_URL in Render afterward.')) return;
  $('neonCopyResult').textContent = 'Copying... please wait, do not close this page.';
  try {
    const data = await api('/api/admin/copy-to-neon', { method: 'POST', body: JSON.stringify({ connectionString: connStr }) });
    $('neonCopyResult').innerHTML = `<b style="color:#48c774">${esc(data.message)}</b><br>Copied: ${esc(data.counts.users)} users, ${esc(data.counts.deposits)} deposits, ${esc(data.counts.withdrawals)} withdrawals, ${esc(data.counts.subscriptions)} subscriptions, ${esc(data.counts.ledger)} ledger entries.`;
  } catch (e) { $('neonCopyResult').innerHTML = `<b style="color:#ff5c5c">${esc(e.message)}</b>`; }
}
async function runMigration() {
  $('migrationResult').textContent = 'Checking...';
  try {
    const data = await api('/api/admin/run-migration-once', { method: 'POST', body: '{}' });
    const c = data.counts;
    $('migrationResult').innerHTML = `<b style="color:#48c774">${esc(data.message)}</b><br>Rows: ${esc(c.users)} users, ${esc(c.subscriptions)} subscriptions, ${esc(c.deposits)} deposits, ${esc(c.withdrawals)} withdrawals, ${esc(c.taskClaims)} task claims, ${esc(c.ledger)} ledger entries.`;
  } catch (e) { $('migrationResult').innerHTML = `<b style="color:#ff5c5c">${esc(e.message)}</b>`; }
}

function showAdminTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  $('tab-' + name)?.classList.add('active'); document.querySelector(`.tab-btn[data-tab="${name}"]`)?.classList.add('active');
}

// Single delegated click handler: the page has no inline onclick attributes (and the CSP forbids them).
const ACTIONS = { copy: d => copyText(d.copy), completeWithdrawal, rejectWithdrawal, completeCoinWithdrawal, rejectCoinWithdrawal, loadCoinWithdrawals, approveDeposit, rejectDeposit, saveUser, blockUser, unblockUser, toggleSetting, toggleProof,
  searchUsers, loadDeposits, loadWithdrawals, loadProofs, runMigration, copyToNeon, downloadBackup };
document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); const fn = el && ACTIONS[el.dataset.act]; if (fn) fn(el.dataset); });
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => showAdminTab(b.dataset.tab)));
$('loginBtn').addEventListener('click', login);
$('adminKey').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
$('logout').addEventListener('click', () => { sessionStorage.removeItem('cjp_admin_key'); key = ''; location.reload(); });
if (key) api('/api/admin/stats').then(() => { showPanel(); loadAll(); }).catch(() => { sessionStorage.removeItem('cjp_admin_key'); key = ''; });
