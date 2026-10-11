const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
let user = null, config = null, depositAddresses = {};
let resetAt = 0, mineReadyAt = 0, refreshing = false, spinning = false, wheelRot = 0, toastTimer = null;
const FALLBACK_PLANS = {
  1: { price: 10, miningPoints: 200, spinsPerDay: 2, dailyUsdt: 0.033333 }, 2: { price: 25, miningPoints: 300, spinsPerDay: 3, dailyUsdt: 0.083333 },
  3: { price: 50, miningPoints: 500, spinsPerDay: 5, dailyUsdt: 0.166666 }, 4: { price: 100, miningPoints: 750, spinsPerDay: 7, dailyUsdt: 0.333333 },
  5: { price: 250, miningPoints: 1500, spinsPerDay: 10, dailyUsdt: 0.833333 }
};
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(n) { return Number(n || 0).toFixed(6).replace(/\.?0+$/, ''); }
function initData() { return tg?.initData || ''; }

// One global message area (works on every tab, unlike a per-tab element).
function toast(text, kind = '') {
  const el = $('toast'); if (!el) return;
  el.textContent = text || ''; el.className = 'toast ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}
window.addEventListener('error', e => { console.error('Uncaught error:', e.error || e.message); toast('App error: ' + String(e.message || 'unknown').slice(0, 120), 'err'); });

async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (initData()) headers['X-Telegram-Init-Data'] = initData();
  const r = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}
async function action(url, body = {}) {
  try {
    const data = await api(url, { method: 'POST', body: JSON.stringify({ ...body, initData: initData() }) });
    if (data.user) { user = data.user; syncTimes(); render(); }
    toast(data.message || 'Done', data.ok === false ? '' : 'ok');
    return data;
  } catch (e) { toast(e.message, 'err'); throw e; }
}

function syncTimes() { resetAt = Date.now() + Number(user?.resetInMs || 0); mineReadyAt = Date.now() + Number(user?.miningWaitMs || 0); }
function miniAppBase() { return String(config?.miniAppUrl || `https://t.me/${String(config?.botUsername || 'Cjp_Earnig_Bot').replace('@', '')}`).replace(/\/$/, ''); }
function referralLink() { return `${miniAppBase()}?startapp=ref_${encodeURIComponent(user?.id || '')}`; }
const features = () => config?.features || { mining: true, games: true, dailyCheckin: true, channelJoin: true };

// ───────────── Rendering ─────────────
function renderPlans() {
  if (!$('plans')) return;
  const plans = config?.plans || FALLBACK_PLANS, owned = Number(user?.vipLevel || 0), refundPct = Number(config?.vipUpgradeRefundPercent ?? 100);
  $('plans').innerHTML = Object.entries(plans).map(([level, plan]) => {
    const lvl = Number(level), isCurrent = lvl === owned, locked = lvl < owned;
    const label = isCurrent ? 'Current VIP' : locked ? 'Lower Tier' : (owned > 0 ? 'Upgrade to VIP ' + level : 'Buy VIP ' + level);
    const bonus = (!isCurrent && !locked && owned > 0) ? `<div class="muted" style="color:#ffbd3e">Upgrade VIP Bonus: ${refundPct}% USDT on current VIP</div>` : '';
    return `<div class="plan"><div class="plan-top"><b>VIP ${level}</b><span>${plan.price} USDT</span></div><div class="price">⛏ ${Number(plan.miningPoints).toLocaleString()} points / 8h claim</div><div class="muted">${plan.spinsPerDay} free spins/day • +${Number(plan.dailyUsdt).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDT daily claim • Permanent VIP</div>${bonus}<button ${(isCurrent || locked) ? 'disabled' : ''} onclick="subscribeVip(${lvl})">${label}</button></div>`;
  }).join('');
}

