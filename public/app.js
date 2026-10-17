// VN Stock Advisor - Terminal & Testing Suite
// Tích hợp: Phân tích kỹ thuật, Cơ bản BCTC, Tin tức & Tâm lý, Trợ lý AI Gemini,
// Thị trường hôm nay (Movers: Tăng/Giảm & Mua/Bán), Khối ngoại 20 phiên, Thẻ quyết định.

const $ = (id) => document.getElementById(id);
const state = {
  current: null,
  watchlist: [],
  chart: null,
  chartDays: 132,
  newsFilter: 'all',
  activeTab: 'sec-decision',
  wlSort: 'default',
  wlSearch: '',
  movers: null,
  moversTab: 'gainers',
  moversFloor: 'HOSE',
  ai: { enabled: false },
  aiAuto: new Set(),   // mã:phiên đã tự chạy quy trình Gemini + hội đồng (tránh gọi lặp)
  aiRunning: null,     // mã đang chạy quy trình quyết định
  aiError: null,
  cmStage: null,       // bước đang chạy của quy trình, vd "Bước 2/4: Gemini phân tích…"
  cmResult: null,      // kết quả hội đồng gần nhất (có gemini + final) của mã đang xem
  picksTimer: null,
};

// Danh mục mã phổ biến hỗ trợ tìm kiếm gợi ý & test ngẫu nhiên
const POPULAR_STOCKS = [
  { symbol: 'VNINDEX', name: 'Chỉ số VN-Index', cat: 'Chỉ số' },
  { symbol: 'FPT', name: 'CTCP FPT', cat: 'Công nghệ' },
  { symbol: 'HPG', name: 'Tập đoàn Hòa Phát', cat: 'Thép' },
  { symbol: 'VCB', name: 'Vietcombank', cat: 'Ngân hàng' },
  { symbol: 'MWG', name: 'Thế Giới Di Động', cat: 'Bán lẻ' },
  { symbol: 'SSI', name: 'Chứng khoán SSI', cat: 'Chứng khoán' },
  { symbol: 'VHM', name: 'Vinhomes', cat: 'BĐS' },
  { symbol: 'VIC', name: 'Tập đoàn Vingroup', cat: 'BĐS' },
  { symbol: 'DGC', name: 'Hóa chất Đức Giang', cat: 'Hóa chất' },
  { symbol: 'TCB', name: 'Techcombank', cat: 'Ngân hàng' },
  { symbol: 'MBB', name: 'Ngân hàng Quân Đội', cat: 'Ngân hàng' },
  { symbol: 'MSN', name: 'Tập đoàn Masan', cat: 'Tiêu dùng' },
  { symbol: 'VNM', name: 'Vinamilk', cat: 'Thực phẩm' },
  { symbol: 'VND', name: 'Chứng khoán VNDIRECT', cat: 'Chứng khoán' },
  { symbol: 'STB', name: 'Sacombank', cat: 'Ngân hàng' },
  { symbol: 'ACB', name: 'Ngân hàng Á Châu', cat: 'Ngân hàng' },
  { symbol: 'GAS', name: 'Tổng công ty Khí VN', cat: 'Dầu khí' },
  { symbol: 'PVD', name: 'Khoan Dầu khí PVD', cat: 'Dầu khí' },
  { symbol: 'KBC', name: 'Kinh Bắc City', cat: 'KCN' },
  { symbol: 'VRE', name: 'Vincom Retail', cat: 'Bán lẻ' },
];

// ---------- Tiện ích cơ bản ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');
const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const fmtPct = (v, d = 1) => (v == null ? '–' : `${(v * 100).toLocaleString('vi-VN', { maximumFractionDigits: d })}%`);
const signed = (v, d = 2) => (v == null ? '–' : `${v > 0 ? '+' : ''}${fmt(v, d)}`);
const dirClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'ref');
const fmtBig = (v) => {
  if (v == null) return '–';
  if (Math.abs(v) >= 1e12) return `${fmt(v / 1e12, 1)} nghìn tỷ`;
  if (Math.abs(v) >= 1e9) return `${fmt(v / 1e9, 1)} tỷ`;
  if (Math.abs(v) >= 1e6) return `${fmt(v / 1e6, 1)} triệu`;
  return fmt(v, 0);
};
const timeAgo = (t) => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 60) return `${m} phút trước`;
  if (m < 1440) return `${Math.round(m / 60)} giờ trước`;
  return `${Math.round(m / 1440)} ngày trước`;
};

// Toast notification helper
function showToast(message, type = 'info', duration = 3000) {
  const container = $('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  toast.innerHTML = `<span style="font-weight:700">${icon}</span> <span>${esc(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Lỗi ${res.status}`);
  return data;
}

// ---------- Giao diện sáng / tối ----------
function initTheme() {
  const saved = localStorage.getItem('vnstock_theme') || 'dark';
  applyTheme(saved);

  $('theme-btn')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('vnstock_theme', theme);
  const isDark = theme === 'dark';
  $('theme-moon').hidden = !isDark;
  $('theme-sun').hidden = isDark;
  if (state.current) {
    renderChart(state.current);
    renderForeignChart(state.current);
  }
}

// ---------- Thị trường (VN-Index) ----------
async function loadMarket() {
  const el = $('market');
  try {
    const m = await api('/api/market');
    const trend = { up: 'tăng', down: 'giảm', sideways: 'đi ngang' }[m.trend] || m.trend;
    el.innerHTML = `
      <span class="market-live-dot ${m.change >= 0 ? '' : 'down'}"></span>
      <span class="market-content">VN-Index <b>${fmt(m.close)}</b> <span class="${dirClass(m.change)}">${signed(m.change)} (${signed(m.changePct)}%)</span> · <span class="muted">${trend}</span></span>
    `;
    el.onclick = () => analyze('VNINDEX');
  } catch {
    el.innerHTML = `<span class="market-content muted">Chưa tải được VN-Index</span>`;
  }
}

// ---------- THỊ TRƯỜNG HÔM NAY: TĂNG / GIẢM & KHỐI NGOẠI MUA / BÁN (MOVERS) ----------
async function loadMovers(floor = state.moversFloor) {
  try {
    const data = await api(`/api/movers?floor=${encodeURIComponent(floor)}`);
    state.movers = data;
    renderMovers();
  } catch (err) {
    const el = $('movers-list');
    if (el) el.innerHTML = `<div class="movers-empty">Không tải được số liệu sàn ${esc(floor)}: ${esc(err.message)}</div>`;
  }
}

function renderMovers() {
  const el = $('movers-list');
  if (!el) return;
  const data = state.movers;
  if (!data) {
    el.innerHTML = '<div class="movers-empty">Đang cập nhật dữ liệu thị trường…</div>';
    return;
  }
  const tab = state.moversTab || 'gainers';
  let list = [];
  if (tab === 'gainers') list = data.gainers || [];
  else if (tab === 'losers') list = data.losers || [];
  else if (tab === 'fBuy') list = data.foreignBuy || [];
  else if (tab === 'fSell') list = data.foreignSell || [];
  else if (tab === 'value') list = data.topValue || [];

  if (!list.length) {
    el.innerHTML = '<div class="movers-empty">Chưa có dữ liệu cho mục này</div>';
    return;
  }

  const maxVal = Math.max(...list.map((item) => {
    if (tab === 'gainers' || tab === 'losers') return Math.abs(item.changePct);
    if (tab === 'fBuy' || tab === 'fSell') return Math.abs(item.netVal || 0);
    return item.value || 0;
  }), 1);

  el.innerHTML = list.slice(0, 10).map((s, idx) => {
    let mainVal = '', barCls = 'pos', barWidth = 0, subTxt = '';
    if (tab === 'gainers') {
      mainVal = `<span class="up num">+${s.changePct.toFixed(1)}%</span>`;
      barCls = 'pos';
      barWidth = Math.min(100, (s.changePct / maxVal) * 100);
      subTxt = `${fmtBig(s.value)} đ`;
    } else if (tab === 'losers') {
      mainVal = `<span class="down num">${s.changePct.toFixed(1)}%</span>`;
      barCls = 'neg';
      barWidth = Math.min(100, (Math.abs(s.changePct) / maxVal) * 100);
      subTxt = `${fmtBig(s.value)} đ`;
    } else if (tab === 'fBuy') {
      mainVal = `<span class="up num">+${fmt(s.netVal / 1e9, 1)} tỷ</span>`;
      barCls = 'pos';
      barWidth = Math.min(100, (s.netVal / maxVal) * 100);
      subTxt = `${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(1)}%`;
    } else if (tab === 'fSell') {
      mainVal = `<span class="down num">${fmt(s.netVal / 1e9, 1)} tỷ</span>`;
      barCls = 'neg';
      barWidth = Math.min(100, (Math.abs(s.netVal) / maxVal) * 100);
      subTxt = `${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(1)}%`;
    } else {
      mainVal = `<span class="num">${fmtBig(s.value)} đ</span>`;
      barCls = s.changePct > 0 ? 'pos' : s.changePct < 0 ? 'neg' : 'neu';
      barWidth = Math.min(100, (s.value / maxVal) * 100);
      subTxt = `${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(1)}%`;
    }

    return `
      <div class="mv-row" data-sym="${esc(s.symbol)}">
        <span class="mv-rank">${idx + 1}</span>
        <div class="mv-sym">${esc(s.symbol)} <span class="mv-price">${fmt(s.close)}</span></div>
        <div class="mv-val">${mainVal}</div>
        <div class="mv-bar"><i class="${barCls}" style="width:${barWidth}%"></i></div>
        <div class="mv-sub">${subTxt}</div>
      </div>
    `;
  }).join('');
}

// Bắt sự kiện chọn sàn và tab trên Movers
$('movers-floor')?.addEventListener('change', (e) => {
  state.moversFloor = e.target.value;
  loadMovers(state.moversFloor);
});

$('movers-tabs')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-filter');
  if (!btn) return;
  document.querySelectorAll('#movers-tabs .btn-filter').forEach((b) => b.classList.remove('on'));
  btn.classList.add('on');
  state.moversTab = btn.dataset.tab;
  renderMovers();
});

$('movers-list')?.addEventListener('click', (e) => {
  const row = e.target.closest('[data-sym]');
  if (row) analyze(row.dataset.sym);
});

// ---------- Danh mục theo dõi ----------
async function loadWatchlist() {
  state.watchlist = await api('/api/watchlist').catch(() => []);
  $('wl-count').textContent = state.watchlist.length;
  renderWatchlist();
}

function renderWatchlist() {
  const el = $('watchlist');
  let list = [...state.watchlist];

  if (state.wlSearch) {
    const q = state.wlSearch.toLowerCase();
    list = list.filter((w) => w.symbol.toLowerCase().includes(q) || (w.note && w.note.toLowerCase().includes(q)));
  }

  if (state.wlSort === 'score') {
    list.sort((a, b) => (b.snapshot?.total ?? -999) - (a.snapshot?.total ?? -999));
  } else if (state.wlSort === 'change') {
    list.sort((a, b) => (b.snapshot?.price?.changePct ?? -999) - (a.snapshot?.price?.changePct ?? -999));
  }

  if (!list.length) {
    el.innerHTML = state.wlSearch
      ? '<p class="muted small" style="padding:10px">Không tìm thấy mã phù hợp.</p>'
      : '<p class="muted small" style="padding:10px">Chưa có mã nào. Bấm vào một mã kiểm thử hoặc nhập mã để thêm.</p>';
    return;
  }

  el.innerHTML = list.map((w) => {
    const s = w.snapshot;
    const isBuy = s?.recommendation?.code === 'BUY' || s?.recommendation?.code === 'ACCUMULATE';
    const isHold = s?.recommendation?.code === 'HOLD';
    const isSell = s?.recommendation?.code === 'SELL' || s?.recommendation?.code === 'AVOID';
    const rowClass = isBuy ? 'is-buy' : isHold ? 'is-hold' : isSell ? 'is-sell' : '';

    const meta = s
      ? `<span class="rec-txt ${recColor(s.recommendation.code)}">${esc(s.recommendation.label)}</span> · <span class="num">${s.total}đ</span>${s.warnings ? ' · ⚠' : ''}`
      : 'Đang chờ quét…';
    const aiTxt = w.ai ? ` · AI: <span class="${aiColor(w.ai.decision)}">${esc(w.ai.decisionLabel)}</span>` : '';
    const alertTxt = [w.priceAbove != null && `≥${w.priceAbove}`, w.priceBelow != null && `≤${w.priceBelow}`].filter(Boolean).join(' ');

    return `
      <div class="wl-row ${rowClass} ${state.current?.symbol === w.symbol ? 'active' : ''}" data-sym="${esc(w.symbol)}">
        <span class="wl-sym">${esc(w.symbol)}</span>
        <span class="wl-price">${s ? `${fmt(s.price.close)} <span class="${dirClass(s.price.change)} small">${signed(s.price.changePct)}%</span>` : ''}</span>
        <button class="wl-del" data-del="${esc(w.symbol)}" title="Bỏ theo dõi" aria-label="Bỏ theo dõi ${esc(w.symbol)}">✕</button>
        <span class="wl-meta">${meta}${aiTxt}${alertTxt ? ` · 🔔 ${esc(alertTxt)}` : ''}</span>
      </div>
    `;
  }).join('');
}

function recColor(code) {
  return { BUY: 'up', ACCUMULATE: 'up', HOLD: 'ref', AVOID: 'down', SELL: 'down' }[code] || '';
}

function aiColor(code) {
  return { MUA: 'up', MUA_THAM_DO: 'up', GIU: 'ref', DUNG_NGOAI: 'down', BAN_BOT: 'down', BAN: 'down' }[code] || '';
}

$('watchlist').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const sym = del.dataset.del;
    await api(`/api/watchlist/${sym}`, { method: 'DELETE' });
    showToast(`Đã xóa ${sym} khỏi danh mục`, 'info');
    await loadWatchlist();
    updateWatchButton();
    return;
  }
  const row = e.target.closest('[data-sym]');
  if (row) analyze(row.dataset.sym);
});

$('wl-search')?.addEventListener('input', (e) => {
  state.wlSearch = e.target.value.trim();
  renderWatchlist();
});

document.querySelectorAll('.wl-sort-btns .btn-filter').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.wl-sort-btns .btn-filter').forEach((b) => b.classList.remove('on'));
    btn.classList.add('on');
    state.wlSort = btn.dataset.sort;
    renderWatchlist();
  });
});