function render() {
  if (!config) return;
  renderPlans();
  if (!user) return;
  const level = Number(user.vipLevel || 0), active = level > 0;
  const set = (id, v) => { if ($(id)) $(id).textContent = v; };
  set('profileName', user.firstName || user.username || 'CJP Member');
  set('profileVip', active ? `VIP ${level}` : 'NON-VIP'); set('vipBadge', active ? `VIP ${level}` : 'NON-VIP');
  if ($('refCode')) { const link = referralLink(); $('refCode').textContent = link; $('refCode').href = link; }
  const cjp = Number(user.cjpBalance || 0), usdt = Number(user.usdtBalance || 0), refs = Number(user.referralCount || 0);
  set('cjpBalance', Math.floor(cjp).toLocaleString()); set('walletCjp', Math.floor(cjp).toLocaleString());
  set('usdtBalance', money(usdt)); set('walletUsdt', money(usdt)); set('refCount', refs); set('refCount2', refs);
  if ($('vipInfo')) $('vipInfo').innerHTML = active
    ? `<b>VIP ${level} ACTIVE</b><br>Permanent VIP<br><span class="muted">Spent on current VIP: ${money(user.vipDepositUsdt)} USDT • Remaining verified deposit available for upgrades: ${money(user.depositUsdtBalance)} USDT</span>`
    : '<b>NON-VIP</b><br><span class="muted">Choose any VIP level below. VIP requires verified deposited USDT. USDT earned from tasks, spins and daily claims can be withdrawn but cannot be used to buy VIP.</span>';

  // Mining (one claim every 8 hours)
  const f = features();
  const ready = Date.now() >= mineReadyAt, reward = Number(user.miningReward || 0).toLocaleString();
  set('miningReward', `+${reward}`);
  set('miningDesc', `Claim ${reward} points every ${config?.miningCooldownHours || 8} hours${active ? ` (VIP ${level} rate)` : ''}.`);
  if ($('mineBtn')) { $('mineBtn').disabled = !ready || !f.mining; $('mineBtn').textContent = !f.mining ? 'Mining disabled' : ready ? `\u26cf Claim +${reward} points` : 'Cooling down\u2026'; }
  $('minerIcon')?.classList.toggle('active', ready && f.mining);
  tick();

  // Spin game
  const left = Number(user.spinsLeft || 0), free = Number(user.freeSpinsLeft || 0), extra = Number(user.extraSpins || 0);
  const shop = config?.spinShop || { price: 0.1, packSize: 10, packPrice: 0.9 };
  set('spinsLeft', String(left));
  if ($('spinInfo')) $('spinInfo').innerHTML = f.games
    ? `<span class="pill ${free ? 'ready' : ''}">🎁 Free spins today: <b>${free}/${Number(user.spinsPerDay || 1)}</b></span><span class="pill">⚡ Extra spins: <b>${extra}</b></span>`
    : '<span class="pill">Games are temporarily disabled.</span>';
  if ($('spinBtn')) { $('spinBtn').disabled = spinning || left <= 0 || !f.games; $('spinBtn').textContent = spinning ? 'Spinning…' : left <= 0 ? 'No spins left' : `SPIN (${left} left)`; }
  if ($('buySpin1')) { $('buySpin1').innerHTML = `<b>Buy 1 spin</b><small>${shop.price} USDT</small>`; $('buySpin1').disabled = spinning || !f.games; }
  if ($('buySpin10')) { $('buySpin10').innerHTML = `<span class="shop-badge">SAVE ${money(shop.price * shop.packSize - shop.packPrice)}</span><b>Buy ${shop.packSize} spins</b><small>${shop.packPrice} USDT</small>`; $('buySpin10').disabled = spinning || !f.games; }
  if ($('gameBtn')) $('gameBtn').disabled = !f.games;

  // Daily check-in
  const nextReward = Number(user.nextDailyReward || 10);
  [$('dailyBtn'), $('taskDailyBtn')].filter(Boolean).forEach(b => {
    b.disabled = !!user.dailyClaimed || !f.dailyCheckin;
    b.textContent = user.dailyClaimed ? `Claimed (Day ${user.dailyStreak || 0} streak)` : (b.id === 'dailyBtn' ? `✓ Daily Check-in +${nextReward} points` : `+${nextReward} points`);
  });
  [$('taskBtn'), $('taskBtn2')].filter(Boolean).forEach(b => { b.disabled = !!user.joinChannelClaimed || !f.channelJoin; b.textContent = user.joinChannelClaimed ? 'Claimed' : '+100 points'; });
  const chatBtn = $('taskChatBtn');
  if (chatBtn) { const ok = !!config?.chat; chatBtn.disabled = !!user.joinChatClaimed || !ok; chatBtn.textContent = user.joinChatClaimed ? 'Claimed' : (ok ? '+100 points' : 'Not configured'); }

  const vipRefs = Number(user.vipReferralCount || 0), nvRefs = Number(user.nonVipReferralCount || 0);
  Object.entries(config?.referralMilestones || {}).forEach(([taskId, m]) => {
    const key = taskId.replace('referral_milestone_', 'milestone').replace('referral_nonvip_', 'milestoneNv');
    const btn = $(key + 'Btn'), desc = $(key + 'Desc');
    if (!btn) return;
    const have = m.kind === 'vip' ? vipRefs : nvRefs, label = m.kind === 'vip' ? 'VIP' : 'non-VIP', claimed = !!user.milestoneClaims?.[taskId];
    btn.disabled = claimed || have < m.count;
    btn.textContent = claimed ? 'Claimed' : `${Number(m.points).toLocaleString()} pts${m.usdt > 0 ? ` + ${m.usdt} USDT` : ''}`;
    if (desc) desc.textContent = claimed ? `Completed \u2014 ${m.count} ${label} referrals reached` : `${Math.min(have, m.count)}/${m.count} ${label} referrals`;
  });

  // VIP daily USDT (Tasks)
  if ($('vipDailyBtn')) {
    const can = active && f.vipDailyUsdt && !user.vipDailyUsdtClaimed;
    $('vipDailyBtn').disabled = !can;
    $('vipDailyBtn').textContent = !active ? 'VIP only' : user.vipDailyUsdtClaimed ? 'Claimed today' : `+${Number(user.vipDailyUsdt).toLocaleString('en-US', { maximumFractionDigits: 6 })} USDT`;
  }
  set('vipDailyDesc', active ? `${config?.vipDailyUsdt?.monthlyPercent || 10}% of your VIP price per month, claim once a day` : 'Become VIP to claim USDT every day');

  // CJP coin card (Wallet)
  const coin = config?.coin || { pointsPerCoin: 1000, minExchangePoints: 100000, days: 90, withdrawOpenAt: '2027-01-01T00:00:00.000Z', withdrawMin: 1 };
  const withdrawOpen = Date.now() >= Date.parse(coin.withdrawOpenAt);
  set('coinBalance', money(user.coinBalance)); set('coinClaimable', money(user.coinClaimable)); set('coinLocked', Math.floor(Number(user.coinLockedPoints || 0)).toLocaleString());
  set('coinNote', `${Number(coin.pointsPerCoin).toLocaleString()} points = 1 CJP coin \u2022 min ${Number(coin.minExchangePoints).toLocaleString()} points \u2022 released over ${coin.days} days`);
  if ($('coinExchangeBtn')) { $('coinExchangeBtn').disabled = !f.coinExchange || cjp < coin.minExchangePoints; $('coinExchangeBtn').textContent = 'Exchange points'; }
  if ($('coinClaimBtn')) {
    const can = Number(user.coinClaimable) > 0 && !user.coinClaimedToday;
    $('coinClaimBtn').disabled = !can;
    $('coinClaimBtn').textContent = user.coinClaimedToday ? 'Claimed today' : can ? `Claim ${money(user.coinClaimable)}` : 'Nothing to claim';
  }
  if ($('coinWithdrawBtn')) $('coinWithdrawBtn').disabled = !withdrawOpen || Number(user.coinBalance) < Number(coin.withdrawMin);
  set('coinWithdrawNote', withdrawOpen ? `Withdraw to your Tonkeeper wallet (min ${coin.withdrawMin} coin)` : `CJP coin withdrawals open on ${new Date(coin.withdrawOpenAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`);
}

// Live countdown: mining is ready every 8 hours, spins / daily claims refresh at the 00:00 UTC reset.
function tick() {
  if (!user) return;
  const f = features(), now = Date.now();
  if ($('miningTimer')) {
    const left = Math.max(0, mineReadyAt - now), cd = Number(config?.miningCooldownHours || 8) * 3600000;
    if (f.mining && left > 0) {
      const h = Math.floor(left / 3600000), m = Math.floor(left % 3600000 / 60000), sec = Math.floor(left % 60000 / 1000);
      $('miningTimer').textContent = `Next mining in ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      $('miningBarFill').classList.remove('ready'); $('miningBarFill').style.width = `${Math.min(100, (1 - left / cd) * 100)}%`;
    } else {
      $('miningTimer').textContent = f.mining ? 'Ready to claim!' : 'Mining is temporarily disabled.';
      $('miningBarFill').classList.toggle('ready', f.mining); $('miningBarFill').style.width = f.mining ? '100%' : '0';
      if (f.mining && $('mineBtn')?.disabled) render(); // the cooldown just ended: enable the button
    }
  }
  if (resetAt && now >= resetAt && !refreshing) { refreshing = true; refreshUser().finally(() => { refreshing = false; }); }
}
setInterval(tick, 1000);

async function bootstrap() {
  config = await api('/api/config');
  buildWheel(); render();
  await loadAddresses();
  const params = new URLSearchParams(location.search);
  const ref = tg?.initDataUnsafe?.start_param || params.get('ref') || params.get('startapp') || '';
  const data = await api('/api/bootstrap', { method: 'POST', body: JSON.stringify({ ref, initData: initData() }) });
  user = data.user; syncTimes(); render(); checkWithdrawStatus();
}
async function refreshUser() {
  try { const data = await api('/api/me'); user = data.user || user; syncTimes(); render(); } catch { /* ignore */ }
}

// ───────────── Mining ─────────────
function claimMining() { action('/api/mine').catch(() => {}); }

// ───────────── Spin game ─────────────
const SLOT_COLORS = [['#2a1646', '#5a3490'], ['#0f2a4a', '#2a63a8'], ['#0c3b47', '#1f8aa0'], ['#4a2c08', '#a9691a'], ['#4a1717', '#a83a3a'], ['#1f1f55', '#4a4ab0']];
const SLOT_SPIN = ['#0c4a22', '#27a355'], SLOT_BIG = ['#6b4a00', '#ffc83d'];
function buildWheel() {
  const prizes = config?.spinPrizes || [], n = prizes.length;
  if (!n || !$('wheel')) return;
  const seg = 360 / n;
  const pt = (deg, r) => { const a = deg * Math.PI / 180; return [(r * Math.sin(a)).toFixed(2), (-r * Math.cos(a)).toFixed(2)]; };
  let defs = '<defs>', body = '';
  prizes.forEach((p, i) => {
    const [c0, c1] = p.usdt ? SLOT_SPIN : (p.cjp >= 500 ? SLOT_BIG : SLOT_COLORS[i % SLOT_COLORS.length]);
    defs += `<radialGradient id="sg${i}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="100"><stop offset="0.15" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></radialGradient>`;
    const [x0, y0] = pt(i * seg, 100), [x1, y1] = pt((i + 1) * seg, 100);
    body += `<path d="M0 0 L${x0} ${y0} A100 100 0 0 1 ${x1} ${y1} Z" fill="url(#sg${i})" stroke="#ffd166" stroke-width="0.8"/>`;
    const rot = `rotate(${i * seg + seg / 2}) translate(0,-66)`, st = 'stroke="#000" stroke-width="2.4" paint-order="stroke" stroke-linejoin="round"';
    if (p.usdt) body += `<g transform="${rot}" text-anchor="middle" fill="#fff" font-weight="900"><text y="-1" font-size="10" ${st}>${p.usdt}</text><text y="8" font-size="6.5" letter-spacing="0.4" ${st}>USDT</text></g>`;
    else body += `<text transform="${rot}" text-anchor="middle" fill="${p.cjp >= 500 ? '#fff6c8' : '#fff'}" font-size="${String(p.cjp).length > 3 ? 12 : 15}" font-weight="900" ${st}>${p.cjp}</text>`;
  });
  defs += '<radialGradient id="hub" cx="35%" cy="30%"><stop offset="0" stop-color="#fff0b0"/><stop offset="1" stop-color="#c47f0a"/></radialGradient></defs>';
  const hub = '<circle r="15" fill="#120d03" stroke="#ffd166" stroke-width="2"/><circle r="10.5" fill="url(#hub)"/><text y="4.5" text-anchor="middle" font-size="12" font-weight="900" fill="#3a2500">★</text>';
  $('wheel').innerHTML = `<svg viewBox="-100 -100 200 200" xmlns="http://www.w3.org/2000/svg">${defs}${body}${hub}</svg>`;
  if ($('wheelLights')) {
    let l = '<defs><linearGradient id="band" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe08a"/><stop offset=".5" stop-color="#c47f0a"/><stop offset="1" stop-color="#ffd166"/></linearGradient></defs><circle r="114" fill="none" stroke="url(#band)" stroke-width="12"/><circle r="119.5" fill="none" stroke="#1a1203" stroke-width="1.5"/>';
    for (let i = 0; i < 24; i++) { const [x, y] = pt(i * 15, 114); l += `<circle class="bulb b${i % 2}" cx="${x}" cy="${y}" r="2.6" fill="#fff4c2"/>`; }
    $('wheelLights').innerHTML = l;
  }
  if ($('prizeList')) $('prizeList').innerHTML = prizes.map(p => p.usdt
    ? `<span class="prize-chip spin">\ud83d\udcb5 +${p.usdt} USDT</span>`
    : `<span class="prize-chip ${p.cjp >= 500 ? 'big' : ''}">${p.cjp === 0 ? 'Try again' : '+' + p.cjp + ' pts'}</span>`).join('');
}
function openBuySpins(pack) {
  if (spinning || !user) return;
  const shop = config?.spinShop || { price: 0.1, packSize: 10, packPrice: 0.9 };
  const count = pack === 1 ? 1 : shop.packSize, price = pack === 1 ? shop.price : shop.packPrice;
  const bal = Number(user.usdtBalance || 0), enough = bal >= price;
  $('modalTitle').textContent = 'Buy Spins';
  $('modalBody').innerHTML = `<div class="buy-box"><div class="buy-ico">\ud83c\udf9f</div><div class="buy-main"><b>${count} spin${count > 1 ? 's' : ''}</b><span>${price} USDT${count > 1 ? ` \u2022 ${money(price / count)} USDT per spin` : ''}</span></div></div>`
    + `<div class="muted modal-note">Your USDT balance: <b>${money(bal)} USDT</b>${enough ? ` \u2022 after purchase: <b style="color:#ffbd3e">${money(bal - price)} USDT</b>` : ''}</div>`
    + (enough ? '' : `<div class="modal-note" style="color:#ff5c5c">You need ${price} USDT to buy ${count} spin${count > 1 ? 's' : ''}. Deposit USDT in the Wallet tab.</div>`)
    + `<button id="confirmBuySpin" class="wide" ${enough ? '' : 'disabled'}>Confirm Purchase</button><div id="buyNotice" class="muted modal-note"></div>`;
  $('modal').classList.remove('hidden');
  if (enough) $('confirmBuySpin').onclick = async () => {
    const btn = $('confirmBuySpin'); btn.disabled = true;
    try {
      const data = await action('/api/spin/buy', { pack });
      $('buyNotice').innerHTML = `<b style="color:#48c774">${esc(data.message || 'Spins added.')}</b>`;
      btn.textContent = 'Spin Now'; btn.disabled = false; btn.onclick = () => $('modal').classList.add('hidden');
    } catch (e) { $('buyNotice').innerHTML = `<b style="color:#ff5c5c">${esc(e.message)}</b>`; btn.disabled = false; }
  };
}
function showSpinResult(data) {
  const win = data.prize > 0, usdt = data.usdtWon > 0, left = Number(user?.spinsLeft || 0);
  const ico = win ? (data.prize >= 500 ? '\ud83d\udc8e' : '\ud83c\udf89') : usdt ? '\ud83d\udcb5' : '\ud83d\ude05';
  const title = win ? `+${data.prize.toLocaleString()} points` : usdt ? `+${data.usdtWon} USDT` : 'Try again!';
  const sub = win ? 'Added to your CJP points' : usdt ? 'Added to your USDT balance' : 'No luck this time';
  $('modalTitle').textContent = win || usdt ? 'You Won!' : 'Spin Result';
  $('modalBody').innerHTML = `<div class="res-pop"><div class="res-ico">${ico}</div><div class="res-title">${title}</div><div class="res-sub">${sub}</div></div><button id="resAgain" class="wide">${left > 0 ? `Spin Again (${left} left)` : 'OK'}</button>${left > 0 ? '' : '<div class="muted modal-note center">Out of spins? Buy more below the wheel.</div>'}`;
  $('modal').classList.remove('hidden');
  $('resAgain').onclick = () => { $('modal').classList.add('hidden'); if (left > 0) spin(); };
}
async function spin() {
  if (spinning || !user) return;
  if (Number(user.spinsLeft) <= 0) { toast('No spins left. Free spins reset at 00:00 UTC, or buy more spins.'); return; }
  spinning = true; $('wheel')?.parentElement?.classList.add('is-spinning'); render();
  try {
    const data = await api('/api/spin', { method: 'POST', body: JSON.stringify({ initData: initData() }) });
    if (!data.ok) { if (data.user) user = data.user; spinning = false; $('wheel')?.parentElement?.classList.remove('is-spinning'); render(); toast(data.message, ''); return; }
    const n = config.spinPrizes.length, seg = 360 / n;
    const target = data.index * seg + seg / 2 + (Math.random() - 0.5) * seg * 0.6; // land somewhere inside the winning segment
    wheelRot = wheelRot + 360 * 5 + (((360 - target) - (wheelRot % 360)) + 720) % 360;
    $('wheel').style.transform = `rotate(${wheelRot}deg)`;
    await sleep(4700);
    user = data.user; syncTimes(); spinning = false; render();
    $('wheel')?.parentElement?.classList.remove('is-spinning'); showSpinResult(data);
  } catch (e) { spinning = false; $('wheel')?.parentElement?.classList.remove('is-spinning'); render(); toast(e.message, 'err'); }
}