$('quick-add-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('quick-add-input');
  const sym = input.value.trim().toUpperCase();
  if (!sym) return;
  try {
    await api('/api/watchlist', { method: 'POST', body: JSON.stringify({ symbol: sym }) });
    input.value = '';
    showToast(`Đã thêm ${sym} vào danh mục`, 'success');
    await loadWatchlist();
    updateWatchButton();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$('scan-btn').addEventListener('click', async () => {
  const btn = $('scan-btn');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Đang quét…';
  try {
    await api('/api/scan', { method: 'POST' });
    await Promise.all([loadWatchlist(), loadAlerts(), loadMovers()]);
    showToast('Đã quét và cập nhật toàn bộ danh mục thành công!', 'success');
  } catch (err) {
    showToast(`Lỗi quét: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Quét lại';
  }
});

// ---------- Tìm kiếm & Gợi ý (Autocomplete) ----------
const searchInput = $('search-input');
const searchSuggestions = $('search-suggestions');
const searchClearBtn = $('search-clear-btn');

function renderSearchSuggestions(query = '') {
  const q = query.trim().toUpperCase();
  const filtered = POPULAR_STOCKS.filter((s) => s.symbol.includes(q) || s.name.toUpperCase().includes(q));
  if (!filtered.length) {
    searchSuggestions.hidden = true;
    return;
  }
  searchSuggestions.innerHTML = filtered.map((s) => `
    <div class="search-item" data-sym="${esc(s.symbol)}">
      <div class="search-item-left">
        <span class="search-item-sym">${esc(s.symbol)}</span>
        <span class="search-item-name">${esc(s.name)}</span>
      </div>
      <span class="search-item-cat">${esc(s.cat)}</span>
    </div>
  `).join('');
  searchSuggestions.hidden = false;
}

searchInput?.addEventListener('focus', () => renderSearchSuggestions(searchInput.value));
searchInput?.addEventListener('input', () => {
  searchClearBtn.hidden = !searchInput.value;
  renderSearchSuggestions(searchInput.value);
});

searchClearBtn?.addEventListener('click', () => {
  searchInput.value = '';
  searchClearBtn.hidden = true;
  searchSuggestions.hidden = true;
  searchInput.focus();
});

searchSuggestions?.addEventListener('click', (e) => {
  const item = e.target.closest('[data-sym]');
  if (item) {
    searchSuggestions.hidden = true;
    analyze(item.dataset.sym);
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.search-container')) {
    searchSuggestions.hidden = true;
  }
});

$('search')?.addEventListener('submit', (e) => {
  e.preventDefault();
  searchSuggestions.hidden = true;
  const sym = searchInput.value.trim().toUpperCase();
  if (sym) analyze(sym);
});

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    searchInput?.focus();
    searchInput?.select();
  }
});

// Random stock test button
function runRandomStock() {
  const pool = POPULAR_STOCKS.filter((s) => s.symbol !== state.current?.symbol && s.symbol !== 'VNINDEX');
  const picked = pool[Math.floor(Math.random() * pool.length)];
  if (picked) {
    showToast(`Đang test mã ngẫu nhiên: ${picked.symbol} (${picked.name})`, 'info');
    analyze(picked.symbol);
  }
}

$('btn-random-stock')?.addEventListener('click', () => {
  $('tools-dropdown')?.classList.remove('open');
  runRandomStock();
});
$('btn-ribbon-random')?.addEventListener('click', runRandomStock);

document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-sym]');
  if (chip && !chip.closest('#watchlist') && !chip.closest('#alerts-list') && !chip.closest('.search-dropdown') && !chip.closest('#movers-list')) {
    analyze(chip.dataset.sym);
  }
});

async function analyze(symbol) {
  symbol = symbol.toUpperCase();
  searchInput.value = symbol;
  searchClearBtn.hidden = false;

  document.querySelectorAll('.ticker-chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.sym === symbol);
  });

  $('empty').hidden = true;
  $('error').hidden = true;
  $('report').hidden = true;
  $('picks').hidden = true;
  $('picks-btn')?.classList.remove('on');
  $('portfolio').hidden = true;
  $('pf-btn')?.classList.remove('on');
  $('rankview').hidden = true;
  $('rank-btn')?.classList.remove('on');
  $('sectorview').hidden = true;
  $('sector-btn')?.classList.remove('on');
  $('loading').hidden = false;
  $('loading-msg').textContent = `Đang phân tích ${symbol}…`;
  history.replaceState(null, '', `#${symbol}`);

  try {
    const a = await api(`/api/analyze/${encodeURIComponent(symbol)}`);
    state.current = a;
    $('loading').hidden = true;
    $('report').hidden = false;
    render(a);
    renderWatchlist();
  } catch (err) {
    $('loading').hidden = true;
    $('error-msg').textContent = err.message;
    $('error').hidden = false;
  }
}

$('error-retry')?.addEventListener('click', () => {
  if (state.current?.symbol) analyze(state.current.symbol);
});

// ---------- Sticky Tabs Switching for Logical Testing ----------
function initTabs() {
  const nav = $('report-nav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const tab = e.target.closest('.nav-tab');
    if (!tab) return;
    const target = tab.dataset.target;

    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('on'));
    tab.classList.add('on');

    const reportEl = $('report');
    if (target === 'all') {
      reportEl.classList.add('mode-all');
      document.querySelectorAll('.report-section').forEach((s) => s.classList.add('active'));
      showToast('Đang hiển thị toàn bộ các phần (Chế độ cuộn)', 'info', 2000);
      return;
    }

    reportEl.classList.remove('mode-all');
    document.querySelectorAll('.report-section').forEach((s) => {
      s.classList.toggle('active', s.id === target);
    });

    state.activeTab = target;
    if (target === 'sec-chart' && state.chart && state.current) {
      setTimeout(() => renderChart(state.current), 50);
    }
    if (target === 'sec-foreign' && state.current) {
      setTimeout(() => renderForeignChart(state.current), 50);
    }
    if (target === 'sec-backtest' && BT.result) {
      setTimeout(() => renderBtChart(BT.result), 50);
    }
  });
}
initTabs();

// ---------- Hiển thị kết quả chi tiết ----------
function render(a) {
  $('r-symbol').textContent = a.symbol;
  $('r-exchange').textContent = a.info.exchange || '';
  $('r-name').textContent = a.info.name || '';
  $('r-price').textContent = fmt(a.price.close);

  const changeBadge = $('r-change-badge');
  changeBadge.className = `change-badge ${dirClass(a.price.change)}`;
  $('r-change').textContent = `${signed(a.price.change)} (${signed(a.price.changePct)}%)`;

  $('r-date').textContent = `Phiên ${a.price.date} · Khối lượng ${fmt(a.price.volume, 0)} CP · ${a.isIndex ? 'Điểm' : 'Nghìn VNĐ'} · Nguồn giá ${a.price.source}`;

  const rec = $('r-rec');
  rec.className = `recommendation-badge ${a.recommendation.code}`;
  const icon = { BUY: '▲', ACCUMULATE: '↗', HOLD: '●', AVOID: '↘', SELL: '▼' }[a.recommendation.code] || '●';
  rec.textContent = `${icon} ${a.recommendation.label}`;

  // Điểm chính là điểm xếp hạng 4 yếu tố; chỉ số (VN-Index…) không có xếp hạng thì dùng điểm cũ
  $('r-total').textContent = a.ranking ? `${a.ranking.score}/100` : `${signed(a.total, 0)}/100`;
  $('r-conf').textContent = a.ranking ? `${a.ranking.position}/${a.ranking.universe}` : `${a.recommendation.confidence}%`;
  $('r-desc').textContent = a.recommendation.desc;

  // Cảnh báo rủi ro
  $('r-warnings').innerHTML = a.warnings.map((w) => `<div class="warning">${esc(w)}</div>`).join('');

  // 1. Thẻ Quyết định Mua / Bán (điểm hệ thống; Gemini ghép vào khi có kết quả)
  state.aiError = null;
  renderDecisionCard(a);
  applyAiToDecision(a, null);

  // 2. Điểm số & Biểu đồ nến
  renderScores(a);
  renderChart(a);

  // 3. Khối ngoại mua/bán 20 phiên
  renderForeignChart(a);

  // 4. Tổng hợp đánh giá nhanh
  renderOverview(a);

  // 5. Tín hiệu kỹ thuật & Kế hoạch tham khảo
  renderSignals(a);
  renderPlan(a);
  renderIndicators(a);

  // 6. Cơ bản BCTC & Tin tức
  renderFundamentals(a);
  renderNews(a);
  loadAi(a);
  resetBacktest(a);
  renderRankCard(a);
  renderBrief(a);
  loadCommittee(a);
  updateAlertPresets(a.price.close);

  // Form cảnh báo giá
  $('alert-form-card').hidden = a.isIndex;
  $('af-symbol').textContent = a.symbol;
  const w = state.watchlist.find((x) => x.symbol === a.symbol);
  const form = $('alert-form');
  form.priceAbove.value = w?.priceAbove ?? '';
  form.priceBelow.value = w?.priceBelow ?? '';
  form.note.value = w?.note ?? '';
  updateWatchButton();
}

// ---------- THẺ QUYẾT ĐỊNH MUA / BÁN (DECISION CARD) ----------
function renderDecisionCard(a) {
  const card = $('decision-card');
  if (!card) return;

  // Kết luận, hành động và mức giá đã nằm ở thẻ Tóm tắt phía trên; thẻ này chỉ còn căn cứ chi tiết
  card.className = 'card decision-card';

  // Dòng tiền & Khối ngoại mua/bán
  const mf = a.marketFlow;
  const f = a.foreign;
  let flowHtml = '';
  if (mf) {
    flowHtml += `
      <div class="dc-flow-row"><span class="k">Độ rộng toàn sàn (${mf.floor})</span><span class="v"><b class="up">${mf.advancers} tăng</b> / <b class="down">${mf.decliners} giảm</b></span></div>
      <div class="dc-flow-row"><span class="k">Khối ngoại toàn sàn</span><span class="v ${dirClass(mf.foreign?.netVal)}">${signed((mf.foreign?.netVal || 0) / 1e9, 0)} tỷ</span></div>
    `;
  }
  if (f) {
    flowHtml += `
      <div class="dc-flow-row"><span class="k">Khối ngoại mã này (phiên)</span><span class="v ${dirClass(f.net1)}">${signed((f.net1 || 0) / 1e9, 1)} tỷ</span></div>
      <div class="dc-flow-row"><span class="k">Khối ngoại 5 phiên gần nhất</span><span class="v ${dirClass(f.net5)}">${signed((f.net5 || 0) / 1e9, 1)} tỷ (${f.buyDays5}/5 mua)</span></div>
    `;
  }
  $('dc-flow').innerHTML = flowHtml || '<span class="muted small">Chưa có số liệu dòng tiền</span>';

  // Điều kiện cần theo dõi
  let watchTxt = 'Theo dõi phản ứng của giá tại các ngưỡng MA20 và biến động dòng tiền khối ngoại.';
  if (a.technical.indicators.rsi14 < 30) watchTxt = 'RSI đang trong vùng quá bán: Theo dõi khả năng xuất hiện nhịp hồi kỹ thuật ngắn hạn.';
  if (a.technical.indicators.rsi14 > 70) watchTxt = 'RSI đang trong vùng quá mua: Thận trọng áp lực chốt lời gia tăng.';
  $('dc-watch').innerHTML = `<b>Lưu ý giao dịch:</b> ${watchTxt}`;

  // Top 3 Luận điểm mua (Điểm cộng) & Top 3 Rủi ro (Điểm trừ)
  const allSigs = [...a.technical.signals, ...a.fundamental.signals, ...a.news.signals];
  const pros = allSigs.filter((s) => s.points > 0).sort((a, b) => b.points - a.points).slice(0, 3);
  const cons = allSigs.filter((s) => s.points < 0).sort((a, b) => a.points - b.points).slice(0, 3);

  $('dc-pros').innerHTML = pros.length
    ? pros.map((p) => `<li><b>+${p.points}đ:</b> ${esc(p.text)}</li>`).join('')
    : '<li class="muted">Chưa ghi nhận tín hiệu tích cực nổi trội.</li>';

  $('dc-cons').innerHTML = cons.length
    ? cons.map((c) => `<li><b>${c.points}đ:</b> ${esc(c.text)}</li>`).join('')
    : '<li class="muted">Chưa ghi nhận rủi ro đáng kể.</li>';
}

// ---------- KHỐI NGOẠI MUA / BÁN 20 PHIÊN (SVG CHART) ----------
function renderForeignChart(a) {
  const container = $('foreign-chart');
  const statsEl = $('foreign-stats');
  const summaryEl = $('foreign-summary');
  if (!container || !a.foreign?.history) {
    $('foreign-card').hidden = true;
    return;
  }
  $('foreign-card').hidden = false;
  const f = a.foreign;
  const hist = [...f.history].reverse(); // Từ ngày cũ đến mới nhất
  const maxNet = Math.max(...hist.map((h) => Math.abs(h.netVal || 0)), 1e8);

  const w = 700;
  const h = 160;
  const padBottom = 24;
  const padTop = 10;
  const barW = Math.max(4, Math.floor(w / hist.length) - 6);
  const midY = (h - padBottom - padTop) / 2 + padTop;
  const scale = ((h - padBottom - padTop) / 2) / maxNet;

  const svgBars = hist.map((d, i) => {
    const x = i * (w / hist.length) + 4;
    const val = d.netVal || 0;
    const barH = Math.max(3, Math.abs(val) * scale);
    const y = val >= 0 ? midY - barH : midY;
    const cls = val >= 0 ? 'pos' : 'neg';
    const dateStr = d.date ? d.date.slice(5) : '';
    const valBillion = (val / 1e9).toFixed(1);
    return `
      <rect class="bar ${cls}" x="${x}" y="${y}" width="${barW}" height="${barH}" rx="2">
        <title>${d.date}: ${val >= 0 ? '+' : ''}${valBillion} tỷ (Mua: ${(d.buyVal / 1e9).toFixed(1)} tỷ, Bán: ${(d.sellVal / 1e9).toFixed(1)} tỷ)</title>
      </rect>
      ${i % 3 === 0 ? `<text x="${x + barW / 2}" y="${h - 6}" text-anchor="middle">${dateStr}</text>` : ''}
    `;
  }).join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}">
      <line class="zero" x1="0" y1="${midY}" x2="${w}" y2="${midY}"></line>
      ${svgBars}
    </svg>
  `;

  summaryEl.textContent = `${f.buyDays5 ?? '–'}/5 phiên mua ròng gần nhất`;
  statsEl.innerHTML = `
    <span>Phiên gần nhất: <b class="${dirClass(f.net1)}">${signed((f.net1 || 0) / 1e9, 1)} tỷ</b></span>
    <span>Mua ròng 5 phiên: <b class="${dirClass(f.net5)}">${signed((f.net5 || 0) / 1e9, 1)} tỷ</b></span>
    <span>Mua ròng 20 phiên: <b class="${dirClass(f.net20)}">${signed((f.net20 || 0) / 1e9, 1)} tỷ</b></span>
    <span>Tỷ lệ so với GTGD: <b>${f.ratio20 != null ? `${signed(f.ratio20, 1)}%` : '–'}</b></span>
  `;
}

// ---------- TỔNG HỢP ĐÁNH GIÁ NHANH (OVERVIEW) ----------
function renderOverview(a) {
  const el = $('overview-grid');
  if (!el || !a.overview) return;
  el.innerHTML = a.overview.map((item) => `
    <div class="ov-item ${item.tone}">
      <div class="ov-head">
        <span class="ov-label">${esc(item.label)}</span>
      </div>
      <div class="ov-verdict ${item.tone}">${esc(item.verdict)}</div>
      <div class="ov-detail">${esc(item.detail)}</div>
    </div>
  `).join('');
}

function updateWatchButton() {
  const a = state.current;
  if (!a) return;
  const btn = $('watch-btn');
  btn.hidden = a.isIndex;
  const watching = state.watchlist.some((w) => w.symbol === a.symbol);
  btn.className = watching ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
  btn.innerHTML = watching ? '✓ Đang theo dõi' : '+ Theo dõi mã này';
  btn.onclick = async () => {
    if (watching) {
      await api(`/api/watchlist/${a.symbol}`, { method: 'DELETE' });
      showToast(`Đã bỏ theo dõi ${a.symbol}`, 'info');
    } else {
      await api('/api/watchlist', { method: 'POST', body: JSON.stringify({ symbol: a.symbol }) });
      showToast(`Đã thêm ${a.symbol} vào danh mục theo dõi`, 'success');
    }
    await loadWatchlist();
    updateWatchButton();
  };
}

function updateAlertPresets(close) {
  if (!close) return;
  const chips = document.querySelectorAll('#alert-presets-chips .preset-chip');
  chips.forEach((c) => {
    const pct = Number(c.dataset.pct);
    const target = Math.round((close * (1 + pct / 100)) * 100) / 100;
    c.textContent = `${pct > 0 ? '+' : ''}${pct}% (${target})`;
  });
}

$('copy-json-hero')?.addEventListener('click', () => {
  if (!state.current) return;
  navigator.clipboard.writeText(JSON.stringify(state.current, null, 2));
  showToast('Đã copy toàn bộ JSON phân tích vào clipboard!', 'success');
});

// JSON Inspector Modal
function openJsonModal() {
  if (!state.current) {
    showToast('Hãy chọn 1 mã để phân tích trước!', 'info');
    return;
  }
  $('json-modal-sym').textContent = `${state.current.symbol} · ${new Date().toLocaleTimeString('vi-VN')}`;
  $('json-modal-content').textContent = JSON.stringify(state.current, null, 2);
  $('json-modal').hidden = false;
}

$('btn-open-json-modal')?.addEventListener('click', openJsonModal);
$('btn-view-raw-json')?.addEventListener('click', () => {
  $('tools-dropdown')?.classList.remove('open');
  openJsonModal();
});
$('btn-close-json-modal')?.addEventListener('click', () => {
  $('json-modal').hidden = true;
});
$('json-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'json-modal') $('json-modal').hidden = true;
});
$('btn-copy-modal-json')?.addEventListener('click', () => {
  if (!state.current) return;
  navigator.clipboard.writeText(JSON.stringify(state.current, null, 2));
  showToast('Đã sao chép JSON!', 'success');
});

$('test-alert-hero')?.addEventListener('click', async () => {
  if (!state.current) return;
  try {
    await api('/api/alerts/test', {
      method: 'POST',
      body: JSON.stringify({ symbol: state.current.symbol, message: `Giá ${state.current.symbol} vừa chạm ngưỡng thử nghiệm cảnh báo.` }),
    });
    await loadAlerts();
    showToast(`Đã kích hoạt cảnh báo test cho ${state.current.symbol}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Điểm số Diverging Bar
function renderScores(a) {
  const tiles = [
    ['technical', 'Kỹ thuật'],
    ['fundamental', 'Cơ bản'],
    ['news', 'Tin tức & Tâm lý'],
  ];
  $('r-scores').innerHTML = tiles.map(([k, label]) => {
    const v = a.scores[k];
    const w = Math.round(a.weights[k] * 100);
    const width = v == null ? 0 : Math.min(50, Math.abs(v) / 2);
    return `
      <div class="score-tile">
        <div class="lbl"><span>${label}</span><span>${a.ranking ? 'Điểm cũ · tham khảo' : `Trọng số ${w}%`}</span></div>
        <div class="val ${v == null ? 'muted' : dirClass(v)}">${v == null ? 'Không có dữ liệu' : signed(v, 0)}</div>
        <div class="dbar" role="img" aria-label="${label}: ${v ?? 'không có'} trên thang -100 đến 100">
          <div class="mid"></div>
          ${v ? `<div class="fill ${v > 0 ? 'pos' : 'neg'}" style="width:${width}%"></div>` : ''}
        </div>
        <div class="dbar-scale"><span>−100 Tiêu cực</span><span>0</span><span>+100 Tích cực</span></div>
      </div>
    `;
  }).join('');
}

// ---------- Biểu đồ giá LightweightCharts ----------
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function withAlpha(hex, alpha) {
  const n = parseInt(hex.replace('#', ''), 16);
  if (Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Khung nến và các phạm vi hiển thị tương ứng (số nến)
const CHART_TF = {
  D: { unit: 'phiên', ranges: [['3 Tháng', 66], ['6 Tháng', 132], ['1 Năm', 250], ['Tất cả', 0]], def: 132 },
  W: { unit: 'tuần', ranges: [['1 Năm', 52], ['2 Năm', 104], ['5 Năm', 260], ['Tất cả', 0]], def: 104 },
  M: { unit: 'tháng', ranges: [['2 Năm', 24], ['5 Năm', 60], ['10 Năm', 120], ['Tất cả', 0]], def: 60 },
};
state.chartTf = 'D';
state.chartCache = new Map(); // mã:khung -> dữ liệu nến tuần/tháng
let chartReq = 0;

function renderRangeButtons() {
  const cfg = CHART_TF[state.chartTf];
  $('range').innerHTML = cfg.ranges.map(([label, n]) => `<button type="button" data-days="${n}"${n === state.chartDays ? ' class="on"' : ''}>${label}</button>`).join('');
  document.querySelectorAll('#chart-tf button').forEach((b) => b.classList.toggle('on', b.dataset.tf === state.chartTf));
}

/** Vẽ biểu đồ theo khung đang chọn: nến ngày lấy từ kết quả phân tích, nến tuần/tháng tải riêng (lịch sử dài hơn). */
async function renderChart(a) {
  renderRangeButtons();
  const tf = state.chartTf;
  if (tf === 'D') return drawChart(a, a.chart, tf);
  const key = `${a.symbol}:${tf}`;
  const req = ++chartReq;
  if (!state.chartCache.has(key)) {
    $('chart').innerHTML = '<div class="loading-state" style="border:none;padding:40px"><span>Đang tải nến ' + (tf === 'W' ? 'tuần' : 'tháng') + '…</span></div>';
    try {
      state.chartCache.set(key, await api(`/api/chart/${a.symbol}?tf=${tf}`));
    } catch (err) {
      if (req === chartReq) $('chart').innerHTML = `<p class="error" style="padding:20px">${esc(err.message)}</p>`;
      return;
    }
  }
  if (req !== chartReq || state.current?.symbol !== a.symbol || state.chartTf !== tf) return;
  drawChart(a, state.chartCache.get(key), tf);
}

function drawChart(a, data, tf) {
  const el = $('chart');
  if (state.chart) {
    state.chart.remove();
    state.chart = null;
  }
  if (!window.LightweightCharts) {
    el.innerHTML = '<p class="muted" style="padding:20px">Không tải được thư viện biểu đồ LightweightCharts.</p>';
    return;
  }
  el.innerHTML = '';
  const LC = window.LightweightCharts;
  const chart = LC.createChart(el, {
    autoSize: true,
    layout: {
      background: { color: css('--surface') },
      textColor: css('--muted'),
      fontFamily: 'Inter, system-ui, sans-serif',
    },
    grid: {
      vertLines: { color: css('--grid') },
      horzLines: { color: css('--grid') },
    },
    rightPriceScale: { borderColor: css('--axis') },
    timeScale: { borderColor: css('--axis') },
    crosshair: { mode: LC.CrosshairMode.Normal },
    localization: { locale: 'vi-VN' },
  });

  const up = css('--up') || '#10b981';
  const down = css('--down') || '#f43f5e';

  const candles = chart.addCandlestickSeries({
    upColor: up,
    downColor: down,
    wickUpColor: up,
    wickDownColor: down,
    borderVisible: false,
  });
  candles.setData(data.bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));

  const lineOpts = (color) => ({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const ma = [
    ['MA20', chart.addLineSeries(lineOpts(css('--s1') || '#38bdf8')), data.sma20],
    ['MA50', chart.addLineSeries(lineOpts(css('--s2') || '#fb923c')), data.sma50],
    ['MA200', chart.addLineSeries(lineOpts(css('--s3') || '#a855f7')), data.sma200],
  ];
  ma.forEach(([, s, data]) => s.setData(data));

  const vol = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  candles.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } });
  vol.setData(data.bars.map((b, i, arr) => ({
    time: b.time,
    value: b.volume,
    color: withAlpha(i && b.close < arr[i - 1].close ? down : up, 0.4),
  })));

  if (a.plan) {
    candles.createPriceLine({ price: a.plan.stopLoss, color: down, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: 'Cắt lỗ' });
    candles.createPriceLine({ price: a.plan.target, color: up, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title: 'Mục tiêu' });
  }

  const legend = $('chart-legend');
  const barByTime = new Map(data.bars.map((b) => [b.time, b]));
  const showLegend = (time) => {
    const b = barByTime.get(time) || data.bars.at(-1);
    if (!b) return;
    const i = data.bars.indexOf(b);
    const prev = data.bars[i - 1];
    const ch = prev ? ((b.close - prev.close) / prev.close) * 100 : 0;
    const maVals = ma.map(([name, , data]) => {
      const p = data.find((d) => d.time === b.time);
      return p ? `${name} <b>${fmt(p.value)}</b>` : '';
    }).filter(Boolean).join(' · ');
    legend.innerHTML = `${tf === 'W' ? 'Tuần từ ' : tf === 'M' ? 'Tháng ' : ''}${tf === 'M' ? b.time.slice(0, 7) : b.time} · Mở <b>${fmt(b.open)}</b> · Cao <b>${fmt(b.high)}</b> · Thấp <b>${fmt(b.low)}</b> · Đóng <b>${fmt(b.close)}</b>
      <span class="${dirClass(ch)}">${signed(ch)}%</span> · Khối lượng <b>${fmt(b.volume, 0)}</b>${maVals ? ` · ${maVals}` : ''}`;
  };
  chart.subscribeCrosshairMove((p) => showLegend(p.time));
  showLegend(null);

  state.chart = chart;
  state.chartBars = data.bars.length;
  setRange(state.chartDays);
}

function setRange(days) {
  state.chartDays = days;
  document.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === days));
  if (!state.chart || !state.current) return;
  const n = state.chartBars || 0;
  if (!days || days >= n) state.chart.timeScale().fitContent();
  else state.chart.timeScale().setVisibleLogicalRange({ from: n - days, to: n + 2 });
}

$('chart-tf')?.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tf]');
  if (!b || b.dataset.tf === state.chartTf) return;
  state.chartTf = b.dataset.tf;
  state.chartDays = CHART_TF[state.chartTf].def;
  if (state.current) renderChart(state.current);
  else renderRangeButtons();
});