// ───────────── Tasks ─────────────
function openTg(handle) { const url = `https://t.me/${String(handle).replace('@', '')}`; if (tg?.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank'); }
function joinChannel() { openTg(config?.channel || '@CJPEarningOfficial'); toast('Verifying your membership in a few seconds…'); setTimeout(() => action('/api/task', { taskId: 'join_channel' }).catch(() => {}), 4000); }
function joinChat() { if (!config?.chat) { toast('Chat Join task is not configured yet.'); return; } openTg(config.chat); toast('Verifying your membership in a few seconds…'); setTimeout(() => action('/api/task', { taskId: 'join_chat' }).catch(() => {}), 4000); }
function claimMilestone(taskId) { if (taskId) action('/api/task', { taskId }).catch(() => {}); }

// ───────────── Modals ─────────────
// ───────────── CJP coin: exchange points -> coin, daily claim, withdraw to a TON wallet ─────────────
function openCoinExchange() {
  if (!user || !config) return;
  const c = config.coin, bal = Math.floor(Number(user.cjpBalance || 0));
  $('modalTitle').textContent = 'Exchange points \u2192 CJP coin';
  $('modalBody').innerHTML = `<div class="muted modal-note">${Number(c.pointsPerCoin).toLocaleString()} points = 1 CJP coin. Minimum <b>${Number(c.minExchangePoints).toLocaleString()}</b> points. The coins are released <b>gradually over ${c.days} days</b> and you can claim what has been mined once a day.</div>`
    + `<label>Points to exchange</label><input id="exPoints" type="number" min="${c.minExchangePoints}" step="1" placeholder="${Number(c.minExchangePoints)}">`
    + `<div id="exPreview" class="muted modal-note">Available: ${bal.toLocaleString()} points</div><button id="exConfirm" class="wide">Start exchange</button><div id="exNotice" class="muted modal-note"></div>`;
  $('modal').classList.remove('hidden');
  $('exPoints').addEventListener('input', () => {
    const p = Math.floor(Number($('exPoints').value));
    $('exPreview').innerHTML = p > 0 ? `You get <b style="color:#ffbd3e">${money(p / c.pointsPerCoin)} CJP coin</b> \u2022 about ${money(p / c.pointsPerCoin / c.days)} coin per day for ${c.days} days` : `Available: ${bal.toLocaleString()} points`;
  });
  $('exConfirm').onclick = async () => {
    const points = Math.floor(Number($('exPoints').value));
    if (!Number.isFinite(points) || points < c.minExchangePoints) { $('exNotice').innerHTML = `<b style="color:#ff5c5c">Minimum is ${Number(c.minExchangePoints).toLocaleString()} points.</b>`; return; }
    if (points > bal) { $('exNotice').innerHTML = '<b style="color:#ff5c5c">Not enough points.</b>'; return; }
    $('exConfirm').disabled = true;
    try { const data = await action('/api/coin/exchange', { points }); $('exNotice').innerHTML = `<b style="color:#48c774">${esc(data.message)}</b>`; $('exConfirm').remove(); loadCoinStatus(); }
    catch (e) { $('exNotice').innerHTML = `<b style="color:#ff5c5c">${esc(e.message)}</b>`; $('exConfirm').disabled = false; }
  };
}
function claimCoin() { action('/api/coin/claim').then(loadCoinStatus).catch(() => {}); }
function claimVipDaily() { action('/api/vip/daily-usdt').catch(() => {}); }
function openCoinWithdraw() {
  if (!user || !config) return;
  const c = config.coin;
  $('modalTitle').textContent = 'Withdraw CJP coin';
  $('modalBody').innerHTML = `<div class="muted modal-note">Balance: <b>${money(user.coinBalance)} CJP coin</b>. Coins are sent to your <b>Tonkeeper (TON) wallet</b> after review.</div>`
    + `<label>TON wallet address</label><input id="cwAddress" placeholder="UQ... / EQ..." autocomplete="off"><label>Amount (min ${c.withdrawMin})</label><input id="cwAmount" type="number" min="${c.withdrawMin}" step="0.000001">`
    + `<button id="cwSend" class="wide">Request withdrawal</button><div id="cwNotice" class="muted modal-note"></div>`;
  $('modal').classList.remove('hidden');
  $('cwSend').onclick = async () => {
    const address = $('cwAddress').value.trim(), amount = Number($('cwAmount').value);
    if (!address) { $('cwNotice').innerHTML = '<b style="color:#ff5c5c">Please enter your Tonkeeper wallet address.</b>'; return; }
    if (!Number.isFinite(amount) || amount < c.withdrawMin) { $('cwNotice').innerHTML = `<b style="color:#ff5c5c">Minimum is ${c.withdrawMin} CJP coin.</b>`; return; }
    $('cwSend').disabled = true;
    try { await action('/api/coin/withdraw', { address, amount }); $('modal').classList.add('hidden'); loadCoinStatus(); }
    catch (e) { $('cwNotice').innerHTML = `<b style="color:#ff5c5c">${esc(e.message)}</b>`; $('cwSend').disabled = false; }
  };
}
async function loadCoinStatus() {
  const box = $('coinList'); if (!box) return;
  try {
    const d = await api('/api/coin/status');
    const ex = d.exchanges.map(e => `<div class="hist-row"><div><b>${Number(e.points).toLocaleString()} pts \u2192 ${money(e.coinsTotal)} coin</b><div class="muted">Claimed ${money(e.claimedCoins)} / ${money(e.coinsTotal)} \u2022 ends ${new Date(e.endAt).toLocaleDateString()}</div></div><div class="hist-status hist-${e.status === 'active' ? 'processing' : 'completed'}">${esc(String(e.status).toUpperCase())}</div></div>`);
    const wd = d.withdrawals.map(w => `<div class="hist-row"><div><b>${money(w.amount)} coin withdrawal</b><div class="muted">${new Date(w.createdAt).toLocaleString()}</div></div><div class="hist-status hist-${esc(w.status)}">${esc(String(w.status).toUpperCase())}</div></div>`);
    box.innerHTML = ex.length || wd.length ? ex.concat(wd).join('') : '<div class="muted center">No exchanges yet.</div>';
  } catch { /* ignore */ }
}

function openVipPurchase(level) {
  try {
    const p = (config?.plans || FALLBACK_PLANS)[level]; if (!p) return;
    const owned = Number(user?.vipLevel || 0);
    $('modalTitle').textContent = owned > 0 ? `Upgrade to VIP ${level}` : `Buy VIP ${level}`;
    if (Number(level) <= owned) { $('modalBody').innerHTML = `<div class="muted modal-note">You already own VIP ${owned}. You can only upgrade to a higher level.</div>`; $('modal').classList.remove('hidden'); return; }
    const depositBal = Number(user?.depositUsdtBalance || 0), enough = depositBal >= Number(p.price);
    const refundPct = Number(config?.vipUpgradeRefundPercent ?? 100);
    const refundEstimate = owned > 0 ? money(Number(user?.vipDepositUsdt || 0) * refundPct / 100) : 0;
    const upgradeNote = owned > 0 ? `<div class="muted modal-note">Upgrading replaces your current VIP ${owned}. <b style="color:#ffbd3e">${refundEstimate} USDT</b> (${refundPct}% of your current VIP investment) will be refunded to your USDT balance.</div>` : '';
    $('modalBody').innerHTML = `<div class="muted modal-note">Price: <b style="color:#ffbd3e">${p.price} USDT</b> \u2022 Mining: <b>${Number(p.miningPoints).toLocaleString()} points</b> every 8h \u2022 <b>${p.spinsPerDay} free spins/day</b> \u2022 Daily USDT: <b>${Number(p.dailyUsdt).toLocaleString('en-US', { maximumFractionDigits: 6 })}</b></div>${upgradeNote}<div class="muted modal-note">Permanent VIP. Payment is deducted from your verified deposit balance.</div><div class="muted modal-note">Your verified deposit balance: <b>${money(depositBal)} USDT</b></div>${enough ? '' : `<div class="modal-note" style="color:#ff5c5c">You need ${p.price} USDT from a verified deposit to buy VIP ${level}. USDT earned from tasks, spins or daily claims cannot be used to buy VIP.</div>`}<button id="confirmVipBuy" class="wide" ${enough ? '' : 'disabled'}>Confirm ${owned > 0 ? 'Upgrade' : 'Purchase'}</button><div id="vipBuyNotice" class="muted modal-note"></div>`;
    $('modal').classList.remove('hidden');
    if (enough) $('confirmVipBuy').onclick = async () => {
      $('confirmVipBuy').disabled = true;
      try { const data = await action('/api/vip/subscribe', { level }); $('vipBuyNotice').innerHTML = `<b style="color:#48c774">${esc(data.message || 'VIP activated.')}</b>`; $('confirmVipBuy').remove(); }
      catch (e) { $('vipBuyNotice').innerHTML = `<b style="color:#ff5c5c">${esc(e.message)}</b>`; $('confirmVipBuy').disabled = false; }
    };
  } catch (e) {
    console.error('openVipPurchase error:', e);
    $('modalTitle').textContent = 'Error';
    $('modalBody').innerHTML = `<div class="modal-note" style="color:#ff5c5c">Something went wrong opening this plan: ${esc(e.message || String(e))}</div>`;
    $('modal')?.classList.remove('hidden');
  }
}
window.subscribeVip = openVipPurchase;

function copyReferral() {
  const link = referralLink();
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(() => toast('Referral link copied', 'ok')).catch(() => prompt('Copy your referral link:', link));
  else prompt('Copy your referral link:', link);
}
function shareReferral() {
  const link = referralLink(), text = 'Join CJP Earning Bot and earn CJP!';
  if (tg?.openTelegramLink) tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  else if (navigator.share) navigator.share({ title: 'CJP Earning Bot', text, url: link }).catch(() => {});
  else prompt('Copy your referral link:', link);
}
function openReferral() { const link = referralLink(); if (tg?.openTelegramLink) tg.openTelegramLink(link); else window.open(link, '_blank'); }

const CJP_HISTORY_LABELS = { daily_checkin: 'Daily Check-in', mining: 'Daily Mining', spin_reward: 'Spin Reward', referral_task: 'Referral Task', leaderboard_reward: 'Leaderboard Reward', ad_reward: 'Ad Reward (legacy)', task_join_channel: 'Task: Join Channel', task_join_chat: 'Task: Join Chat', signup_bonus: 'Signup Bonus', referral_commission: 'Referral Commission', referral_signup_bonus: 'Referral Bonus', earning: 'Earning' };
function historyDate(iso) { return iso ? new Date(iso).toLocaleString() : ''; }
function openHistory(tabName) {
  $('modalTitle').textContent = 'History';
  $('modalBody').innerHTML = `<div class="hist-tabs"><button class="small hist-tab" data-htab="deposits">Deposits</button><button class="small hist-tab" data-htab="withdrawals">Withdrawals</button><button class="small hist-tab" data-htab="cjp">CJP Earnings</button><button class="small hist-tab" data-htab="usdtbonus">USDT Bonuses</button></div><div id="historyList" class="hist-list"><div class="muted">Loading…</div></div>`;
  $('modal').classList.remove('hidden');
  document.querySelectorAll('.hist-tab').forEach(b => b.addEventListener('click', () => { document.querySelectorAll('.hist-tab').forEach(x => x.classList.remove('active')); b.classList.add('active'); loadHistoryTab(b.dataset.htab); }));
  document.querySelector(`.hist-tab[data-htab="${tabName}"]`)?.classList.add('active');
  loadHistoryTab(tabName);
}
async function loadHistoryTab(tabName) {
  const list = $('historyList'); if (!list) return; list.innerHTML = '<div class="muted">Loading…</div>';
  try {
    if (tabName === 'deposits') {
      const rows = await api('/api/my-deposits');
      list.innerHTML = rows.length ? rows.map(d => `<div class="hist-row"><div><b>${money(d.amount)} USDT</b> • ${esc(d.network)}</div><div class="muted">${historyDate(d.createdAt)}</div><div class="hist-status hist-${esc(d.status)}">${esc(String(d.status).toUpperCase())}</div></div>`).join('') : '<div class="empty">No deposits yet.</div>';
    } else if (tabName === 'withdrawals') {
      const rows = await api('/api/my-withdrawals');
      list.innerHTML = rows.length ? rows.map(w => `<div class="hist-row"><div><b>${money(w.amount)} USDT</b> requested • ${esc(w.network)}</div><div class="muted">${historyDate(w.createdAt)}${w.netAmount != null ? ` • You receive: ${money(w.netAmount)} USDT` : ''}</div><div class="hist-status hist-${esc(w.status)}">${esc(String(w.status).toUpperCase())}</div></div>`).join('') : '<div class="empty">No withdrawals yet.</div>';
    } else if (tabName === 'usdtbonus') {
      const rows = await api('/api/my-usdt-bonus-history'), L = { vip_upgrade_refund: 'VIP Upgrade Refund', referral_milestone: 'Referral Milestone Bonus', referral_leaderboard_reward: 'Monthly Top Referrer Reward', vip_daily_usdt: 'VIP Daily USDT', spin_usdt_reward: 'Spin USDT Prize' };
      list.innerHTML = rows.length ? rows.map(c => `<div class="hist-row"><div><b style="color:#48c774">+${money(c.amount)} USDT</b> • ${esc(L[c.type] || 'Bonus')}</div><div class="muted">${historyDate(c.createdAt)}</div></div>`).join('') : '<div class="empty">No USDT bonuses yet.</div>';
    } else {
      const rows = await api('/api/my-cjp-history');
      list.innerHTML = rows.length ? rows.map(c => `<div class="hist-row"><div><b>+${money(c.amount)} CJP</b> • ${esc(CJP_HISTORY_LABELS[c.meta?.reason || c.type] || 'Earning')}</div><div class="muted">${historyDate(c.createdAt)}</div></div>`).join('') : '<div class="empty">No CJP earnings yet.</div>';
    }
  } catch (e) { list.innerHTML = `<div class="empty">${esc(e.message || 'Unable to load history.')}</div>`; }
}

function openWithdraw() {
  const feePct = Number(config?.withdrawalFeePercent ?? 5), min = Number(config?.withdrawalMin ?? 0.1);
  $('modalTitle').textContent = 'Withdraw USDT';
  $('modalBody').innerHTML = `<label>Network</label><select id="wNetwork"><option>TON</option><option>TRC20</option><option>BEP20</option></select><label>Wallet address</label><input id="wAddress" placeholder="Enter receiving wallet address" autocomplete="off"><label>Amount (minimum ${min} USDT)</label><input id="wAmount" type="number" min="${min}" step="0.000001" placeholder="${min}"><div id="withdrawPreview" class="muted modal-note">A ${feePct}% withdrawal fee applies.</div><button id="sendWithdraw" class="wide">Continue</button><div id="withdrawNotice" class="muted modal-note">Enter your wallet address and amount to continue.</div>`;
  $('modal').classList.remove('hidden');
  $('wAmount').addEventListener('input', () => {
    const amount = Number($('wAmount').value);
    if (!Number.isFinite(amount) || amount <= 0) { $('withdrawPreview').textContent = `A ${feePct}% withdrawal fee applies.`; return; }
    const fee = amount * feePct / 100;
    $('withdrawPreview').innerHTML = `Fee (${feePct}%): <b>${fee.toFixed(6)} USDT</b> • You will receive: <b style="color:#ffbd3e">${(amount - fee).toFixed(6)} USDT</b>`;
  });
  $('sendWithdraw').onclick = async () => {
    const address = $('wAddress').value.trim(), amount = Number($('wAmount').value), network = $('wNetwork').value;
    if (!address) { $('withdrawNotice').innerHTML = '<b style="color:#ff5c5c">Please enter your receiving wallet address first.</b>'; return; }
    if (!Number.isFinite(amount) || amount < min) { $('withdrawNotice').innerHTML = `<b style="color:#ff5c5c">Minimum withdrawal is ${min} USDT.</b>`; return; }
    if (!Number(user?.vipLevel || 0)) {
      $('withdrawNotice').innerHTML = '<b style="color:#ffbd3e">You need to upgrade to VIP first.</b><br>Withdrawals are available only to VIP members.';
      $('sendWithdraw').textContent = 'View VIP Plans'; $('sendWithdraw').onclick = () => { showTab('vip'); $('modal').classList.add('hidden'); };
      return;
    }
    try { await action('/api/withdraw', { network, address, amount }); $('modal').classList.add('hidden'); checkWithdrawStatus(); }
    catch (e) { $('withdrawNotice').innerHTML = `<b style="color:#ff5c5c">${esc(e.message)}</b>`; }
  };
}
async function checkWithdrawStatus() {
  const el = $('walletWithdrawStatus'); if (!el) return;
  try {
    const rows = await api('/api/my-withdrawals');
    if (rows.some(w => w.status === 'processing')) { el.textContent = 'Withdraw in Processing'; el.className = 'wallet-status processing'; }
    else { el.textContent = ''; el.className = 'wallet-status hidden'; }
  } catch { /* ignore */ }
}

async function loadAddresses() {
  try { depositAddresses = await api('/api/deposit-addresses'); renderSelectedDeposit(); }
  catch (e) { if ($('selectedDeposit')) $('selectedDeposit').innerHTML = '<div class="address-card error">Unable to load deposit address. Check Render environment variables.</div>'; }
}
function renderSelectedDeposit() {
  const n = $('depNetwork')?.value || 'TON', addr = depositAddresses[n], configured = addr && addr !== 'NOT_CONFIGURED';
  if (!$('selectedDeposit')) return;
  $('selectedDeposit').innerHTML = `<div class="address-card"><div class="address-head"><div><b class="selected-network-title">USDT ${esc(n)}</b><span class="network-tag">${configured ? 'Ready' : 'Not configured'}</span></div><button class="small" id="copyAddrBtn" ${configured ? '' : 'disabled'}>Copy</button></div><div class="addr">${configured ? esc(addr) : 'Deposit address not configured yet.'}</div>${configured ? `<div class="qr-wrap"><img id="selectedQr" class="qr" alt="USDT ${esc(n)} deposit QR" src="/api/qr?data=${encodeURIComponent(addr)}"></div>` : ''}</div>`;
  if (configured) $('copyAddrBtn')?.addEventListener('click', () => window.copyText(addr));
}
window.copyText = async text => { try { await navigator.clipboard.writeText(text); toast('Address copied', 'ok'); } catch { prompt('Copy address:', text); } };

function showTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  $('tab-' + name)?.classList.add('active'); document.querySelector(`.nav-item[data-tab="${name}"]`)?.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'referral') loadReferralStats();
  if (name === 'wallet') { checkWithdrawStatus(); loadCoinStatus(); }
}
async function loadLeaderboard() {
  const box = $('refLb'); if (!box) return;
  try {
    const d = await api('/api/referral/leaderboard');
    if (!d.enabled) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const medals = ['\ud83e\udd47', '\ud83e\udd48', '\ud83e\udd49'], n = d.rewards.length, days = Math.floor(d.endsInMs / 86400000), hrs = Math.floor(d.endsInMs % 86400000 / 3600000);
    const fmt = (v, unit) => unit === 'usdt' ? `${Number(v)} USDT` : `${Number(v).toLocaleString()} pts`;
    $('lbSub').textContent = `Top ${n} members with the most VIP referrals this month win CJP points. Ends in ${days}d ${hrs}h (1st of month, 00:00 UTC). Min ${d.minReferrals} VIP referrals to win.`;
    const rows = d.rewards.map((rw, i) => {
      const t = d.top[i];
      return `<div class="lb-row ${t?.isYou ? 'you' : ''}"><span class="lb-medal">${medals[i] || '#' + (i + 1)}</span><div class="lb-who"><b>${t ? esc(t.name) : 'Open spot'}</b><span>${t ? t.count + ' VIP referral' + (t.count > 1 ? 's' : '') + (t.qualified ? '' : ` \u2022 needs ${d.minReferrals} to win`) : 'Be the first!'}</span></div><span class="lb-reward">${fmt(rw, 'points')}</span></div>`;
    }).join('');
    const me = d.me, need = d.top[n - 1] ? d.top[n - 1].count + 1 : d.minReferrals;
    const mine = `<div class="lb-me">Your VIP referrals this month: <b>${me.count}</b>${me.rank ? ` \u2022 Rank <b>#${me.rank}</b>` : ''}${me.rank && me.rank <= n ? '' : ` \u2022 ${Math.max(0, Math.max(need, d.minReferrals) - me.count)} more to reach the top ${n}`}</div>`;
    const last = d.lastMonth && d.lastMonth.winners.length ? `<div class="muted lb-last">Last month (${esc(d.lastMonth.month)}): ${d.lastMonth.winners.slice(0, 3).map(w => `${medals[w.rank - 1]} ${esc(w.name)} +${fmt(w.reward, w.unit)}`).join(' \u2022 ')}</div>` : '';
    $('lbBody').innerHTML = rows + mine + last;
  } catch { box.classList.add('hidden'); }
}
async function loadReferralStats() {
  loadLeaderboard();
  try {
    const r = await api('/api/referral');
    if ($('refTotalCjp')) $('refTotalCjp').textContent = Math.floor(Number(r.totalReferralCjp || 0)).toLocaleString();
    if ($('refBreakdown')) $('refBreakdown').innerHTML = `Referral bonus earned: <b>${Math.floor(Number(r.referralBonusCjp || 0)).toLocaleString()} CJP</b> • Commission earned: <b>${Math.floor(Number(r.referralCommissionCjp || 0)).toLocaleString()} CJP</b>`;
  } catch { /* ignore */ }
}
window.showTab = showTab;

function wire() {
  $('dailyBtn')?.addEventListener('click', () => action('/api/daily').catch(() => {}));
  $('taskDailyBtn')?.addEventListener('click', () => action('/api/daily').catch(() => {}));
  $('mineBtn')?.addEventListener('click', claimMining);
  $('gameBtn')?.addEventListener('click', () => showTab('game'));
  $('gameBack')?.addEventListener('click', () => showTab('dashboard'));
  $('spinBtn')?.addEventListener('click', spin);
  $('buySpin1')?.addEventListener('click', () => openBuySpins(1));
  $('buySpin10')?.addEventListener('click', () => openBuySpins(10));
  $('taskBtn')?.addEventListener('click', joinChannel); $('taskBtn2')?.addEventListener('click', joinChannel); $('taskChatBtn')?.addEventListener('click', joinChat);
  document.querySelectorAll('[id^="milestone"][id$="Btn"]').forEach(b => b.addEventListener('click', () => claimMilestone(b.dataset.task)));
  $('coinExchangeBtn')?.addEventListener('click', openCoinExchange); $('coinClaimBtn')?.addEventListener('click', claimCoin); $('coinWithdrawBtn')?.addEventListener('click', openCoinWithdraw); $('vipDailyBtn')?.addEventListener('click', claimVipDaily);
  $('walletWithdrawBtn')?.addEventListener('click', openWithdraw); $('walletWithdrawBtn2')?.addEventListener('click', openWithdraw);
  $('closeModal')?.addEventListener('click', () => $('modal').classList.add('hidden'));
  $('proofOfPayoutsLink')?.addEventListener('click', e => { e.preventDefault(); const url = `${location.origin}/payouts`; if (tg?.openLink) tg.openLink(url); else window.open(url, '_blank'); });
  $('historyBtn')?.addEventListener('click', () => openHistory('deposits'));
  $('copyRef')?.addEventListener('click', copyReferral); $('shareRef')?.addEventListener('click', shareReferral);
  $('refCode')?.addEventListener('click', e => { e.preventDefault(); openReferral(); });
  $('refreshVip')?.addEventListener('click', () => action('/api/vip/status').catch(() => {}));
  $('depositBtn')?.addEventListener('click', async () => {
    const network = $('depNetwork').value, amount = Number($('depAmount').value), txHash = $('txHash').value.trim(), msg = $('depositMsg');
    const bad = t => { if (msg) msg.innerHTML = `<b style="color:#ff5c5c">${esc(t)}</b>`; };
    if (!txHash) return bad('Please enter your transaction hash.');
    if (!Number.isFinite(amount) || amount <= 0) return bad('Please enter a valid deposit amount.');
    const min = Number(config?.depositMin ?? 10);
    if (amount < min) return bad(`Minimum deposit is ${min} USDT.`);
    try { await action('/api/deposit', { network, amount, txHash }); $('txHash').value = ''; $('depAmount').value = ''; if (msg) msg.innerHTML = '<b style="color:#48c774">Deposit submitted. USDT will be added after verification.</b>'; }
    catch (e) { bad(e.message); }
  });
  $('depNetwork')?.addEventListener('change', renderSelectedDeposit);
  document.querySelectorAll('#depNetworkPills .pill').forEach(p => p.addEventListener('click', () => {
    document.querySelectorAll('#depNetworkPills .pill').forEach(x => x.classList.remove('active')); p.classList.add('active');
    $('depNetwork').value = p.dataset.net; renderSelectedDeposit();
  }));
  document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
}
async function startApp() { try { wire(); await bootstrap(); showTab('dashboard'); } catch (e) { console.error(e); toast(e.message || 'Unable to load the app. Please reopen the Mini App.', 'err'); } }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startApp); else startApp();