$('range')?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setRange(Number(b.dataset.days));
});

// ---------- Tín hiệu & Kế hoạch ----------
function renderSignals(a) {
  const groups = [
    ['Tín hiệu Kỹ thuật', a.technical.signals],
    ['Tín hiệu Cơ bản', a.fundamental.signals],
    ['Tín hiệu Tin tức', a.news.signals],
  ].filter(([, list]) => list.length);

  $('r-signals').innerHTML = groups.map(([title, list]) => `
    <div class="sig-group">
      <h4>${title}</h4>
      ${list.map((s) => `
        <div class="sig">
          <span class="ico ${dirClass(s.points)}">${s.points > 0 ? '+' : s.points < 0 ? '−' : '·'}</span>
          <span>${esc(s.text)}</span>
          <span class="pts">${signed(s.points, 0)}</span>
        </div>
      `).join('')}
    </div>
  `).join('');
}

function kv(rows) {
  return rows.map(([k, v, cls = '']) => `<span class="k">${k}</span><span class="v ${cls}">${v}</span>`).join('');
}

function renderPlan(a) {
  $('plan-card').hidden = !a.plan;
  if (!a.plan) return;
  const p = a.plan, c = a.price.close;
  const pct = (x) => `${signed(((x - c) / c) * 100, 1)}%`;
  $('r-plan').innerHTML = kv([
    ['Giá hiện tại', fmt(c)],
    ['Hỗ trợ (đáy 20 phiên)', `${fmt(p.support)} <span class="muted small">${pct(p.support)}</span>`],
    ['Kháng cự (đỉnh 20 phiên)', `${fmt(p.resistance)} <span class="muted small">${pct(p.resistance)}</span>`],
    ['Điểm cắt lỗ', `${fmt(p.stopLoss)} <span class="small">${pct(p.stopLoss)}</span>`, 'down'],
    ['Mục tiêu chốt lời', `${fmt(p.target)} <span class="small">${pct(p.target)}</span>`, 'up'],
    ['Lợi nhuận / Rủi ro', `${fmt(p.riskReward, 1)} lần`, p.riskReward >= 2 ? 'up' : p.riskReward < 1 ? 'down' : ''],
    ['Biên độ ATR(14)', fmt(p.atr)],
  ]);
}

function renderIndicators(a) {
  const i = a.technical.indicators;
  const rsiCls = i.rsi14 > 70 ? 'down' : i.rsi14 < 30 ? 'up' : '';
  $('r-ind').innerHTML = kv([
    ['RSI(14)', fmt(i.rsi14, 1), rsiCls],
    ['MACD / Signal', `${fmt(i.macd, 2)} / ${fmt(i.macdSignal, 2)}`, dirClass(i.macdHist)],
    ['MA20 · MA50 · MA200', `${fmt(i.sma20)} · ${fmt(i.sma50)} · ${fmt(i.sma200)}`],
    ['Dải Bollinger (Dưới – Trên)', `${fmt(i.bbLower)} – ${fmt(i.bbUpper)}`],
    ['Khối lượng phiên / TB20', `${fmt(i.volume, 0)} / ${fmt(i.avgVolume20, 0)}`],
    ['Hiệu suất 5 phiên', `${signed(i.return5d, 1)}%`, dirClass(i.return5d)],
    ['Hiệu suất 20 phiên', `${signed(i.return20d, 1)}%`, dirClass(i.return20d)],
    ['Hiệu suất 60 phiên', `${signed(i.return60d, 1)}%`, dirClass(i.return60d)],
    ['Hiệu suất 1 năm', `${signed(i.return250d, 1)}%`, dirClass(i.return250d)],
  ]);
}

function renderFundamentals(a) {
  const f = a.fundamental.data;
  $('fund-card').hidden = !f;
  if (!f) return;
  $('r-fund-date').textContent = f.reportDate ? `BCTC kỳ ${f.reportDate}` : '';
  const items = [
    ['P/E', fmt(f.pe, 1)], ['P/B', fmt(f.pb, 2)], ['P/S', fmt(f.ps, 2)],
    ['EPS 4 quý (VNĐ)', fmt(f.epsTTM, 0)], ['BVPS (VNĐ)', fmt(f.bookValuePerShare, 0)],
    ['ROE', fmtPct(f.roe)], ['ROA', fmtPct(f.roa)],
    ['Tăng trưởng LN 4Q', fmtPct(f.profitGrowthTTM), dirClass(f.profitGrowthTTM)],
    ['Tăng trưởng DT 4Q', fmtPct(f.revenueGrowthTTM), dirClass(f.revenueGrowthTTM)],
    ['LN quý vs cùng kỳ', fmtPct(f.profitGrowthQoQYoY), dirClass(f.profitGrowthQoQYoY)],
    ['Biên LN gộp', fmtPct(f.grossMarginTTM)], ['Biên LN ròng', fmtPct(f.netMarginTTM)],
    ['Nợ vay / VCSH', fmt(f.debtToEquity, 2)], ['Thanh toán hiện hành', fmt(f.currentRatio, 2)],
    ['Tỷ suất cổ tức', fmtPct(f.dividendYield)], ['Hệ số Beta', fmt(f.beta, 2)],
    ['Vốn hóa thị trường', fmtBig(f.marketCap)], ['Doanh thu 4Q', fmtBig(f.revenueTTM)], ['LN ròng 4Q', fmtBig(f.netProfitTTM)],
    ['Đỉnh / Đáy 52 tuần', `${fmt(f.high52w / 1000)} / ${fmt(f.low52w / 1000)}`],
    ['Sở hữu nước ngoài', fmtPct(f.foreignOwnership)],
  ];
  $('r-fund').innerHTML = items.map(([k, v, cls = '']) => `
    <div class="fund-item"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>
  `).join('');
}

const LABELS = { tich_cuc: 'Tích cực', tieu_cuc: 'Tiêu cực', trung_lap: 'Trung lập' };

function renderNews(a) {
  const items = a.news.items.filter((n) => state.newsFilter === 'all' || n.label === state.newsFilter);
  $('r-news-count').textContent = `(${a.news.count} tin · ${a.news.positive} tích cực · ${a.news.negative} tiêu cực)`;
  $('r-news').innerHTML = items.length ? items.map((n) => `
    <li>
      <span class="chip ${n.label}">${LABELS[n.label]}</span>
      <div>
        <a href="${esc(safeUrl(n.link))}" target="_blank" rel="noopener noreferrer">${esc(n.title)} ↗</a>
        <div class="meta">${esc(n.source)} · ${timeAgo(n.publishedAt)}</div>
        ${n.keywords.length ? `<div class="kw">Từ khóa: ${n.keywords.map(esc).join(', ')}</div>` : ''}
      </div>
    </li>
  `).join('') : '<li class="muted" style="padding:10px">Không có tin tức phù hợp trong bộ lọc này.</li>';
}

$('news-filter')?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.newsFilter = b.dataset.f;
  document.querySelectorAll('#news-filter button').forEach((x) => x.classList.toggle('on', x === b));
  if (state.current) renderNews(state.current);
});

// ---------- Cài đặt Cảnh báo Giá & Preset Chips ----------
$('alert-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = $('af-submit');
  btn.disabled = true;
  try {
    await api('/api/watchlist', {
      method: 'POST',
      body: JSON.stringify({
        symbol: state.current.symbol,
        priceAbove: f.priceAbove.value,
        priceBelow: f.priceBelow.value,
        note: f.note.value,
      }),
    });
    await loadWatchlist();
    updateWatchButton();
    showToast(`Đã lưu cảnh báo giá cho ${state.current.symbol}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('alert-presets-chips')?.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-pct]');
  if (!chip || !state.current?.price?.close) return;
  const pct = Number(chip.dataset.pct);
  const cur = state.current.price.close;
  const target = Math.round((cur * (1 + pct / 100)) * 100) / 100;
  if (pct > 0) {
    $('af-price-above').value = target;
    showToast(`Đã thiết lập ngưỡng giá trên ≥ ${target} (+${pct}%)`, 'info');
  } else {
    $('af-price-below').value = target;
    showToast(`Đã thiết lập ngưỡng giá dưới ≤ ${target} (${pct}%)`, 'info');
  }
});

// ---------- Phân tích AI (Gemini) ----------
async function loadAi(a) {
  $('ai-card').hidden = a.isIndex;
  if (a.isIndex) return;
  const btn = $('ai-btn');
  $('ai-model').textContent = state.ai.enabled ? `· Gemini` : '';
  if (!state.ai.enabled) {
    btn.hidden = true;
    $('ai-body').innerHTML = `
      <p class="muted" style="padding:14px">Chưa bật Gemini. Tạo API key miễn phí tại
      <b>aistudio.google.com/apikey</b>, sao chép <code>.env.example</code> thành <code>.env</code>,
      điền <code>GEMINI_API_KEY</code> rồi khởi động lại server.</p>
    `;
    return;
  }
  btn.hidden = false;
  $('ai-body').innerHTML = '';
  const saved = await api(`/api/ai/${a.symbol}`).catch(() => null);
  if (state.current?.symbol !== a.symbol) return;
  if (saved) {
    renderAi(saved);
    applyAiToDecision(a, saved);
  } else {
    $('ai-body').innerHTML = `
      <p class="muted" style="padding:14px">Gemini sẽ đọc toàn bộ dữ liệu giá, BCTC và tin tức để đưa ra nhận định chuyên sâu.</p>
    `;
  }
  // Quy trình Gemini + hội đồng được tự chạy ở loadCommittee
}

/**
 * Chạy quy trình quyết định trên server: Gemini → phe mua/phe bán → giám đốc đầu tư.
 * Tiến độ và kết quả được renderCommittee theo dõi. force = Gemini phân tích lại (bỏ cache 30 phút).
 */
async function runAiFor(a, force = true) {
  state.aiRunning = a.symbol;
  state.aiError = null;
  state.cmStage = 'Chuẩn bị';
  $('ai-btn').disabled = true;
  if (state.current?.symbol === a.symbol) applyAiToDecision(a, state.aiResult);
  try {
    const s = await api(`/api/committee/${a.symbol}`, { method: 'POST', body: JSON.stringify({ force }) });
    if (state.current?.symbol === a.symbol) renderCommittee(s, a);
  } catch (err) {
    state.aiRunning = null;
    state.aiError = { symbol: a.symbol, message: err.message };
    $('ai-btn').disabled = false;
    if (state.current?.symbol === a.symbol) applyAiToDecision(a, state.aiResult);
  }
}
$('ai-btn')?.addEventListener('click', () => state.current && runAiFor(state.current));

/** Quyết định cuối (đã qua Gemini và hội đồng) của mã đang xem, chỉ khi cùng phiên giá. */
function currentFinal(a) {
  const r = state.cmResult;
  return r?.symbol === a.symbol && r.final && r.final.priceDate === a.price.date ? r.final : null;
}

// ---------- Ghép nhận định Gemini vào thẻ Căn cứ chi tiết ----------

/**
 * Vẽ lại thẻ Tóm tắt (quyết định cuối) và, khi có kết quả Gemini, thay luận điểm mua, rủi ro,
 * điều kiện theo dõi và nhận định dòng tiền ở thẻ Căn cứ chi tiết.
 */
function applyAiToDecision(a, ai) {
  state.aiResult = ai && ai.symbol === a.symbol ? ai : null;
  ai = state.aiResult;
  if (state.current?.symbol === a.symbol) renderBrief(a);
  // Kết luận, trạng thái AI, hành động và mức giá hiển thị ở thẻ Tóm tắt; ở đây chỉ thay căn cứ chi tiết
  if (!ai) return;

  const li = (arr) => arr.slice(0, 3).map((x) => `<li>${esc(x)}</li>`).join('');
  if (ai.bullCase?.length) $('dc-pros').innerHTML = li(ai.bullCase);
  if (ai.bearCase?.length) $('dc-cons').innerHTML = li(ai.bearCase);
  if (ai.watchItems?.length) $('dc-watch').innerHTML = `<b>👁 Cần theo dõi:</b> ${ai.watchItems.slice(0, 3).map(esc).join(' · ')}`;
  if (ai.marketFlowView) {
    const flow = $('dc-flow');
    flow.querySelector('.dc-note')?.remove();
    flow.insertAdjacentHTML('beforeend', `<div class="dc-note">${esc(ai.marketFlowView)}</div>`);
  }
}

// ---------- CỔ PHIẾU TIỀM NĂNG ----------
const PICK_TONE = { MUA: 'up', MUA_THAM_DO: 'up', CHO_DIEM_MUA: 'ref', LOAI: 'down' };

function showPicks() {
  ['empty', 'error', 'report', 'loading', 'portfolio', 'rankview', 'sectorview'].forEach((id) => ($(id).hidden = true));
  $('sector-btn')?.classList.remove('on');
  $('pf-btn')?.classList.remove('on');
  $('rank-btn')?.classList.remove('on');
  $('picks').hidden = false;
  $('picks-btn')?.classList.add('on');
  history.replaceState(null, '', '#tiem-nang');
  loadPicks();
}

async function loadPicks() {
  clearTimeout(state.picksTimer);
  let s;
  try {
    s = await api('/api/screener');
  } catch (err) {
    $('pk-list').innerHTML = `<div class="card pk-empty">Không tải được: ${esc(err.message)}</div>`;
    return;
  }
  renderPicks(s);
  // Đang quét: hỏi lại mỗi 2 giây để cập nhật tiến độ
  if (s.status === 'running' && !$('picks').hidden) state.picksTimer = setTimeout(loadPicks, 2000);
}

function renderPicks(s) {
  const r = s.result;
  const running = s.status === 'running';
  $('pk-run-btn').disabled = running;
  $('pk-ai-btn').disabled = running || !r?.candidates?.length || !state.ai.enabled;

  $('pk-progress').hidden = !running;
  if (running && s.progress) {
    const p = s.progress;
    $('pk-progress-label').textContent = `Bước ${p.stage}/3: ${p.label}${p.total > 1 ? ` (${p.done}/${p.total})` : '…'}`;
    const pctDone = ((Math.max(0, p.stage - 1) + (p.total ? p.done / p.total : 0)) / 3) * 100;
    $('pk-bar-fill').style.width = `${Math.min(100, pctDone)}%`;
  }

  if (!r) {
    $('pk-sub').textContent = '';
    $('pk-market').innerHTML = '';
    $('pk-rejected').hidden = true;
    $('pk-list').innerHTML = running ? '' : `<div class="card pk-empty">
      ${s.status === 'error' ? `<p class="down">Lần quét trước lỗi: ${esc(s.error)}</p>` : ''}
      <p>Chưa có kết quả. Bấm <b>Quét lại thị trường</b> để tìm cổ phiếu tiềm năng (mất khoảng 1–4 phút).</p></div>`;
    return;
  }

  const ai = r.ai && !r.ai.error ? r.ai : null;
  const fn = r.funnel;
  $('pk-sub').textContent = `Phiên ${r.date.split('-').reverse().join('/')} · quét ${r.scanned} mã`
    + (fn ? ` → ${fn.liquidity} mã thanh khoản đều ≥ 5 tỷ → ${fn.quality} mã cơ bản tốt → ${fn.trend} mã xu hướng mạnh` : '')
    + ` · phân tích sâu ${r.shortlisted} mã · `
    + `chọn ${r.candidates.length} mã · ${new Date(r.createdAt).toLocaleString('vi-VN')}`
    + (ai ? ` · Gemini (${ai.model})` : '');

  const mf = r.marketFlow;
  $('pk-market').innerHTML = `
    <div class="pk-market-stats">
      ${r.market ? `<span>VN-Index <b class="${dirClass(r.market.changePct)}">${fmt(r.market.close)} (${signed(r.market.changePct)}%)</b> · ${{ up: 'xu hướng tăng', down: 'xu hướng giảm', sideways: 'đi ngang' }[r.market.trend] || ''}</span>` : ''}
      ${mf ? `<span>${mf.floor}: <b class="up">${mf.advancers} tăng</b> / <b class="down">${mf.decliners} giảm</b></span>
      <span>Khối ngoại toàn sàn <b class="${dirClass(mf.foreign.netVal)}">${signed(mf.foreign.netVal / 1e9, 0)} tỷ</b></span>` : ''}
    </div>
    ${ai?.marketView ? `<div class="pk-market-view"><b>✦ Gemini nhận định thị trường:</b> ${esc(ai.marketView)}</div>` : ''}
    ${r.ai?.error ? `<div class="pk-market-view"><span class="down">AI lỗi: ${esc(r.ai.error)}</span> Danh sách bên dưới xếp theo điểm hệ thống. Bấm "Gemini đánh giá lại" để thử lại — tool tự chuyển sang nhà cung cấp AI khác nếu bạn đã thêm key.</div>` : ''}
    ${ai?.note ? `<div class="pk-line"><b>Quản lý vốn:</b> ${esc(ai.note)}</div>` : ''}`;

  // Ghép đánh giá Gemini vào từng ứng viên; xếp theo thứ tự Gemini, mã bị loại để riêng
  const pickBy = new Map((ai?.picks || []).map((p, i) => [p.symbol, { ...p, order: i }]));
  const rows = r.candidates.map((c, i) => ({ c, p: pickBy.get(c.symbol), order: pickBy.get(c.symbol)?.order ?? 100 + i }));
  rows.sort((x, y) => x.order - y.order);
  const kept = rows.filter((x) => x.p?.verdict !== 'LOAI');
  const rejected = rows.filter((x) => x.p?.verdict === 'LOAI');

  $('pk-list').innerHTML = kept.length ? kept.map((x, i) => pickCard(x.c, x.p, i + 1)).join('')
    : '<div class="card pk-empty">Gemini không chọn mã nào đáng mua lúc này. Xem danh sách đã loại bên dưới.</div>';

  $('pk-rejected').hidden = !rejected.length;
  $('pk-rejected-count').textContent = `(${rejected.length} mã)`;
  $('pk-rejected-list').innerHTML = rejected.map(({ c, p }) => `
    <div class="pk-rej-row">
      <b>${esc(c.symbol)}</b>
      <span>${esc(p.mainRisk || p.thesis)}</span>
      <button type="button" class="btn btn-glass btn-xs" data-sym="${esc(c.symbol)}">Xem</button>
    </div>`).join('');
}

function pickCard(c, p, rank) {
  const pct = (x) => (x == null ? '' : `${signed(((x - c.close) / c.close) * 100, 1)}%`);
  const tone = p ? PICK_TONE[p.verdict] : (c.recommendation.code === 'BUY' || c.recommendation.code === 'ACCUMULATE' ? 'up' : 'ref');
  const label = p ? p.verdictLabel : c.recommendation.label;
  const entry = p?.entryZone || (c.plan ? { from: c.plan.support, to: c.close } : null);
  const stop = p?.stopLoss ?? c.plan?.stopLoss;
  const target = p?.target ?? c.plan?.target;
  const mid = entry ? (entry.from + entry.to) / 2 : c.close;
  const rr = stop != null && target != null && mid > stop ? (target - mid) / (mid - stop) : null;
  const f = c.fundamentals || {};
  const watching = state.watchlist.some((w) => w.symbol === c.symbol);
  return `
    <section class="card pk-card v-${p?.verdict || ''}">
      <div class="pk-top">
        <div>
          <div class="pk-sym"><span class="pk-rank">#${rank}</span>${esc(c.symbol)}<span class="tag">${esc(c.exchange)}</span></div>
          <div class="pk-name">${esc(c.name)}</div>
        </div>
        <div class="pk-price"><b>${fmt(c.close)}</b><span class="${dirClass(c.changePct)}">${signed(c.changePct)}%</span></div>
      </div>
      <div><span class="pk-verdict ${tone}">${esc(label)}${p ? ` · ${p.confidence}%` : ''}</span></div>
      <div class="pk-tags">${c.setups.map((s) => `<span class="pk-tag" title="${esc(s.desc)}">${esc(s.label)}</span>`).join('')}</div>
      <p class="pk-thesis">${esc(p?.thesis || c.recommendation.desc)}</p>
      <div class="pk-levels">
        <div class="pk-lv"><div class="k">Vùng mua</div><div class="v">${entry ? `${fmt(entry.from)}–${fmt(entry.to)}` : '–'}</div></div>
        <div class="pk-lv"><div class="k">Cắt lỗ</div><div class="v down">${fmt(stop)}</div><div class="p">${pct(stop)}</div></div>
        <div class="pk-lv"><div class="k">Mục tiêu</div><div class="v up">${fmt(target)}</div><div class="p">${pct(target)}</div></div>
        <div class="pk-lv"><div class="k">Lời / Lỗ</div><div class="v ${rr >= 2 ? 'up' : rr < 1.2 ? 'down' : ''}">${rr ? `${fmt(rr, 1)} lần` : '–'}</div><div class="p">${esc(p?.horizon || '')}</div></div>
      </div>
      ${p?.trigger ? `<div class="pk-line"><b>Điều kiện mua:</b> ${esc(p.trigger)}</div>` : ''}
      ${p?.mainRisk ? `<div class="pk-line"><b>Rủi ro:</b> ${esc(p.mainRisk)}</div>` : ''}
      ${c.quality ? `<div class="pk-quality"><b>Vì sao là cổ ngon</b> ${c.quality.score != null ? `<span class="muted small">· chất lượng ${c.quality.score}/100${c.combined != null ? ` · điểm chung ${c.combined}` : ''}</span>` : ''}
        <ul>${c.quality.checks.map((k) => `<li class="${k.ok ? 'up' : 'down'}">${k.ok ? '✓' : '✕'} ${esc(k.label)}</li>`).join('')}
        ${c.liquidity ? `<li class="${c.liquidity.pass ? 'up' : 'down'}">${c.liquidity.pass ? '✓' : '✕'} Thanh khoản TB ${fmt(c.liquidity.avg / 1e9, 1)} tỷ/phiên, ${c.liquidity.okDays}/${c.liquidity.days} phiên ≥ 5 tỷ (phiên gần nhất ${fmt(c.liquidity.last / 1e9, 1)} tỷ)</li>` : ''}</ul></div>` : ''}
      <div class="pk-stats">
        <span>Điểm HT ${signed(c.total, 0)}</span>
        ${c.ranking ? `<span title="Điểm xếp hạng 4 yếu tố (0–100)">Xếp hạng ${c.ranking.score}</span>` : ''}
        ${c.foreign ? `<span>NN 20 phiên ${signed(c.foreign.net20 / 1e9, 1)} tỷ</span>` : ''}
        ${f.pe != null ? `<span>P/E ${fmt(f.pe, 1)}</span>` : ''}
        ${f.roe != null ? `<span>ROE ${fmtPct(f.roe)}</span>` : ''}
        ${f.profitGrowthTTM != null ? `<span>LN 4Q ${fmtPct(f.profitGrowthTTM, 0)}</span>` : ''}
      </div>
      <div class="pk-foot">
        <button type="button" class="btn btn-glass btn-sm" data-watch="${esc(c.symbol)}" ${watching ? 'disabled' : ''}>${watching ? '✓ Đang theo dõi' : '+ Theo dõi'}</button>
        <button type="button" class="btn btn-primary btn-sm" data-sym="${esc(c.symbol)}">Phân tích chi tiết →</button>
      </div>
    </section>`;
}

$('picks-btn')?.addEventListener('click', showPicks);
$('pk-run-btn')?.addEventListener('click', async () => {
  await api('/api/screener/run', { method: 'POST' }).catch((err) => showToast(err.message, 'error'));
  loadPicks();
});
$('pk-ai-btn')?.addEventListener('click', async () => {
  await api('/api/screener/ai', { method: 'POST' }).catch((err) => showToast(err.message, 'error'));
  loadPicks();
});
$('picks')?.addEventListener('click', async (e) => {
  const w = e.target.closest('[data-watch]');
  if (!w) return;
  w.disabled = true;
  await api('/api/watchlist', { method: 'POST', body: JSON.stringify({ symbol: w.dataset.watch }) });
  showToast(`Đã thêm ${w.dataset.watch} vào danh mục theo dõi`, 'success');
  w.textContent = '✓ Đang theo dõi';
  loadWatchlist();
});

function renderAi(r) {
  const close = state.current?.price.close;
  const stale = close != null && r.price !== close;
  const list = (title, items, cls = '') => (items?.length
    ? `<div><h4 class="${cls}">${title}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  const pctFrom = (v) => (close ? ` <span class="muted small">${signed(((v - close) / close) * 100, 1)}%</span>` : '');
  const levels = [
    r.entryZone && ['Vùng mua', `${fmt(r.entryZone.from)} – ${fmt(r.entryZone.to)}`, ''],
    r.stopLoss != null && ['Cắt lỗ', fmt(r.stopLoss) + pctFrom(r.stopLoss), 'down'],
    ...r.targets.map((t, i) => [`Mục tiêu ${i + 1}`, fmt(t) + pctFrom(t), 'up']),
    ['Khung thời gian', esc(r.horizon), ''],
  ].filter(Boolean);

  $('ai-body').innerHTML = `
    <div class="ai-head">
      <span class="recommendation-badge ${r.decision}">${esc(r.decisionLabel)}</span>
      <span>Độ tin cậy <b>${r.confidence}%</b></span>
      <span class="muted small">${esc(r.model)} · ${new Date(r.createdAt).toLocaleString('vi-VN')} · Tại giá ${fmt(r.price)}${stale ? ' (giá đã đổi, nên phân tích lại)' : ''}</span>
    </div>
    <p class="ai-summary">${esc(r.summary)}</p>
    <div class="ai-actions">
      <div class="ai-box"><h4>Nếu chưa có cổ phiếu</h4>${esc(r.forNewBuyers)}</div>
      <div class="ai-box"><h4>Nếu đang nắm giữ</h4>${esc(r.forHolders)}</div>
    </div>
    <div class="ai-levels">${levels.map(([k, v, cls]) => `<div class="fund-item"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`).join('')}</div>
    ${r.positionSizing ? `<div class="ai-box" style="margin-bottom:14px"><h4>Quản lý vốn & tỷ trọng</h4>${esc(r.positionSizing)}</div>` : ''}
    <div class="ai-lists">
      ${list('▲ Luận điểm ủng hộ', r.bullCase, 'up')}
      ${list('▼ Rủi ro / Phản biện', r.bearCase, 'down')}
      ${list('Nhận định từ tin tức', r.newsInsights)}
      ${list('Sự kiện sắp tới (Catalyst)', r.catalysts)}
      ${list('Tín hiệu cần theo dõi', r.watchItems)}
      ${list('Dữ liệu còn thiếu', r.dataGaps)}
    </div>
    ${r.ruleScoreComment ? `<div class="ai-box" style="margin-top:14px"><h4>So với điểm theo quy tắc</h4>${esc(r.ruleScoreComment)}</div>` : ''}
    <p class="ai-note">AI có thể sai hoặc suy diễn quá mức. Đối chiếu với dữ liệu định lượng bên dưới trước khi ra quyết định. ${r.tokens ? `${r.tokens.toLocaleString('vi-VN')} tokens · ` : ''}${Math.round(r.durationMs / 1000)}s</p>
  `;
}

$('btn-copy-ai')?.addEventListener('click', () => {
  const body = $('ai-body')?.innerText;
  if (!body) {
    showToast('Chưa có nhận định AI nào để sao chép', 'info');
    return;
  }
  navigator.clipboard.writeText(body);
  showToast('Đã sao chép nhận định AI vào clipboard!', 'success');
});

// ---------- Cảnh báo & Drawer ----------
async function loadAlerts() {
  const alerts = await api('/api/alerts').catch(() => []);
  const unread = alerts.filter((a) => !a.read).length;
  $('alerts-count').hidden = !unread;
  $('alerts-list').innerHTML = alerts.length ? alerts.map((a) => `
    <li class="${a.read ? '' : 'unread'}" data-sym="${esc(a.symbol)}">
      <div style="font-size:13px"><b>${esc(a.symbol)}</b>: ${esc(a.message)}</div>
      <div class="meta">${new Date(a.time).toLocaleString('vi-VN')}</div>
    </li>
  `).join('') : '<li class="muted" style="padding:14px">Chưa có cảnh báo nào trong hệ thống.</li>';
}

$('alerts-btn')?.addEventListener('click', async () => {
  $('drawer').hidden = false;
  await api('/api/alerts/read', { method: 'POST' });
  $('alerts-count').hidden = true;
});

$('drawer-close')?.addEventListener('click', () => {
  $('drawer').hidden = true;
  loadAlerts();
});

$('alerts-list')?.addEventListener('click', (e) => {
  const li = e.target.closest('[data-sym]');
  if (li) {
    $('drawer').hidden = true;
    analyze(li.dataset.sym);
  }
});

$('btn-create-test-alert')?.addEventListener('click', async () => {
  const sym = state.current?.symbol || 'FPT';
  await api('/api/alerts/test', { method: 'POST', body: JSON.stringify({ symbol: sym }) });
  await loadAlerts();
  showToast(`Đã tạo cảnh báo test cho ${sym}`, 'success');
});

// ---------- Menu Test Tools Dropdown ----------
const toolsDropdown = $('tools-dropdown');
$('tools-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toolsDropdown.classList.toggle('open');
});

document.addEventListener('click', () => toolsDropdown?.classList.remove('open'));

$('btn-test-alert')?.addEventListener('click', async () => {
  toolsDropdown.classList.remove('open');
  const sym = state.current?.symbol || 'HPG';
  await api('/api/alerts/test', {
    method: 'POST',
    body: JSON.stringify({ symbol: sym, message: `[TEST] ${sym} có biến động giá vượt ngưỡng thử nghiệm!` }),
  });
  await loadAlerts();
  showToast(`Đã bắn cảnh báo thử nghiệm cho ${sym}`, 'success');
});

$('btn-copy-json')?.addEventListener('click', () => {
  toolsDropdown.classList.remove('open');
  if (!state.current) {
    showToast('Hãy chọn 1 mã để phân tích trước khi copy JSON!', 'info');
    return;
  }
  navigator.clipboard.writeText(JSON.stringify(state.current, null, 2));
  showToast('Đã sao chép toàn bộ JSON vào bộ nhớ tạm!', 'success');
});

$('btn-quick-scan')?.addEventListener('click', async () => {
  toolsDropdown.classList.remove('open');
  showToast('Đang quét danh mục…', 'info');
  await api('/api/scan', { method: 'POST' });
  await Promise.all([loadWatchlist(), loadAlerts(), loadMovers()]);
  showToast('Đã quét xong toàn bộ danh mục!', 'success');
});

// ---------- Backtest chiến lược ----------
const BT = { strategies: [], chart: null, result: null };
const BT_PARAM_LABELS = {
  score: { buy: 'Điểm mua ≥', sell: 'Điểm bán ≤' },
  ma_cross: { fast: 'MA nhanh', slow: 'MA chậm' },
  rsi_reversion: { low: 'RSI vào <', exit: 'RSI thoát >' },
  breakout: { entry: 'Đỉnh N phiên', exit: 'Đáy M phiên' },
};
const pct = (v, d = 1) => (v == null ? '–' : `${signed(v * 100, d)}%`);

async function initBacktest() {
  BT.strategies = await api('/api/backtest/strategies').catch(() => []);
  $('bt-strategy').innerHTML = BT.strategies.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
  renderBtParams();
}

function renderBtParams() {
  const s = BT.strategies.find((x) => x.id === $('bt-strategy').value);
  if (!s) return;
  const labels = BT_PARAM_LABELS[s.id] || {};
  $('bt-params').innerHTML = Object.entries(s.params).map(([k, v]) =>
    `<label><span>${esc(labels[k] || k)}</span><input name="${k}" type="number" step="1" value="${v}"></label>`).join('');
  $('bt-desc').textContent = s.desc;
}
$('bt-strategy')?.addEventListener('change', renderBtParams);

function resetBacktest(a) {
  $('bt-card').hidden = a.isIndex;
  BT.result = null;
  if (BT.chart) { BT.chart.remove(); BT.chart = null; }
  $('bt-body').innerHTML = `<p class="muted" style="padding:6px 0">Chọn chiến lược rồi bấm <b>Chạy backtest</b> để xem chiến lược đó đã hoạt động ra sao trên ${esc(a.symbol)} trong quá khứ.</p>`;
}

$('bt-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = state.current;
  if (!a) return;
  const q = new URLSearchParams();
  for (const [k, v] of new FormData(e.target)) if (v !== '') q.set(k, v);
  $('bt-run').disabled = true;
  $('bt-body').innerHTML = `<div class="loading-state" style="border:none;padding:30px">
    <div class="radar-spinner"><div class="spinner-ring"></div><div class="spinner-dot"></div></div>
    <span>Đang mô phỏng giao dịch ${esc(a.symbol)}…</span></div>`;
  try {
    const r = await api(`/api/backtest/${a.symbol}?${q}`);
    if (state.current?.symbol !== a.symbol) return;
    BT.result = r;
    renderBacktest(r);
  } catch (err) {
    $('bt-body').innerHTML = `<p class="error" style="padding:16px">${esc(err.message)}</p>`;
  } finally {
    $('bt-run').disabled = false;
  }
});

function btVerdict(r) {
  const m = r.metrics;
  const beatBH = m.totalReturn > r.buyHold.totalReturn;
  const beatIdx = m.benchmarkReturn == null || m.totalReturn > m.benchmarkReturn;
  const few = m.tradeCount < 5;
  if (m.totalReturn <= 0) return ['down', `Chiến lược lỗ ${pct(m.totalReturn)} trong ${r.period.years} năm: tín hiệu này không hiệu quả trên ${r.symbol}.`];
  if (beatBH && beatIdx) return [few ? 'ref' : 'up', `Chiến lược thắng cả mua & nắm giữ (${pct(r.buyHold.totalReturn)}) và VN-Index (${pct(m.benchmarkReturn)})${few ? ', nhưng số lệnh quá ít để tin cậy' : ''}.`];
  if (beatBH) return ['ref', `Có lãi và tốt hơn mua & nắm giữ, nhưng thua VN-Index (${pct(m.benchmarkReturn)}).`];
  return ['ref', `Có lãi nhưng thua mua & nắm giữ (${pct(r.buyHold.totalReturn)}): giao dịch theo tín hiệu chưa tạo giá trị tăng thêm.`];
}

function renderBacktest(r) {
  const m = r.metrics;
  const [tone, verdict] = btVerdict(r);
  const kpi = (k, v, cls = '') => `<div class="fund-item"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const b = r.blocked;
  const blockedTotal = b.ceiling + b.floor + b.settlement;
  const bs = r.bootstrap, wf = r.walkForward;
  const signal = r.currentSignal === 'HOLD'
    ? `<span class="up">đang NẮM GIỮ</span>${r.openPosition ? ` từ ${r.openPosition.entryTime} giá ${fmt(r.openPosition.entryPrice)} (${signed(r.openPosition.returnPct)}%)` : ''}`
    : '<span class="ref">đang ĐỨNG NGOÀI</span>';

  let sens = '';
  if (r.sensitivity) {
    const s = r.sensitivity;
    const cell = (c) => {
      if (!c) return '<td class="muted">–</td>';
      const alpha = Math.min(0.55, Math.abs(c.returnPct) / 120 + 0.08);
      const bg = c.returnPct >= 0 ? `rgba(16,185,129,${alpha})` : `rgba(244,63,94,${alpha})`;
      return `<td style="background:${bg}"><b>${signed(c.returnPct, 1)}%</b><div class="muted small">${c.trades} lệnh</div></td>`;
    };
    sens = `<div class="bt-block"><h4>Độ nhạy tham số <span class="muted small">· lợi nhuận theo ngưỡng mua (cột) × bán (hàng). Kết quả tốt ở nhiều ô lân cận thì đáng tin hơn một ô đơn lẻ.</span></h4>
      <div class="tbl-wrap"><table class="tbl bt-sens"><thead><tr><th>Bán ≤ \\ Mua ≥</th>${s.buys.map((x) => `<th>${x}</th>`).join('')}</tr></thead>
      <tbody>${s.sells.map((sv, i) => `<tr><th>${sv}</th>${s.grid[i].map(cell).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  }

  $('bt-body').innerHTML = `
    <div class="bt-verdict tone-${tone}">${esc(verdict)}</div>
    <div class="muted small" style="margin:6px 0 12px">${esc(r.strategyLabel)} · ${r.period.from} → ${r.period.to} (${r.period.bars} phiên) · sàn ${r.exchange} biên độ ±${Math.round(r.config.band * 100)}% · vốn ${fmtBig(r.config.initialCash)} · Tín hiệu hiện tại: ${signal}${r.currentScore != null ? ` · điểm kỹ thuật ${signed(r.currentScore, 0)}` : ''}</div>
    <div class="ai-levels bt-kpis">
      ${kpi('Lợi nhuận', pct(m.totalReturn), dirClass(m.totalReturn))}
      ${kpi('Mỗi năm', pct(m.annualReturn), dirClass(m.annualReturn))}
      ${kpi('Mua & nắm giữ', pct(r.buyHold.totalReturn), dirClass(r.buyHold.totalReturn))}
      ${kpi('VN-Index', pct(m.benchmarkReturn), dirClass(m.benchmarkReturn))}
      ${kpi('Sụt giảm tối đa', pct(m.maxDrawdown), 'down')}
      ${kpi('Sụt giảm mua & giữ', pct(r.buyHold.maxDrawdown), 'down')}
      ${kpi('Sharpe', fmt(m.sharpe))}
      ${kpi('Sortino', fmt(m.sortino))}
      ${kpi('Số lệnh', fmt(m.tradeCount, 0))}
      ${kpi('Tỷ lệ thắng', m.winRate == null ? '–' : `${fmt(m.winRate * 100, 0)}%`)}
      ${kpi('Profit factor', fmt(m.profitFactor))}
      ${kpi('Lãi TB / Lỗ TB', `${m.avgWinPct == null ? '–' : `+${fmt(m.avgWinPct, 1)}%`} / ${m.avgLossPct == null ? '–' : `${fmt(m.avgLossPct, 1)}%`}`)}
      ${kpi('Giữ TB', m.avgHoldingBars == null ? '–' : `${fmt(m.avgHoldingBars, 0)} phiên`)}
      ${kpi('Thời gian cầm CP', `${fmt(r.exposure * 100, 0)}%`)}
      ${kpi('Phí + thuế', fmtBig(r.fees))}
      ${kpi('Beta', fmt(m.beta))}
    </div>
    <div class="legend" id="bt-legend" style="margin-top:14px">
      <span style="color:var(--accent)">━ Chiến lược</span> · <span style="color:var(--s2)">━ Mua & nắm giữ</span> · <span style="color:var(--muted)">━ VN-Index (cùng vốn)</span>
    </div>
    <div id="bt-chart" class="bt-chart"></div>
    <div class="bt-grid">
      <div class="bt-block"><h4>Kiểm định độ tin cậy</h4>
        ${bs.error ? `<p class="muted small">${esc(bs.error)}</p>` : `<div class="kv">
          <span class="k">Xác suất có lãi (bootstrap ${bs.simulations} lần)</span><span class="v ${bs.probProfit >= 0.7 ? 'up' : bs.probProfit < 0.5 ? 'down' : ''}">${fmt(bs.probProfit * 100, 0)}%</span>
          <span class="k">Lợi nhuận khoảng 5% – 95%</span><span class="v">${pct(bs.returnP5)} → ${pct(bs.returnP95)}</span>
          <span class="k">Sụt giảm xấu (5%)</span><span class="v down">${pct(bs.drawdownP5)}</span></div>`}
        ${wf.error ? '' : `<h4 style="margin-top:12px">Theo giai đoạn <span class="muted small">· ${wf.profitable} lãi, ${wf.losing} lỗ / ${wf.windows.length}</span></h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Giai đoạn</th><th>Lợi nhuận</th><th>Sụt giảm</th><th>Lệnh</th></tr></thead><tbody>
          ${wf.windows.map((w) => `<tr><td>${w.from} → ${w.to}</td><td class="${dirClass(w.returnPct)}">${signed(w.returnPct, 1)}%</td><td class="down">${fmt(w.maxDrawdownPct, 1)}%</td><td>${w.trades}</td></tr>`).join('')}
          </tbody></table></div>`}
      </div>
      <div class="bt-block"><h4>Luật thị trường VN đã áp dụng</h4>
        <div class="kv">
          <span class="k">Lệnh mua bị chặn (mở cửa giá trần)</span><span class="v">${b.ceiling}</span>
          <span class="k">Lệnh bán bị chặn (mở cửa giá sàn)</span><span class="v">${b.floor}</span>
          <span class="k">Lệnh bán phải chờ cổ phiếu về (T+2)</span><span class="v">${b.settlement}</span>
          <span class="k">Phí môi giới / thuế bán</span><span class="v">${fmt(r.config.brokerage * 100, 2)}% / ${fmt(r.config.sellTax * 100, 2)}%</span>
          <span class="k">Trượt giá mỗi lệnh</span><span class="v">${fmt(r.config.slippage * 100, 2)}%</span>
        </div>
        ${blockedTotal ? `<p class="muted small" style="margin-top:8px">${blockedTotal} lần lệnh bị dời sang phiên sau do luật giao dịch — điều mà backtest thông thường bỏ qua.</p>` : ''}
        <ul class="bt-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      </div>
    </div>
    ${sens}
    <div class="bt-block"><h4>Lịch sử giao dịch <span class="muted small">· ${r.trades.length} lệnh gần nhất</span></h4>
      ${r.trades.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mua</th><th>Giá mua</th><th>Bán</th><th>Giá bán</th><th>KL</th><th>Lãi/lỗ</th><th>%</th><th>Giữ</th><th>Lý do</th></tr></thead><tbody>
        ${r.trades.map((t) => `<tr><td>${t.entryTime}</td><td>${fmt(t.entryPrice)}</td><td>${t.exitTime}</td><td>${fmt(t.exitPrice)}</td><td>${fmt(t.shares, 0)}</td>
          <td class="${dirClass(t.pnl)}">${fmtBig(t.pnl)}</td><td class="${dirClass(t.returnPct)}">${signed(t.returnPct)}%</td><td>${t.bars} phiên</td>
          <td>${{ signal: 'Tín hiệu', stop: 'Cắt lỗ', target: 'Chốt lời' }[t.reason] || t.reason}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted small">Không có lệnh nào được đóng trong giai đoạn này.</p>'}
    </div>`;
  renderBtChart(r);
}

function renderBtChart(r) {
  const el = $('bt-chart');
  if (!el || !window.LightweightCharts) return;
  if (BT.chart) { BT.chart.remove(); BT.chart = null; }
  const LC = window.LightweightCharts;
  const chart = LC.createChart(el, {
    autoSize: true,
    layout: { background: { color: css('--surface') }, textColor: css('--muted'), fontFamily: 'Inter, system-ui, sans-serif' },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--axis') },
    timeScale: { borderColor: css('--axis') },
    localization: { locale: 'vi-VN', priceFormatter: (v) => `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr` },
  });
  const line = (color, width = 2) => chart.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: true });
  if (r.curve[0]?.index != null) line(css('--muted'), 1).setData(r.curve.map((p) => ({ time: p.time, value: p.index })));
  line(css('--s2')).setData(r.curve.map((p) => ({ time: p.time, value: p.buyHold })));
  line(css('--accent'), 3).setData(r.curve.map((p) => ({ time: p.time, value: p.equity })));
  chart.timeScale().fitContent();
  BT.chart = chart;
}

// ---------- Hội đồng đầu tư ----------
const CM = { timer: null };
const WINNER = { PHE_MUA: ['up', 'Phe mua thắng'], PHE_BAN: ['down', 'Phe bán thắng'], CAN_BANG: ['ref', 'Hai phe cân bằng'] };

async function loadCommittee(a) {
  clearTimeout(CM.timer);
  $('cm-card').hidden = a.isIndex;
  if (a.isIndex) return;
  $('cm-btn').disabled = !state.ai.enabled;
  if (!state.ai.enabled) {
    $('cm-body').innerHTML = '<p class="muted" style="padding:6px 0">Cần ít nhất một API key AI (GEMINI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY…) trong file .env để triệu tập hội đồng (xem README).</p>';
    return;
  }
  const s = await api(`/api/committee/${a.symbol}`).catch(() => null);
  if (state.current?.symbol !== a.symbol) return;
  renderCommittee(s, a);
  // Mỗi mã/phiên tự chạy quy trình Gemini + hội đồng một lần nếu chưa có quyết định cuối của phiên này
  const r = s?.result;
  const key = `${a.symbol}:${a.price.date}`;
  if (s?.status !== 'running' && !(r?.final && r.priceDate === a.price.date) && !state.aiAuto.has(key)) {
    state.aiAuto.add(key);
    runAiFor(a, false);
  }
}

function renderCommittee(s, a) {
  const running = s?.status === 'running';
  $('cm-btn').disabled = running || !state.ai.enabled;
  $('ai-btn').disabled = running;
  if (running) {
    const stage = `${s.step ? `Bước ${s.step}/${s.steps || 4}: ` : ''}${s.stage || 'Đang họp'}`;
    const changed = state.aiRunning !== a.symbol || state.cmStage !== stage;
    state.aiRunning = a.symbol;
    state.cmStage = stage;
    if (changed) applyAiToDecision(a, state.aiResult);
    $('cm-body').innerHTML = `<div class="loading-state" style="border:none;padding:30px">
      <div class="radar-spinner"><div class="spinner-ring"></div><div class="spinner-dot"></div></div>
      <span>${esc(stage)}… (thường mất 1–3 phút)</span></div>`;
    if (s.step <= 2) {
      $('ai-body').innerHTML = `<div class="loading-state" style="border:none;padding:30px">
        <div class="radar-spinner"><div class="spinner-ring"></div><div class="spinner-dot"></div></div>
        <span>${esc(stage)}…</span></div>`;
    }
    clearTimeout(CM.timer);
    CM.timer = setTimeout(async () => {
      const next = await api(`/api/committee/${a.symbol}`).catch(() => null);
      if (state.current?.symbol === a.symbol) renderCommittee(next, a);
    }, 2500);
    return;
  }
  // Quy trình đã xong (hoặc lỗi): cập nhật Gemini, thẻ quyết định và tóm tắt theo kết quả mới
  const wasRunning = state.aiRunning === a.symbol;
  if (wasRunning) state.aiRunning = null;
  if (s?.status === 'error') state.aiError = { symbol: a.symbol, message: s.error };
  if (s?.result) {
    state.cmResult = s.result;
    if (s.result.gemini) renderAi(s.result.gemini);
    applyAiToDecision(a, s.result.gemini || state.aiResult);
    if (wasRunning) loadWatchlist();
  } else if (wasRunning) applyAiToDecision(a, state.aiResult);
  const err = s?.status === 'error' ? `<p class="error" style="padding:10px 0">Lần họp gần nhất lỗi: ${esc(s.error)}</p>` : '';
  const r = s?.result;
  if (!r) {
    $('cm-body').innerHTML = `${err}<p class="muted" style="padding:6px 0">Chưa có phiên họp nào cho ${esc(a.symbol)}. Bấm <b>Triệu tập hội đồng</b>: phe mua và phe bán lập luận độc lập, sau đó giám đốc đầu tư bác bỏ luận điểm thiếu căn cứ và ra quyết định.</p>`;
    return;
  }
  const v = r.verdict;
  const [wTone, wLabel] = WINNER[v.winner] || WINNER.CAN_BANG;
  const close = a.price.close;
  const stale = r.price !== close;
  const ptsList = (items, cls) => `<ul class="cm-points">${items.map((p) => `<li><span class="cm-lv ${p.level === 'CAO' ? cls : ''}">${p.level === 'CAO' ? 'Mạnh' : 'Vừa'}</span>${esc(p.text)}</li>`).join('')}</ul>`;
  const list = (title, items, cls = '') => (items?.length ? `<div><h4 class="${cls}">${title}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  const pctFrom = (x) => ` <span class="muted small">${signed(((x - close) / close) * 100, 1)}%</span>`;
  const levels = [
    v.entryZone && ['Vùng mua', `${fmt(v.entryZone.from)} – ${fmt(v.entryZone.to)}`, ''],
    v.stopLoss != null && ['Cắt lỗ', fmt(v.stopLoss) + pctFrom(v.stopLoss), 'down'],
    ...v.targets.map((t, i) => [`Mục tiêu ${i + 1}`, fmt(t) + pctFrom(t), 'up']),
    r.bull.targetPrice != null && ['Mục tiêu phe mua', fmt(r.bull.targetPrice) + pctFrom(r.bull.targetPrice), 'up'],
    r.bear.downsidePrice != null && ['Rủi ro phe bán', fmt(r.bear.downsidePrice) + pctFrom(r.bear.downsidePrice), 'down'],
    ['Khung thời gian', esc(v.horizon), ''],
  ].filter(Boolean);

  $('cm-body').innerHTML = `${err}
    <div class="ai-head">
      <span class="recommendation-badge ${v.decision}">${esc(v.decisionLabel)}</span>
      <span>Độ tin cậy <b>${v.confidence}%</b></span>
      <span class="tag ${wTone}">${wLabel}</span>
      <span class="muted small">${esc(r.model)} · ${new Date(r.createdAt).toLocaleString('vi-VN')} · tại giá ${fmt(r.price)}${stale ? ' (giá đã đổi, nên họp lại)' : ''} · điểm hệ thống ${signed(r.ruleScore.total, 0)} (${esc(r.ruleScore.label)})</span>
    </div>
    <p class="ai-summary">${esc(v.debateSummary)}</p>
    <div class="cm-debate">
      <div class="cm-side cm-bull"><h4 class="up">▲ Phe mua</h4>${ptsList(r.bull.points, 'up')}
        ${r.bull.technical ? `<p><b>Kỹ thuật:</b> ${esc(r.bull.technical)}</p>` : ''}
        ${r.bull.fundamental ? `<p><b>Cơ bản:</b> ${esc(r.bull.fundamental)}</p>` : ''}
        <div class="ai-lists">${list('Chất xúc tác', r.bull.catalysts)}${list('Kịch bản sai', r.bull.invalidation, 'down')}</div>
      </div>
      <div class="cm-side cm-bear"><h4 class="down">▼ Phe bán</h4>${ptsList(r.bear.points, 'down')}
        ${r.bear.technical ? `<p><b>Kỹ thuật:</b> ${esc(r.bear.technical)}</p>` : ''}
        ${r.bear.valuation ? `<p><b>Định giá:</b> ${esc(r.bear.valuation)}</p>` : ''}
        ${r.bear.riskMetrics ? `<p><b>Chỉ số rủi ro:</b> ${esc(r.bear.riskMetrics)}</p>` : ''}
        <div class="ai-lists">${list('Tín hiệu bác bỏ luận điểm bán', r.bear.disproof, 'up')}</div>
      </div>
    </div>
    <h4 style="margin:16px 0 8px">⚖️ Thẩm định của giám đốc đầu tư</h4>
    <div class="ai-lists">
      ${list('Chấp nhận từ phe mua', v.acceptedBull, 'up')}
      ${list('Chấp nhận từ phe bán', v.acceptedBear, 'down')}
      ${list('Bác bỏ (phe mua)', v.rejectedBull, 'muted')}
      ${list('Bác bỏ (phe bán)', v.rejectedBear, 'muted')}
    </div>
    <div class="ai-actions" style="margin-top:12px">
      <div class="ai-box"><h4>Bằng chứng lịch sử (backtest)</h4>${esc(v.backtestView)}${r.backtest ? `<div class="muted small" style="margin-top:6px">${esc(r.backtest.brief)}</div>` : ''}</div>
      <div class="ai-box"><h4>Đánh giá rủi ro</h4>${esc(v.riskReview)}${r.risk ? `<div class="muted small" style="margin-top:6px">Biến động năm ${pct(r.risk.volatility)} · VaR95 ${pct(-r.risk.var95)} · CVaR95 ${pct(-r.risk.cvar95)} · beta ${fmt(r.risk.beta)}</div>` : ''}</div>
    </div>
    <div class="ai-actions">
      <div class="ai-box"><h4>Hành động</h4>${esc(v.action)}</div>
      <div class="ai-box"><h4>Tỷ trọng & giải ngân</h4>${esc(v.positionSizing)}</div>
    </div>
    <div class="ai-levels">${levels.map(([k, val, cls]) => `<div class="fund-item"><div class="k">${k}</div><div class="v ${cls}">${val}</div></div>`).join('')}</div>
    <div class="ai-lists">${list('Điều kiện để đổi quyết định', v.conditionsToChange)}</div>
    <p class="ai-note">3 lượt gọi Gemini · ${r.tokens ? `${r.tokens.toLocaleString('vi-VN')} tokens · ` : ''}${Math.round(r.durationMs / 1000)}s. AI có thể sai; hãy đối chiếu với dữ liệu định lượng.</p>`;
}

$('cm-btn')?.addEventListener('click', () => state.current && runAiFor(state.current, false));

// ---------- Danh mục đầu tư ----------
function showPortfolio() {
  ['empty', 'error', 'report', 'loading', 'picks', 'rankview', 'sectorview'].forEach((id) => ($(id).hidden = true));
  $('sector-btn')?.classList.remove('on');
  $('picks-btn')?.classList.remove('on');
  $('rank-btn')?.classList.remove('on');
  $('portfolio').hidden = false;
  $('pf-btn')?.classList.add('on');
  history.replaceState(null, '', '#danh-muc');
  const form = $('pf-form');
  if (!form.date.value) form.date.value = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
  loadPortfolio();
}

async function loadPortfolio() {
  $('pf-body').innerHTML = '<div class="card muted">Đang tải giá và tính toán danh mục…</div>';
  try {
    renderPortfolio(await api('/api/portfolio'));
  } catch (err) {
    $('pf-body').innerHTML = `<div class="card error">${esc(err.message)}</div>`;
  }
}

function renderPortfolio(p) {
  const s = p.summary;
  const kpi = (k, v, cls = '') => `<div class="fund-item"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const symLink = (sym) => `<a href="#${sym}" class="pf-sym" data-sym="${sym}">${sym}</a>`;
  const rk = p.risk;
  const bh = p.behavior;

  const holdings = p.holdings.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th>Mã</th><th>KL</th><th>Bán được</th><th>Giá vốn</th><th>Giá</th><th>Giá trị</th><th>Tỷ trọng</th><th>Lãi/lỗ*</th><th>%</th><th>Hôm nay</th><th>Điểm KT</th><th>Xu hướng</th></tr></thead><tbody>
      ${p.holdings.map((h) => `<tr class="${h.belowStop ? 'pf-alert' : ''}">
        <td>${symLink(h.symbol)}${h.belowStop ? ' <span class="down" title="Giá dưới mức cắt lỗ kỹ thuật">⚠</span>' : ''}</td>
        <td>${fmt(h.qty, 0)}</td>
        <td>${fmt(h.sellable, 0)}${h.pending ? ` <span class="muted small" title="Chưa về tài khoản (T+2)">(+${fmt(h.pending, 0)} chờ về)</span>` : ''}</td>
        <td>${fmt(h.avgCost)}</td><td>${fmt(h.close)}</td><td>${fmtBig(h.marketValue)}</td><td>${fmt(h.weight * 100, 1)}%</td>
        <td class="${dirClass(h.unrealized)}">${fmtBig(h.unrealized)}</td><td class="${dirClass(h.unrealizedPct)}">${signed(h.unrealizedPct)}%</td>
        <td class="${dirClass(h.dayChange)}">${fmtBig(h.dayChange)}</td>
        <td class="${dirClass(h.tech?.score)}">${h.tech ? signed(h.tech.score, 0) : '–'}</td>
        <td>${esc(h.tech?.trend || '–')}${h.tech?.stopLoss ? `<div class="muted small">cắt lỗ KT ${fmt(h.tech.stopLoss)}</div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small" style="margin-top:6px">* Lãi/lỗ tạm tính đã trừ phí bán ${fmt(p.fees.brokerage * 100, 2)}% và thuế ${fmt(p.fees.sellTax * 100, 2)}%. Giá vốn bình quân gồm phí mua.</p>`
    : '<p class="muted">Chưa có vị thế nào. Ghi lệnh mua ở form phía trên.</p>';

  const riskCard = rk ? `<section class="card"><div class="card-head"><h3>🩻 X-quang rủi ro danh mục</h3><span class="badge-subtle">${rk.days} phiên gần nhất</span></div>
    ${rk.warnings.map((w) => `<div class="warning">${esc(w)}</div>`).join('')}
    <div class="ai-levels" style="margin-top:10px">
      ${kpi('Số mã hiệu dụng', fmt(rk.concentration.effectiveN, 1))}
      ${kpi(`Lớn nhất (${rk.concentration.top})`, `${fmt(rk.concentration.topWeight * 100, 0)}%`)}
      ${kpi('Biến động năm', rk.volatility != null ? `${fmt(rk.volatility * 100, 1)}%` : '–')}
      ${kpi('VaR95 1 phiên', rk.var95 != null ? `${fmt(rk.var95 * 100, 1)}% · ${fmtBig(rk.var95Value)}` : '–', 'down')}
      ${kpi('CVaR95 1 phiên', rk.cvar95 != null ? `${fmt(rk.cvar95 * 100, 1)}% · ${fmtBig(rk.cvar95Value)}` : '–', 'down')}
      ${kpi('Sụt giảm tối đa 1 năm', pct(rk.maxDrawdown), 'down')}
      ${kpi('Beta với VN-Index', fmt(rk.beta))}
      ${kpi('Tương quan TB', fmt(rk.avgCorrelation))}
      ${kpi('Hệ số đa dạng hóa', fmt(rk.diversificationRatio))}
      ${rk.topPair ? kpi('Cặp tương quan nhất', `${rk.topPair.a}–${rk.topPair.b} ${fmt(rk.topPair.corr)}`) : ''}
    </div>
    <p class="muted small" style="margin-top:8px">VaR95: 95% số phiên trong năm qua không lỗ quá mức này với tỷ trọng hiện tại. Hệ số đa dạng hóa &gt; 1,3 là tốt.</p></section>` : '';

  const behaviorCard = bh ? `<section class="card"><div class="card-head"><h3>🪞 Chẩn đoán hành vi giao dịch</h3><span class="badge-subtle">${bh.closedCount} lệnh đã chốt</span></div>
    <div class="ai-levels">
      ${kpi('Tỷ lệ thắng', `${fmt(bh.winRate * 100, 0)}%`)}
      ${kpi('Lãi TB / Lỗ TB', `${bh.avgWinPct != null ? `+${fmt(bh.avgWinPct, 1)}%` : '–'} / ${bh.avgLossPct != null ? `${fmt(bh.avgLossPct, 1)}%` : '–'}`)}
      ${kpi('Giữ lệnh lãi / lỗ', `${bh.avgHoldWin ?? '–'} / ${bh.avgHoldLoss ?? '–'} ngày`)}
      ${kpi('Profit factor', fmt(bh.profitFactor))}
      ${kpi('Lãi đã chốt', fmtBig(bh.realized), dirClass(bh.realized))}
    </div>
    ${bh.insights.length ? `<ul class="pf-insights">${bh.insights.map((i) => `<li class="tone-${i.tone}">${esc(i.text)}</li>`).join('')}</ul>` : '<p class="muted small">Chưa phát hiện thói quen bất lợi rõ ràng (cần ít nhất 4 lệnh đã chốt để đánh giá).</p>'}
    </section>` : '';

  const txs = p.transactions.length ? `<section class="card"><div class="card-head"><h3>📒 Nhật ký lệnh</h3><span class="badge-subtle">${p.transactions.length} lệnh</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Ngày</th><th>Lệnh</th><th>Mã</th><th>KL</th><th>Giá</th><th>Giá trị</th><th>Ghi chú</th><th></th></tr></thead><tbody>
    ${p.transactions.map((t) => `<tr><td>${t.date}</td><td class="${t.type === 'BUY' ? 'up' : 'down'}">${t.type === 'BUY' ? 'Mua' : 'Bán'}</td><td>${symLink(t.symbol)}</td>
      <td>${fmt(t.qty, 0)}</td><td>${fmt(t.price)}</td><td>${fmtBig(t.qty * t.price * 1000)}</td><td class="muted small">${esc(t.note)}</td>
      <td><button type="button" class="btn btn-glass btn-xs" data-del="${esc(t.id)}" title="Xóa lệnh">✕</button></td></tr>`).join('')}
    </tbody></table></div>
    ${p.closed.length ? `<h4 style="margin:14px 0 6px">Lệnh bán đã chốt</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Ngày</th><th>Mã</th><th>KL</th><th>Giá vốn</th><th>Giá bán</th><th>Lãi/lỗ</th><th>%</th><th>Giữ</th></tr></thead><tbody>
      ${p.closed.map((c) => `<tr><td>${c.date}</td><td>${symLink(c.symbol)}</td><td>${fmt(c.qty, 0)}</td><td>${fmt(c.avgCost)}</td><td>${fmt(c.sellPrice)}</td>
        <td class="${dirClass(c.pnl)}">${fmtBig(c.pnl)}</td><td class="${dirClass(c.returnPct)}">${signed(c.returnPct)}%</td><td>${c.holdDays ?? '–'} ngày</td></tr>`).join('')}
    </tbody></table></div>` : ''}</section>` : '';

  $('pf-sub').textContent = `${s.positions} mã đang nắm giữ · cập nhật ${new Date(p.updatedAt).toLocaleTimeString('vi-VN')}`;
  $('pf-body').innerHTML = `
    <section class="card"><div class="ai-levels" style="margin:0">
      ${kpi('Giá trị thị trường', fmtBig(s.marketValue))}
      ${kpi('Giá vốn', fmtBig(s.cost))}
      ${kpi('Lãi/lỗ tạm tính', `${fmtBig(s.unrealized)} (${signed(s.unrealizedPct)}%)`, dirClass(s.unrealized))}
      ${kpi('Biến động hôm nay', fmtBig(s.dayChange), dirClass(s.dayChange))}
      ${kpi('Lãi đã chốt', fmtBig(s.realized), dirClass(s.realized))}
    </div></section>
    <section class="card"><div class="card-head"><h3>📊 Vị thế đang nắm giữ</h3></div>${holdings}</section>
    ${riskCard}${behaviorCard}${txs}`;
}

$('pf-btn')?.addEventListener('click', showPortfolio);
$('pf-refresh')?.addEventListener('click', loadPortfolio);
$('pf-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.symbol = body.symbol.trim().toUpperCase();
  try {
    await api('/api/portfolio/tx', { method: 'POST', body: JSON.stringify(body) });
    showToast(`Đã ghi lệnh ${body.type === 'BUY' ? 'mua' : 'bán'} ${body.qty} ${body.symbol}`, 'success');
    e.target.qty.value = '';
    e.target.price.value = '';
    e.target.note.value = '';
    loadPortfolio();
  } catch (err) {
    showToast(err.message, 'error', 5000);
  }
});
$('pf-body')?.addEventListener('click', async (e) => {
  const sym = e.target.closest('.pf-sym');
  if (sym) {
    e.preventDefault();
    analyze(sym.dataset.sym);
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del && confirm('Xóa lệnh này khỏi nhật ký?')) {
    try {
      await api(`/api/portfolio/tx/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' });
      loadPortfolio();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }
});

initBacktest();

// ---------- Kiểm tra các API key AI ----------
$('btn-ai-check')?.addEventListener('click', async () => {
  showToast('Đang gửi yêu cầu thử tới từng nhà cung cấp AI…', 'info', 2500);
  try {
    const list = await api('/api/ai/test', { method: 'POST' });
    if (!list.length) return showToast('Chưa có API key AI nào trong file .env', 'error', 6000);
    list.forEach((r, i) => setTimeout(() => showToast(r.ok
      ? `✓ ${r.provider}: hoạt động (${r.model}, ${(r.ms / 1000).toFixed(1)}s)`
      : `${r.provider}: ${r.error}`, r.ok ? 'success' : 'error', 9000), i * 300));
    state.ai = await api('/api/ai/status').catch(() => state.ai);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------- Xếp hạng 4 yếu tố ----------
const RK = { chart: null, result: null };
const RANK_TONE = { STRONG: 'up', WAIT: 'ref', GOOD: 'up', AVERAGE: 'ref', WEAK: 'down', NA: 'ref' };
const FACTOR_LABELS = { mom: 'Động lượng 12T', high: 'Gần đỉnh 52 tuần', atr: 'Biến động thấp', adx: 'Xu hướng (ADX)' };

function rankBar(v) {
  return `<div class="rk-bar"><i style="width:${Math.max(2, v)}%" class="${v >= 60 ? 'pos' : v < 40 ? 'neg' : ''}"></i></div>`;
}

function renderRankCard(a) {
  const el = $('rank-card');
  const r = a.ranking;
  el.hidden = a.isIndex || !r;
  if (el.hidden) return;
  const f = r.factors;
  const raw = { mom: pct(f.mom), high: pct(f.high), atr: f.atr != null ? `${fmt(f.atr * 100, 1)}%/phiên` : '–', adx: fmt(f.adx, 0) };
  el.innerHTML = `
    <div class="card-head" style="margin-bottom:10px">
      <div>
        <h3>🎯 Điểm xếp hạng 4 yếu tố <span class="badge-subtle">đã kiểm chứng ngoài mẫu</span></h3>
        <div class="muted small">Hạng ${r.position}/${r.universe} trong rổ HOSE ≥ 5 tỷ/phiên · ${r.aboveMa200 === false ? '<span class="down">giá dưới MA200</span>' : '<span class="up">giá trên MA200</span>'}</div>
        <div class="small" style="margin-top:4px">${r.pfRank == null ? '<span class="down">Ngoài nhóm mua/giữ (dưới MA200)</span>'
          : r.pfRank <= 8 ? `<span class="up">▲ Thuộc danh mục mẫu: hạng ${r.pfRank} trong nhóm trên MA200 (top 8)</span>`
          : `<span class="ref">Hạng ${r.pfRank} trong nhóm trên MA200 (ngoài danh mục mẫu top 8)</span>`}</div>
      </div>
      <div class="rk-score ${RANK_TONE[r.code]}"><b>${r.score}</b><span>/100</span><div>${esc(r.label)}</div></div>
    </div>
    <div class="rk-factors">
      ${Object.keys(FACTOR_LABELS).filter((k) => r.parts[k] != null).map((k) => `
        <div class="rk-factor"><div class="k">${FACTOR_LABELS[k]} <span class="muted">${raw[k]}</span></div>${rankBar(r.parts[k])}<div class="v">${r.parts[k]}</div></div>`).join('')}
    </div>
    <p class="muted small" style="margin:10px 0 0">Điểm ≥ 70 và trên MA200 = nhóm dẫn đầu (tín hiệu mua). Điểm &lt; 30 = nhóm đội sổ (nên tránh). Điểm này dùng để <b>so sánh, chọn mã mạnh hơn thị trường</b>, nên đọc cùng khung 20 phiên trở lên.
      <a href="#xep-hang" id="rk-open-view">Xem bảng xếp hạng →</a></p>`;
}
$('rank-card')?.addEventListener('click', (e) => {
  if (e.target.id === 'rk-open-view') { e.preventDefault(); showRankView(); }
});

function showRankView() {
  ['empty', 'error', 'report', 'loading', 'picks', 'portfolio', 'sectorview'].forEach((id) => ($(id).hidden = true));
  $('sector-btn')?.classList.remove('on');
  $('picks-btn')?.classList.remove('on');
  $('pf-btn')?.classList.remove('on');
  $('rankview').hidden = false;
  $('rank-btn')?.classList.add('on');
  history.replaceState(null, '', '#xep-hang');
  loadRankBoard();
  loadPredictions();
  if (RK.result) renderRankBacktest(RK.result);
}

async function loadRankBoard() {
  $('rk-board').innerHTML = '<p class="muted">Đang tính bảng xếp hạng…</p>';
  try {
    const b = await api('/api/rank');
    $('rk-sub').textContent = `Phiên ${b.date} · ${b.universe} mã sàn ${b.criteria.floors.join(', ')} có giá trị giao dịch TB 20 phiên ≥ ${fmt(b.criteria.minValue / 1e9, 1)} tỷ · cập nhật ${new Date(b.updatedAt).toLocaleTimeString('vi-VN')}`;
    $('rk-board').innerHTML = `<div class="tbl-wrap"><table class="tbl rk-table"><thead><tr><th>#</th><th>Mã</th><th>Giá</th><th>Hôm nay</th><th>GTGD TB20</th><th>Điểm</th><th>Đánh giá</th>
      ${Object.values(FACTOR_LABELS).map((l) => `<th>${l}</th>`).join('')}<th>MA200</th></tr></thead><tbody>
      ${b.rows.map((r, i) => `<tr class="${r.pfRank != null && r.pfRank <= 8 ? 'rk-top' : ''}">
        <td>${i + 1}</td><td><a href="#${r.symbol}" class="pf-sym" data-sym="${r.symbol}">${r.symbol}</a></td>
        <td>${fmt(r.close)}</td><td class="${dirClass(r.changePct)}">${signed(r.changePct)}%</td><td>${fmt(r.value20 / 1e9, 1)} tỷ</td>
        <td><b class="${RANK_TONE[r.code]}">${r.score}</b></td><td class="${RANK_TONE[r.code]}" style="font-family:inherit">${esc(r.label)}</td>
        <td>${pct(r.factors.mom)}</td><td>${pct(r.factors.high)}</td><td>${r.factors.atr != null ? `${fmt(r.factors.atr * 100, 1)}%` : '–'}</td><td>${fmt(r.factors.adx, 0)}</td>
        <td>${r.aboveMa200 === false ? '<span class="down">dưới</span>' : '<span class="up">trên</span>'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small" style="margin-top:6px">Hàng tô sáng = top 8 trên MA200 (danh mục mẫu, tự ghi vào nhật ký dự đoán mỗi phiên). Bấm mã để phân tích chi tiết.</p>`;
  } catch (err) {
    $('rk-board').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}
$('rk-board')?.addEventListener('click', (e) => {
  const s = e.target.closest('.pf-sym');
  if (s) { e.preventDefault(); analyze(s.dataset.sym); }
});

$('rk-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = new URLSearchParams(new FormData(e.target));
  $('rk-run').disabled = true;
  $('rk-bt').innerHTML = `<div class="loading-state" style="border:none;padding:30px">
    <div class="radar-spinner"><div class="spinner-ring"></div><div class="spinner-dot"></div></div><span>Đang mô phỏng danh mục…</span></div>`;
  try {
    RK.result = await api(`/api/rank/backtest?${q}`);
    renderRankBacktest(RK.result);
  } catch (err) {
    $('rk-bt').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  } finally {
    $('rk-run').disabled = false;
  }
});

function renderRankBacktest(r) {
  const m = r.metrics, ac = r.accuracy;
  const kpi = (k, v, cls = '') => `<div class="fund-item"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const beat = m.totalReturn > (m.benchmarkReturn ?? 0);
  $('rk-bt').innerHTML = `
    <div class="bt-verdict tone-${beat ? 'up' : 'down'}">Danh mục top ${r.config.top} ${beat ? 'thắng' : 'thua'} VN-Index: ${pct(m.totalReturn)} so với ${pct(m.benchmarkReturn)}
      (rổ chia đều ${pct(r.equalWeight.totalReturn)}). Thắng chỉ số ${ac.periodsBeatIndex}/${ac.periods} kỳ, ${fmt((ac.picksBeatIndex / ac.picks) * 100, 0)}% số mã được chọn thắng chỉ số.</div>
    <div class="muted small" style="margin:6px 0 12px">${r.period.from} → ${r.period.to} · ${r.config.universe} mã · tái cơ cấu mỗi ${r.config.rebalance} phiên · giữ mã còn trong top ${r.config.top * (r.config.buffer ?? 1)} · ${r.config.trendFilter ? 'có' : 'không'} lọc MA200 · khi VN-Index yếu: ${{ none: 'vẫn đầy vốn', half: 'giữ nửa số mã', cash: 'cầm tiền' }[r.config.regime]} (${r.regime.bearPeriods}/${r.regime.periods} kỳ thị trường yếu, hiện tại ${r.regime.now === 'bear' ? '<span class="down">yếu</span>' : '<span class="up">tốt</span>'}) · vốn ${fmtBig(r.config.initialCash)}</div>
    <div class="ai-levels bt-kpis">
      ${kpi('Lợi nhuận', pct(m.totalReturn), dirClass(m.totalReturn))}
      ${kpi('Mỗi năm', pct(m.annualReturn), dirClass(m.annualReturn))}
      ${kpi('VN-Index', pct(m.benchmarkReturn), dirClass(m.benchmarkReturn))}
      ${kpi('Rổ chia đều', pct(r.equalWeight.totalReturn), dirClass(r.equalWeight.totalReturn))}
      ${kpi('Sụt giảm tối đa', pct(m.maxDrawdown), 'down')}
      ${kpi('Sharpe', fmt(m.sharpe))}
      ${kpi('Kỳ thắng VN-Index', `${ac.periodsBeatIndex}/${ac.periods} (${fmt((ac.periodsBeatIndex / ac.periods) * 100, 0)}%)`, 'up')}
      ${kpi('Vượt VN-Index TB/kỳ', pct(ac.avgExcess, 2), dirClass(ac.avgExcess))}
      ${kpi('Lệnh / tỷ lệ thắng', `${m.tradeCount} / ${fmt(m.winRate * 100, 0)}%`)}
      ${kpi('Phí + thuế', fmtBig(r.fees))}
    </div>
    <div class="legend"><span style="color:var(--accent)">━ Danh mục top ${r.config.top}</span> · <span style="color:var(--s2)">━ Rổ chia đều</span> · <span style="color:var(--muted)">━ VN-Index</span></div>
    <div id="rk-chart" class="bt-chart"></div>
    <div class="bt-grid">
      <div class="bt-block"><h4>Các kỳ gần nhất</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Kỳ</th><th>Danh mục</th><th>VN-Index</th><th>Chênh</th></tr></thead><tbody>
        ${r.periods.slice(0, 12).map((p) => `<tr title="${p.picks.map((x) => `${x.symbol} ${pct(x.ret)}`).join(', ')}"><td>${p.from}${p.open ? ' (đang chạy)' : ''}</td>
          <td class="${dirClass(p.ret)}">${pct(p.ret)}</td><td class="${dirClass(p.indexReturn)}">${pct(p.indexReturn)}</td><td class="${dirClass(p.excess)}">${pct(p.excess)}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="bt-block"><h4>Danh mục đang nắm giữ (theo mô phỏng)</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mã</th><th>Từ ngày</th><th>Giá mua</th><th>Lãi/lỗ</th></tr></thead><tbody>
        ${r.holdings.map((h) => `<tr><td>${h.symbol}</td><td>${h.since}</td><td>${fmt(h.price)}</td><td class="${dirClass(h.returnPct)}">${signed(h.returnPct)}%</td></tr>`).join('')}
      </tbody></table></div>
      <ul class="bt-notes"><li>Mỗi kỳ chỉ chọn mã đạt ngưỡng thanh khoản tại thời điểm đó, nhưng danh sách mã lấy từ các mã đang niêm yết hôm nay nên kết quả quá khứ vẫn có thể đẹp hơn thực tế (thiên lệch sống sót).</li>
        <li>Kiểm tra thực tế ở phần "Độ chính xác dự đoán" bên dưới: top 8 được ghi lại mỗi phiên và chấm bằng giá thật.</li></ul></div>
    </div>`;
  if (!window.LightweightCharts) return;
  if (RK.chart) { RK.chart.remove(); RK.chart = null; }
  const LC = window.LightweightCharts;
  const chart = LC.createChart($('rk-chart'), {
    autoSize: true,
    layout: { background: { color: css('--surface') }, textColor: css('--muted'), fontFamily: 'Inter, system-ui, sans-serif' },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--axis') }, timeScale: { borderColor: css('--axis') },
    localization: { locale: 'vi-VN', priceFormatter: (v) => `${(v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr` },
  });
  const line = (color, w) => chart.addLineSeries({ color, lineWidth: w, priceLineVisible: false });
  line(css('--muted'), 1).setData(r.curve.map((p) => ({ time: p.time, value: p.index })));
  line(css('--s2'), 2).setData(r.curve.map((p) => ({ time: p.time, value: p.equalWeight })));
  line(css('--accent'), 3).setData(r.curve.map((p) => ({ time: p.time, value: p.equity })));
  chart.timeScale().fitContent();
  RK.chart = chart;
}

async function loadPredictions() {
  $('pd-body').innerHTML = '<p class="muted">Đang chấm các dự đoán…</p>';
  try {
    const p = await api('/api/predictions');
    const cell = (x) => {
      if (!x.evaluated) return '<td class="muted">chưa đủ phiên</td>';
      const hit = x.hitRate * 100;
      return `<td><b class="${hit >= 55 ? 'up' : hit < 45 ? 'down' : ''}">${fmt(hit, 0)}%</b> <span class="muted small">đúng / ${x.evaluated}</span>
        ${x.beatIndexRate != null ? `<div class="muted small">thắng VNI ${fmt(x.beatIndexRate * 100, 0)}%${x.buyAvgReturn != null ? ` · mua TB ${pct(x.buyAvgReturn)}` : ''}</div>` : ''}</td>`;
    };
    const RES = (it) => {
      const h = [5, 10, 20].filter((k) => it.result?.[k]);
      if (!it.direction) return '<span class="muted">trung tính</span>';
      if (!h.length) return '<span class="muted">chờ</span>';
      return h.map((k) => { const r = it.result[k]; return `<span class="${r.correct ? 'up' : 'down'}">${k}p ${r.correct ? '✓' : '✕'} ${pct(r.ret)}</span>`; }).join(' · ');
    };
    $('pd-body').innerHTML = `
      <p class="muted small" style="margin:0 0 10px">Đã ghi ${p.totalItems} dự đoán${p.firstDate ? ` từ ${p.firstDate}` : ''}. "Đúng" = dự đoán mua mà giá tăng, hoặc dự đoán tránh/bán mà giá giảm.
        Tỷ lệ ngẫu nhiên ≈ 50%; cần ít nhất vài chục dự đoán đã chấm mới đáng tin.</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Nguồn dự đoán</th><th>Đã ghi</th><th>Đang chờ</th><th>Sau 5 phiên</th><th>Sau 10 phiên</th><th>Sau 20 phiên</th></tr></thead><tbody>
        ${p.summary.map((s) => `<tr><td style="font-family:inherit"><b>${esc(s.label)}</b></td><td>${s.total}</td><td>${s.pending}</td>${s.horizons.map(cell).join('')}</tr>`).join('')}
      </tbody></table></div>
      ${p.recent.length ? `<details style="margin-top:12px"><summary class="muted small" style="cursor:pointer">Dự đoán gần đây (${p.recent.length})</summary>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Phiên</th><th>Nguồn</th><th>Mã</th><th>Dự đoán</th><th>Giá</th><th>Kết quả</th></tr></thead><tbody>
        ${p.recent.map((it) => `<tr><td>${it.date}</td><td style="font-family:inherit">${esc(p.summary.find((s) => s.source === it.source)?.label || it.source)}</td>
          <td><a href="#${it.symbol}" class="pf-sym" data-sym="${it.symbol}">${it.symbol}</a></td>
          <td class="${it.direction > 0 ? 'up' : it.direction < 0 ? 'down' : ''}" style="font-family:inherit">${esc(it.label)}</td><td>${fmt(it.price)}</td><td>${RES(it)}</td></tr>`).join('')}
        </tbody></table></div></details>` : ''}`;
  } catch (err) {
    $('pd-body').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}
$('pd-refresh')?.addEventListener('click', loadPredictions);
$('pd-body')?.addEventListener('click', (e) => {
  const s = e.target.closest('.pf-sym');
  if (s) { e.preventDefault(); analyze(s.dataset.sym); }
});
$('rank-btn')?.addEventListener('click', showRankView);

// ---------- Tóm tắt nhanh mỗi mã ----------
const BRIEF_ICON = { up: '▲', down: '▼', ref: '•' };

function briefText(a) {
  const b = { ...a.brief, ...(() => { const e = effectiveBrief(a); return { verdict: e.verdict, action: e.action, steps: e.steps, fin: e.fin }; })() }, l = b.levels;
  const lines = [`${a.symbol} — ${b.verdict} (${b.headline}) · giá ${fmt(a.price.close)} ngày ${a.price.date}`, `→ ${b.action}`];
  if (b.fin) {
    lines.push(`AI thẩm định: ${b.fin.note}`);
    for (const c of b.fin.marketChecks) lines.push(`  ${CHECK_ICON[c.status][0]} ${c.label}: ${c.note}`);
  }
  const stepLine = (x) => `  - [${SIDE[x.side][0]}] ${x.zone ? `${fmt(x.zone[0])}–${fmt(x.zone[1])}` : x.price != null ? fmt(x.price) : ''}${x.portion ? ` · ${Math.round(x.portion * 100)}% vốn` : x.side === 'buy' && x.portionOfHolding ? ` · +${Math.round(x.portionOfHolding * 100)}% số đang giữ` : ''}${(() => { const q = stepQty(x, capitalM() * 1e6); return q?.shares ? ` · ${q.shares.toLocaleString('vi-VN')} cp ≈ ${money(q.vnd)}` : ''; })()} · ${x.condition}`;
  if (b.steps) {
    lines.push('Nếu CHƯA có cổ phiếu:', ...b.steps.fresh.map(stepLine));
    lines.push(`Nếu ĐANG nắm giữ:${b.plays?.position ? ` (${b.plays.position})` : ''}`);
    const h = b.fin?.holder;
    if (h) {
      lines.push(`  ${h.addLabel}: ${h.addReason}`);
      if (h.holdView) lines.push(`  ${h.holdView}`);
      for (const z of h.noAdd) lines.push(`  Không mua thêm khi giá ${z.side === 'DUOI' ? 'dưới' : 'trên'} ${fmt(z.price)}: ${z.reason}`);
    }
    lines.push(...b.steps.hold.map(stepLine));
  }
  lines.push('Vì sao:');
  for (const r of b.reasons) lines.push(`${BRIEF_ICON[r.tone]} ${r.text}`);
  if (l) lines.push(`Bậc thang giá: KC2 ${fmt(l.r2)} · KC1 ${fmt(l.r1)} · giá ${fmt(l.close)} · HT1 ${fmt(l.s1)}${l.s2 != null ? ` · HT2 ${fmt(l.s2)}` : ''} · cắt lỗ ${fmt(l.stop)}`);
  if (b.risks.length) lines.push(`Rủi ro: ${b.risks.join('; ')}`);
  return lines.join('\n');
}

// Vốn dùng để quy đổi tỷ trọng ra số cổ phiếu (lưu trên trình duyệt này)
const capitalM = () => { try { return Number(localStorage.getItem('vnstock_capital')) || 0; } catch { return 0; } };
const SIDE = { buy: ['Mua', 'up'], sell: ['Bán', 'down'], stop: ['Cắt lỗ', 'down'], wait: ['Chờ', 'ref'] };

/** Số tiền dễ đọc: 1,25 tỷ · 125,4 triệu · 850 nghìn. */
function money(vnd) {
  const v = Math.abs(vnd);
  if (v >= 1e9) return `${(vnd / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ`;
  if (v >= 1e6) return `${(vnd / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} triệu`;
  return `${Math.round(vnd / 1e3).toLocaleString('vi-VN')} nghìn`;
}

/** Số cp mua được với số tiền (giá nghìn đồng): ưu tiên lô chẵn 100, không đủ thì lô lẻ. */
function sharesFor(vnd, price) {
  const raw = Math.floor(vnd / (price * 1000));
  const shares = raw >= 100 ? Math.floor(raw / 100) * 100 : raw;
  return { shares, odd: shares > 0 && shares < 100 };
}

/**
 * Quy đổi một bước ra số cp và số tiền. Mua mới: tỷ trọng × vốn, tính theo giá CAO nhất của vùng để không vượt tiền.
 * Bước đã có số cp (theo vị thế thật): số tiền = số cp × giá.
 */
function stepQty(x, cap) {
  const price = x.zone ? (x.side === 'buy' ? x.zone[1] : (x.zone[0] + x.zone[1]) / 2) : x.price;
  if (!price) return null;
  if (x.shares != null) return { shares: x.shares, vnd: x.shares * price * 1000, odd: x.shares < 100 };
  if (x.side === 'buy' && x.portion && cap) {
    const { shares, odd } = sharesFor(cap * x.portion, price);
    return { shares, vnd: shares * price * 1000, odd, budget: cap * x.portion };
  }
  return null;
}

function stepRows(steps, { close }) {
  const cap = capitalM() * 1e6;
  let n = 0;
  return steps.map((x) => {
    const [label, tone] = SIDE[x.side];
    const zone = x.zone ? `${fmt(x.zone[0])}–${fmt(x.zone[1])}` : x.price != null ? fmt(x.price) : '–';
    const ref = x.zone ? (x.zone[0] + x.zone[1]) / 2 : x.price;
    const diff = ref ? ` <span class="muted small">${pct((ref - close) / close)}</span>` : '';
    const q = stepQty(x, cap);
    let qty = '', amount = '';
    if (q) {
      qty = q.shares > 0 ? `<b>${q.shares.toLocaleString('vi-VN')} cp</b>${q.odd ? ' <span class="muted small">(lô lẻ)</span>' : ''}` : '<span class="down small">vốn không đủ 1 cp</span>';
      const sign = x.side === 'buy' ? 'chi' : 'thu về';
      amount = q.shares > 0 ? `${money(q.vnd)} <span class="muted small">${sign}</span>` : '';
      if (x.side === 'buy' && cap && !x.portion) amount += ` <span class="muted small">= ${pct(q.vnd / cap).replace('+', '')} vốn</span>`;
    } else if (x.side === 'buy' && x.portion && !cap) qty = '<span class="muted small">nhập vốn</span>';
    const weight = x.portion ? `<b>${Math.round(x.portion * 1000) / 10}%</b> vốn`
      : x.portionOfHolding ? (x.side === 'buy' ? `+${Math.round(x.portionOfHolding * 100)}% số đang giữ` : `${Math.round(x.portionOfHolding * 100)}% số đang giữ`) : '';
    const num = x.side === 'buy' || x.side === 'sell' ? ++n : '';
    return `<tr class="st-${x.side}"><td class="st-n">${num}</td><td><span class="st-badge ${tone}">${label}</span></td>
      <td class="st-zone">${zone}${diff}</td><td>${weight}</td><td>${amount}</td><td>${qty}</td><td class="st-cond">${esc(x.condition)}</td></tr>`;
  }).join('');
}

/** Khung vốn: nhập số tiền → quy ra tỷ trọng, số tiền, số cp, mức lỗ tối đa và tỷ trọng vị thế đang giữ. */
function capitalBox(a, steps) {
  const capM = capitalM();
  const cap = capM * 1e6;
  const l = a.brief.levels;
  const close = a.price.close;
  const h = a.brief.holding;
  const chips = [100, 200, 500, 1000].map((v) => `<button type="button" class="btn btn-glass btn-xs${v === capM ? ' on' : ''}" data-cap="${v}">${money(v * 1e6)}</button>`).join('');
  const head = `<div class="cap-head">
      <label for="bf-capital"><b>💰 Tổng vốn đầu tư của bạn</b></label>
      <span class="cap-input"><input id="bf-capital" type="number" min="0" step="10" inputmode="decimal" value="${capM || ''}" placeholder="vd 500"> triệu đồng</span>
      <span class="cap-chips">${chips}</span>
      ${cap ? `<span class="muted small">= ${Math.round(cap).toLocaleString('vi-VN')} đ</span>` : ''}
    </div>`;
  if (!cap) {
    return `<div class="bf-capbox">${head}
      <div class="muted small">Nhập tổng số tiền bạn dành cho chứng khoán (ví dụ 500 = 500 triệu). Tool sẽ đổi tỷ trọng % thành <b>số tiền</b> và <b>số cổ phiếu</b>
      cho từng lần mua, cho biết <b>lỗ tối đa bao nhiêu tiền</b> nếu chạm cắt lỗ, và vị thế đang giữ chiếm bao nhiêu % vốn. Chỉ lưu trên trình duyệt này.</div></div>`;
  }
  const rows = [];
  // Tỷ trọng tối đa cho mã này (theo khoảng cách tới cắt lỗ: chạm cắt lỗ chỉ mất ~1% tổng vốn)
  if (l?.weight != null) {
    const maxV = cap * l.weight;
    const { shares } = sharesFor(maxV, close);
    rows.push(['Tỷ trọng tối đa cho ' + a.symbol, `<b>${Math.round(l.weight * 1000) / 10}% vốn</b> = <b>${money(maxV)}</b> ≈ ${shares.toLocaleString('vi-VN')} cp ở giá ${fmt(close)}`]);
  }
  // Kế hoạch mua mới
  const buys = (steps?.fresh || []).filter((x) => x.side === 'buy' && x.portion);
  const isWait = (steps?.fresh || []).some((x) => x.side === 'wait');
  if (buys.length) {
    const qs = buys.map((x) => ({ x, q: stepQty(x, cap) })).filter((r) => r.q);
    const totalV = qs.reduce((s, r) => s + r.q.vnd, 0);
    const totalSh = qs.reduce((s, r) => s + r.q.shares, 0);
    const totalW = buys.reduce((s, x) => s + x.portion, 0);
    const detail = qs.map((r, k) => `lần ${k + 1}: ${r.q.shares.toLocaleString('vi-VN')} cp (${money(r.q.vnd)})`).join(' · ');
    rows.push([isWait ? 'Nếu đủ điều kiện mua' : 'Kế hoạch mua mới', `tổng <b>${Math.round(totalW * 1000) / 10}% vốn</b> ≈ <b>${money(totalV)}</b> = <b>${totalSh.toLocaleString('vi-VN')} cp</b>, chia ${qs.length} lần<div class="muted small">${detail}</div>`]);
    if (l?.stop) {
      const loss = qs.reduce((s, r) => {
        const p = r.x.zone ? r.x.zone[1] : r.x.price;
        return s + r.q.shares * Math.max(0, p - l.stop) * 1000;
      }, 0);
      rows.push(['Rủi ro nếu chạm cắt lỗ ' + fmt(l.stop), `<span class="down">lỗ tối đa ≈ <b>${money(loss)}</b> = ${(loss / cap * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}% tổng vốn</span> (chưa tính phí, thuế)`]);
    }
    rows.push(['Tiền mặt còn lại', `${money(cap - totalV)} cho các mã khác`]);
  } else {
    rows.push(['Mua mới', '<span class="ref">Quyết định hiện tại là chưa mua: không giải ngân vốn cho mã này</span>']);
  }
  // Vị thế đang giữ so với vốn
  if (h?.qty) {
    const val = h.qty * close * 1000;
    const w = val / cap;
    let note = '';
    if (l?.weight != null) {
      const room = cap * l.weight - val;
      note = room > 0
        ? ` · còn được mua thêm tối đa <b>${money(room)}</b> ≈ ${sharesFor(room, close).shares.toLocaleString('vi-VN')} cp (nếu kế hoạch cho phép)`
        : ` · <span class="down">đã vượt tỷ trọng tối đa ${Math.round(l.weight * 100)}%: không mua thêm, cân nhắc hạ bớt</span>`;
    }
    rows.push(['Vị thế đang giữ', `${h.qty.toLocaleString('vi-VN')} cp × ${fmt(close)} = <b>${money(val)}</b> = <b>${(w * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}% vốn</b>${note}`]);
  }
  return `<div class="bf-capbox">${head}<div class="cap-rows">${rows.map(([k, v]) => `<div class="cap-k">${k}</div><div class="cap-v">${v}</div>`).join('')}</div></div>`;
}

function ladder(l) {
  const rows = [
    ['Kháng cự 2 / mục tiêu 2', l.r2, 'up'], ['Kháng cự 1 / mục tiêu 1', l.r1, 'up'], ['Giá hiện tại', l.close, 'now'],
    ['Hỗ trợ 1', l.s1, ''], ['Hỗ trợ 2', l.s2, ''], ['Cắt lỗ', l.stop, 'down'],
  ].filter((r) => r[1] != null);
  return `<div class="ld">${rows.map(([k, v, cls]) => `<div class="ld-row ${cls}"><span>${k}</span><b>${fmt(v)}</b><span class="muted small">${cls === 'now' ? '' : pct((v - l.close) / l.close)}</span></div>`).join('')}
    ${l.weight != null ? `<div class="ld-note">Tỷ trọng tối đa <b>${Math.round(l.weight * 100)}% vốn</b> (chạm cắt lỗ chỉ mất ~1% tổng vốn)${l.riskReward ? ` · lời/lỗ đến ${l.targetLabel || "mục tiêu"}: <b>${fmt(l.riskReward, 1)} lần</b>` : ''}</div>` : ''}</div>`;
}

const CHECK_ICON = { TOT: ['✓', 'up'], TRUNG_TINH: ['•', 'ref'], XAU: ['✕', 'down'] };

function effectiveBrief(a) {
  const b = a.brief;
  // Chỉ dùng quyết định cuối đã qua đủ Gemini và hội đồng đầu tư
  const fin = currentFinal(a);
  const ai = fin ? state.cmResult : null;
  if (!fin) return { verdict: b.verdict, tone: b.tone, action: b.action, steps: b.steps, fin: null, ai };
  return { verdict: fin.label, tone: fin.tone, action: fin.action, steps: fin.steps || b.steps, fin, ai };
}

const ADD_TONE = { MUA_THEM: 'up', MUA_THEM_CO_DIEU_KIEN: 'ref', KHONG_MUA_THEM: 'down' };

/** Phần "đang nắm giữ" do hội đồng lập: có nên mua thêm, vùng không được mua thêm, quan điểm giữ. */
function holderBlock(h) {
  if (!h) return '';
  const noAdd = h.noAdd.length ? `<ul class="bf-noadd">${h.noAdd.map((z) => `<li><b>Không mua thêm khi giá ${z.side === 'DUOI' ? 'dưới' : 'trên'} ${fmt(z.price)}</b>${z.reason ? `: ${esc(z.reason)}` : ''}</li>`).join('')}</ul>` : '';
  return `<div class="bf-holder">
    <div><span class="st-badge ${ADD_TONE[h.addMore]}">${esc(h.addLabel)}</span> ${esc(h.addReason)}</div>
    ${h.blocked ? `<div class="muted small">⚠ ${esc(h.blocked)}</div>` : ''}
    ${h.holdView ? `<div class="bf-holdview">${esc(h.holdView)}</div>` : ''}
    ${noAdd}
  </div>`;
}

function aiReviewBlock(a, eff) {
  const fin = eff.fin;
  let status;
  if (fin) {
    const cls = fin.relation === 'stricter' ? 'down' : fin.relation === 'looser' ? 'ref' : 'up';
    const icon = fin.relation === 'stricter' ? '⚠' : fin.relation === 'looser' ? 'ℹ' : '✓';
    const chain = `Hệ thống <b>${esc(fin.systemLabel)}</b> → Gemini <b>${esc(fin.gemini?.label || '')}</b>${fin.committee ? ` → Hội đồng <b>${esc(fin.committee.label)}</b>` : ''} → Quyết định cuối <b>${esc(fin.label)}</b>`;
    status = `<div class="bf-ai ${cls}"><b>${icon} Đã qua Gemini và hội đồng đầu tư:</b> ${esc(fin.note)}
      <div class="small" style="margin-top:4px">${chain}</div>
      <span class="muted small">${esc(eff.ai.model)} · ${new Date(eff.ai.createdAt).toLocaleString('vi-VN')}${eff.ai.price !== a.price.close ? ` · tại giá ${fmt(eff.ai.price)}, giá đã đổi` : ''}</span>
      <button type="button" class="btn btn-glass btn-xs" data-bf="rerun">Phân tích lại</button></div>`;
  } else if (!state.ai.enabled) {
    status = '<div class="bf-ai ref">Chưa bật AI: quyết định chỉ dựa trên tín hiệu định lượng. Thêm API key trong .env để Gemini và hội đồng đầu tư thẩm định.</div>';
  } else if (state.aiRunning === a.symbol) {
    status = `<div class="bf-ai ref"><span class="mini-spin"></span> ${esc(state.cmStage || 'Đang phân tích')}… Quy trình: Gemini (6 yếu tố thị trường) → phe mua/phe bán → giám đốc đầu tư. Bảng dưới đang là kế hoạch định lượng tạm thời, <b>chưa nên hành động</b> trước khi có quyết định cuối.</div>`;
  } else if (state.aiError?.symbol === a.symbol) {
    status = `<div class="bf-ai down">⚠ Chưa có quyết định cuối: AI lỗi (${esc(state.aiError.message)}). Kế hoạch dưới chỉ dựa trên định lượng, chưa nên hành động. <button type="button" class="btn btn-glass btn-xs" data-bf="rerun">Thử lại</button></div>`;
  } else {
    status = '<div class="bf-ai ref">Chưa có quyết định cuối cho phiên này (cần Gemini và hội đồng đầu tư thẩm định). <button type="button" class="btn btn-glass btn-xs" data-bf="rerun">Phân tích ngay</button></div>';
  }
  const checks = fin?.marketChecks?.length ? `<div class="bf-checks">${fin.marketChecks.map((c) => {
    const [ic, tone] = CHECK_ICON[c.status];
    return `<div class="bf-check" data-tone="${tone}"><span class="bf-ic" aria-hidden="true">${ic}</span><b>${esc(c.label)}</b><span>${esc(c.note)}</span></div>`;
  }).join('')}</div>` : '';
  return status + checks;
}

function renderBrief(a) {
  const el = $('brief-card');
  const b = a.brief;
  el.hidden = !b;
  if (!b) return;
  const eff = effectiveBrief(a);
  const l = b.levels, st = eff.steps;
  const table = (steps) => `<table class="tbl st-table"><thead><tr><th>#</th><th></th><th>Vùng giá</th><th>Tỷ trọng</th><th>Số tiền</th><th>Số cp</th><th>Điều kiện</th></tr></thead>
    <tbody>${stepRows(steps, { close: a.price.close })}</tbody></table>`;
  el.className = `card brief-card tone-${eff.tone}`;
  el.innerHTML = `
    <div class="bf-top">
      <div class="bf-verdict ${eff.tone}">${BRIEF_ICON[eff.tone]} ${esc(eff.verdict)}</div>
      <div class="bf-main">
        <div class="bf-action">${esc(eff.action)}</div>
        <div class="muted small">${esc(b.headline)} · giá ${fmt(a.price.close)} (${signed(a.price.changePct)}%) · phiên ${a.price.date}</div>
      </div>
      <button type="button" class="btn btn-glass btn-xs" id="bf-copy" title="Sao chép kế hoạch để gửi nhanh">📋 Sao chép</button>
    </div>
    ${aiReviewBlock(a, eff)}
    ${st ? capitalBox(a, st) : ''}
    ${st ? `<div class="bf-plays">
      <div class="bf-play${b.holding ? '' : ' mine'}">
        <h4>🆕 Nếu chưa có cổ phiếu${b.holding ? '' : ' <span class="bf-you">trường hợp của bạn</span>'}</h4>
        <div class="tbl-wrap">${table(st.fresh)}</div>
      </div>
      <div class="bf-play${b.holding ? ' mine' : ''}">
        <h4>💼 Nếu đang nắm giữ${b.holding ? ' <span class="bf-you">trường hợp của bạn</span>' : ''}</h4>
        ${b.plays?.position ? `<div class="bf-pos">${esc(b.plays.position)}</div>` : '<div class="muted small" style="margin-bottom:6px">Ghi lệnh trong 💼 Danh mục để tool tính đúng số cổ phiếu cần mua thêm / bán theo vị thế của bạn.</div>'}
        ${eff.fin?.holder ? holderBlock(eff.fin.holder) : ''}
        <div class="tbl-wrap">${table(st.hold)}</div>
      </div>
    </div>` : ''}
    <div class="bf-body">
      <ul class="bf-reasons">${b.reasons.map((r) => `<li data-tone="${r.tone}"><span class="bf-ic" aria-hidden="true">${BRIEF_ICON[r.tone]}</span>${esc(r.text)}</li>`).join('')}</ul>
      ${l ? ladder(l) : ''}
    </div>
    ${b.risks.length ? `<div class="bf-risks">⚠ ${b.risks.map(esc).join(' · ')}</div>` : ''}`;
}


function setCapital(v) {
  try { localStorage.setItem('vnstock_capital', String(Math.max(0, Number(v) || 0))); } catch { /* bỏ qua */ }
  if (state.current) renderBrief(state.current);
}
$('brief-card')?.addEventListener('change', (e) => {
  if (e.target.id === 'bf-capital') setCapital(e.target.value);
});
$('brief-card')?.addEventListener('keydown', (e) => {
  if (e.target.id === 'bf-capital' && e.key === 'Enter') setCapital(e.target.value);
});

$('brief-card')?.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-cap]');
  if (chip) { setCapital(chip.dataset.cap); return; }
  if (e.target.closest('[data-bf="rerun"]') && state.current) { runAiFor(state.current); return; }
  if (e.target.id !== 'bf-copy' || !state.current?.brief) return;
  try {
    await navigator.clipboard.writeText(briefText(state.current));
    showToast('Đã sao chép tóm tắt', 'success');
  } catch {
    showToast('Trình duyệt không cho phép sao chép', 'error');
  }
});

// ---------- Dòng tiền theo nhóm ngành ----------
const SC = { period: 1, sort: 'net', data: null, open: new Set() };
const tỷ = (v) => (v == null ? '–' : `${signed(v / 1e9, Math.abs(v) >= 1e11 ? 0 : 1)} tỷ`);

function showSectors() {
  ['empty', 'error', 'report', 'loading', 'picks', 'portfolio', 'rankview'].forEach((id) => ($(id).hidden = true));
  ['picks-btn', 'pf-btn', 'rank-btn'].forEach((id) => $(id)?.classList.remove('on'));
  $('sectorview').hidden = false;
  $('sector-btn')?.classList.add('on');
  history.replaceState(null, '', '#nganh');
  loadSectors();
}

async function loadSectors() {
  $('sc-list').innerHTML = '<p class="muted">Đang tổng hợp dòng tiền theo ngành…</p>';
  try {
    SC.data = await api(`/api/sectors?period=${SC.period}`);
    SC.period = SC.data.period; // máy chủ có thể giới hạn lại số phiên
    renderSectors();
  } catch (err) {
    $('sc-list').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

const scValue = (s) => (SC.sort === 'foreign' ? (s.foreignNet ?? 0) : s.net);
const periodLabel = () => (SC.period === 1 ? 'phiên gần nhất' : `${SC.period} phiên`);

function renderSectors() {
  const d = SC.data;
  if (!d) return;
  const sectors = [...d.sectors].sort((a, b) => scValue(b) - scValue(a));
  const max = Math.max(...sectors.map((s) => Math.abs(scValue(s))), 1);
  const label = SC.sort === 'foreign' ? 'Khối ngoại ròng' : 'Dòng tiền ròng';
  $('sc-sub').textContent = `${periodLabel()} đến ${d.date} · ${d.universe} mã · ${d.sectors.length} ngành · tổng GTGD ${tỷ(d.market.value).replace('+', '')} · dòng tiền ròng ${tỷ(d.market.net)} · khối ngoại ${tỷ(d.market.foreignNet)}`;

  // Cổ phiếu dẫn dắt theo chiều đang xem (mua/bán), ưu tiên theo cột đang xếp
  const leaders = (s, dir) => {
    const key = SC.sort === 'foreign' ? 'foreignNet' : 'net';
    return [...s.stocks].filter((x) => (x[key] ?? 0) * dir > 0).sort((a, b) => dir * ((b[key] ?? 0) - (a[key] ?? 0))).slice(0, 3);
  };
  const side = (list, dir) => list.map((s) => `
    <div class="sc-item" data-sector="${esc(s.name)}">
      <div class="sc-item-head"><b>${esc(s.name)}</b><span class="${dirClass(scValue(s))}">${tỷ(scValue(s))}</span></div>
      <div class="muted small">Giá ${pct(s.ret)} · GTGD ${tỷ(s.value).replace('+', '')} (${s.valueRatio != null ? `${fmt(s.valueRatio, 2)}× TB` : '–'}) · ${s.up}↑ ${s.down}↓</div>
      <div class="sc-chips">${leaders(s, dir).map((x) => `<button type="button" class="sc-chip" data-sym="${x.symbol}" title="${label}: ${tỷ(SC.sort === 'foreign' ? x.foreignNet : x.net)} · giá ${pct(x.ret)}">${x.symbol} <span class="${dirClass(x.ret)}">${pct(x.ret)}</span></button>`).join('') || '<span class="muted small">–</span>'}</div>
    </div>`).join('');
  $('sc-top-in').innerHTML = side(sectors.filter((s) => scValue(s) > 0).slice(0, 5), 1) || '<p class="muted">Không có ngành nào có dòng tiền vào ròng.</p>';
  $('sc-top-out').innerHTML = side([...sectors].reverse().filter((s) => scValue(s) < 0).slice(0, 5), -1) || '<p class="muted">Không có ngành nào bị bán ròng.</p>';

  $('sc-list').innerHTML = `
    <div class="sc-row sc-head"><span class="sc-name">Ngành</span><span class="sc-axis-label"><span>◀ Bán ròng</span><span>Mua ròng ▶</span></span><span>${label}</span><span>Giá</span><span>GTGD so TB</span><span>${SC.sort === 'foreign' ? 'Dòng tiền' : 'Khối ngoại'}</span></div>
    ${sectors.map((s) => {
      const v = scValue(s), w = (Math.abs(v) / max) * 50;
      const other = SC.sort === 'foreign' ? s.net : s.foreignNet;
      const open = SC.open.has(s.name);
      return `
      <div class="sc-row${open ? ' open' : ''}" data-sector="${esc(s.name)}" role="button" tabindex="0" aria-expanded="${open}"
        title="${esc(s.name)} · ${label}: ${tỷ(v)} · GTGD ${tỷ(s.value).replace('+', '')} (${fmt(s.share * 100, 1)}% thị trường) · ${s.count} mã: ${s.up} tăng, ${s.down} giảm">
        <span class="sc-name">${open ? '▾' : '▸'} ${esc(s.name)} <span class="muted small">${s.count}</span></span>
        <span class="sc-bar" aria-hidden="true"><i class="${v >= 0 ? 'pos' : 'neg'}" style="${v >= 0 ? 'left:50%' : 'right:50%'};width:${w}%"></i></span>
        <span class="${dirClass(v)}"><b>${tỷ(v)}</b></span>
        <span class="${dirClass(s.ret)}">${pct(s.ret)}</span>
        <span class="${s.valueRatio > 1.2 ? 'up' : s.valueRatio < 0.8 ? 'down' : ''}">${s.valueRatio != null ? `${fmt(s.valueRatio, 2)}×` : '–'}</span>
        <span class="${dirClass(other)}">${tỷ(other)}</span>
      </div>
      ${open ? sectorStocks(s) : ''}`;
    }).join('')}`;
}

function sectorStocks(s) {
  return `<div class="sc-detail"><div class="tbl-wrap"><table class="tbl"><thead><tr>
    <th>Mã</th><th>Giá</th><th>${SC.period === 1 ? 'Hôm nay' : `${SC.period} phiên`}</th><th>GTGD</th><th>So TB</th><th>Dòng tiền ròng</th><th>Khối ngoại ròng</th><th>Xếp hạng</th></tr></thead><tbody>
    ${s.stocks.map((x) => `<tr>
      <td><a href="#${x.symbol}" class="pf-sym" data-sym="${x.symbol}">${x.symbol}</a></td><td>${fmt(x.close)}</td>
      <td class="${dirClass(x.ret)}">${pct(x.ret)}</td><td>${tỷ(x.value).replace('+', '')}</td>
      <td class="${x.valueRatio > 1.2 ? 'up' : x.valueRatio < 0.8 ? 'down' : ''}">${x.valueRatio != null ? `${fmt(x.valueRatio, 2)}×` : '–'}</td>
      <td class="${dirClass(x.net)}">${tỷ(x.net)}</td><td class="${dirClass(x.foreignNet)}">${tỷ(x.foreignNet)}</td>
      <td class="${RANK_TONE[x.rankCode] || ''}">${x.rank ?? '–'}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

function setSectorPeriod(n) {
  SC.period = Math.min(60, Math.max(1, Math.round(n) || 1));
  // Sáng nút có sẵn nếu trùng, ô nhập luôn hiện số phiên đang xem
  document.querySelectorAll('#sc-period button').forEach((x) => x.classList.toggle('on', Number(x.dataset.p) === SC.period));
  $('sc-custom').n.value = SC.period;
  loadSectors();
}
$('sc-period')?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setSectorPeriod(Number(b.dataset.p));
});
$('sc-custom')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const n = Number(e.target.n.value);
  if (!(n >= 1 && n <= 60)) return showToast('Số phiên phải từ 1 đến 60', 'error');
  setSectorPeriod(n);
});
$('sc-sort')?.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  SC.sort = b.dataset.s;
  document.querySelectorAll('#sc-sort button').forEach((x) => x.classList.toggle('on', x === b));
  renderSectors();
});
$('sectorview')?.addEventListener('click', (e) => {
  const sym = e.target.closest('[data-sym]');
  if (sym) { e.preventDefault(); analyze(sym.dataset.sym); return; }
  const row = e.target.closest('[data-sector]');
  if (!row) return;
  const name = row.dataset.sector;
  if (SC.open.has(name)) SC.open.delete(name); else SC.open.add(name);
  renderSectors();
  if (row.classList.contains('sc-item')) document.querySelector(`.sc-row[data-sector="${CSS.escape(name)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('sectorview')?.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('sc-row')) { e.preventDefault(); e.target.click(); }
});
$('sector-btn')?.addEventListener('click', showSectors);

// ---------- Khởi động ứng dụng ----------
initTheme();
loadMarket();
loadWatchlist();
loadAlerts();
loadMovers();

api('/api/ai/status').catch(() => ({ enabled: false })).then((s) => {
  state.ai = s;
  const initial = decodeURIComponent(location.hash.slice(1));
  // Mở app chưa chọn mã: hiện danh sách cổ phiếu tiềm năng
  if (initial === 'danh-muc') {
    showPortfolio();
  } else if (initial === 'xep-hang') {
    showRankView();
  } else if (initial === 'nganh') {
    showSectors();
  } else if (/^[A-Za-z0-9]{3,10}$/.test(initial)) {
    analyze(initial.toUpperCase());
  } else {
    showPicks();
  }
});

// Làm mới định kỳ mỗi 2 phút
setInterval(() => {
  loadWatchlist();
  loadAlerts();
  loadMarket();
  loadMovers();
}, 120_000);
