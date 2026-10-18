// Điểm xếp hạng 4 yếu tố: so sánh một mã với rổ cổ phiếu đạt tiêu chí sàn + thanh khoản
// (mặc định: sàn HOSE, giá trị khớp lệnh TB 20 phiên ≥ 5 tỷ đồng — xem screenCriteria() trong data.js) theo
//  - động lượng 12 tháng bỏ tháng gần nhất, - khoảng cách tới đỉnh 52 tuần,
//  - biến động thấp (ATR%), - độ mạnh xu hướng (ADX).
// Đây là các yếu tố giữ được khả năng dự báo ở cả giai đoạn học và giai đoạn kiểm tra ngoài mẫu
// khi đánh giá trên dữ liệu 2023–2026 (điểm kỹ thuật cũ thì không). Điểm 0–100 = phân vị trung bình trong rổ.
import { getPriceHistory, getScreenUniverse, screenCriteria, avgTradedValue } from './data.js';
import { cached } from './http.js';
import { atr, adx, sma } from './indicators.js';
import { recordMany } from './predictions.js';
import { BANDS, DEFAULTS, LOT, priceLimits, tickSize, roundUp, roundDown, calcMetrics, maxDrawdown } from './backtest.js';
import { getQuarterly } from './company.js';


export const REGIMES = ['none', 'half', 'cash'];

/**
 * Danh mục mẫu: top 8 mã trên MA200, đổi mỗi 20 phiên. Nghiên cứu 10/2026 đã thử vùng đệm giữ mã đang thắng
 * (1,5–3×N) và tái cơ cấu 30–60 phiên: trên engine đầy đủ (trần/sàn, lô 100, T+2) kết quả dao động ±20–40%
 * giữa các cấu hình kề nhau, không cấu hình nào tốt hơn ổn định ở cả 1, 2 và 3 năm, nên giữ mặc định.
 */
export const PORTFOLIO_RULE = { top: 8, buffer: 1, rebalance: 20 };
export const DEFAULT_REGIME = 'none';

/** Số mã được nắm giữ theo trạng thái thị trường. */
export function regimeSlots(regime, bear, top) {
  if (!bear || regime === 'none') return top;
  return regime === 'half' ? Math.ceil(top / 2) : 0;
}

export const FACTORS = [
  { key: 'mom', label: 'Động lượng 12 tháng', sign: 1 },
  { key: 'high', label: 'Gần đỉnh 52 tuần', sign: 1 },
  { key: 'atr', label: 'Biến động thấp', sign: -1 },
  { key: 'adx', label: 'Xu hướng rõ (ADX)', sign: 1 },
];

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const MIN = 60_000;

/** Trả hàm đọc giá trị các yếu tố tại phiên i (chỉ dùng dữ liệu đến phiên i). */
export function factorReader(bars) {
  const c = bars.map((b) => b.close);
  const a = atr(bars, 14), d = adx(bars, 14), m200 = sma(c, 200);
  return (i) => {
    if (i < 130 || i >= bars.length) return null;
    const from = Math.max(0, i - 250);
    let hi = -Infinity;
    for (let k = from; k <= i; k++) hi = Math.max(hi, c[k]);
    return {
      mom: i >= 250 ? c[i - 20] / c[i - 250] - 1 : null,
      high: c[i] / hi - 1,
      atr: a[i] != null ? a[i] / c[i] : null,
      adx: d.adx[i],
      aboveMa200: m200[i] != null ? c[i] > m200[i] : null,
      close: c[i],
    };
  };
}

// Phân vị của value trong mảng đã sắp xếp (giá trị bằng nhau tính một nửa)
function percentile(sorted, value) {
  if (!sorted.length) return null;
  let lo = 0, eq = 0;
  for (const v of sorted) { if (v < value) lo++; else if (v === value) eq++; }
  return (lo + eq / 2) / sorted.length;
}

// Yếu tố thứ 5 (tùy chọn): tăng trưởng lợi nhuận sau thuế quý gần nhất ĐÃ CÔNG BỐ so với cùng kỳ
export const EARN_FACTOR = { key: 'eg', label: 'Tăng trưởng LN quý', sign: 1 };
export const EARN_LAG_DAYS = 45; // hạn công bố BCTC hợp nhất: quý chỉ được dùng sau ngày kết thúc quý + 45 ngày

/**
 * Hàm đọc tăng trưởng LN quý tại một ngày: quý mới nhất có ngày kết thúc + 45 ngày ≤ ngày đó (không nhìn trước tương lai).
 * @param {{ date: string, profit: number|null }[]} quarters tăng dần
 */
export function earningsReader(quarters) {
  const qs = (quarters || []).map((r) => ({ ...r, avail: new Date(Date.parse(r.date) + EARN_LAG_DAYS * 86400_000).toISOString().slice(0, 10) }));
  return (date) => {
    let last = null;
    for (const r of qs) if (r.avail <= date) last = r;
    if (!last || last.profit == null) return null;
    const ly = qs.find((x) => x.date.slice(5) === last.date.slice(5) && +x.date.slice(0, 4) === +last.date.slice(0, 4) - 1);
    return ly?.profit > 0 ? last.profit / ly.profit - 1 : null;
  };
}

/** Phân phối từng yếu tố của rổ (mảng đã sắp xếp) để tính phân vị. */
export function buildRef(factorsList, factors = FACTORS) {
  const ref = {};
  for (const { key } of factors) {
    ref[key] = factorsList.map((f) => f?.[key]).filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  }
  return ref;
}

/** Điểm 0–100 và phân vị từng yếu tố của một mã so với rổ. */
export function compositeScore(f, ref, factors = FACTORS) {
  if (!f) return null;
  const parts = {};
  const used = [];
  for (const { key, sign } of factors) {
    const v = f[key];
    if (v == null || !Number.isFinite(v) || !ref[key]?.length) continue;
    const p = percentile(ref[key], v);
    parts[key] = sign > 0 ? p : 1 - p;
    used.push(parts[key]);
  }
  if (used.length < 2) return null;
  return { score: Math.round((used.reduce((s, v) => s + v, 0) / used.length) * 100), parts };
}

/** Nhãn và hướng dự báo (+1 mua / 0 trung tính / -1 tránh) từ điểm xếp hạng. */
export function rankLabel(score, aboveMa200) {
  if (score == null) return { code: 'NA', label: 'Chưa đủ dữ liệu', direction: 0 };
  if (score >= 70 && aboveMa200 !== false) return { code: 'STRONG', label: 'MẠNH — nhóm dẫn đầu', direction: 1 };
  if (score >= 70) return { code: 'WAIT', label: 'KHÁ — nhưng dưới MA200, chờ xác nhận', direction: 0 };
  if (score >= 50) return { code: 'GOOD', label: 'KHÁ', direction: 0 };
  if (score >= 30) return { code: 'AVERAGE', label: 'TRUNG BÌNH', direction: 0 };
  return { code: 'WEAK', label: 'YẾU — nhóm đội sổ', direction: -1 };
}

async function poolMap(items, fn, n = 6) {
  const out = new Array(items.length);
  let k = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (k < items.length) {
      const i = k++;
      out[i] = await fn(items[i]).catch(() => null);
    }
  }));
  return out;
}

/** Bảng xếp hạng hiện tại của rổ (cache 30 phút). */
export function getRankBoard() {
  return cached('rank-board', 30 * MIN, async () => {
    const uni = await getScreenUniverse();
    const { minValue } = screenCriteria();
    const res = await poolMap(uni.map((u) => u.symbol), (s) => getPriceHistory(s));
    const rows = [];
    res.forEach((r, k) => {
      if (!r?.bars?.length) return;
      const bars = r.bars;
      const value20 = avgTradedValue(bars);
      if (value20 < minValue) return; // chưa đạt thanh khoản trung bình 20 phiên
      const f = factorReader(bars)(bars.length - 1);
      if (f) rows.push({ symbol: uni[k].symbol, exchange: uni[k].exchange, f, value20, date: bars.at(-1).time, changePct: round((bars.at(-1).close / bars.at(-2).close - 1) * 100) });
    });
    const ref = buildRef(rows.map((r) => r.f));
    const board = rows.map((r) => {
      const cs = compositeScore(r.f, ref);
      return {
        symbol: r.symbol, exchange: r.exchange, close: r.f.close, changePct: r.changePct, date: r.date, value20: Math.round(r.value20),
        score: cs?.score ?? null, parts: cs?.parts ?? null, aboveMa200: r.f.aboveMa200,
        factors: { mom: round(r.f.mom, 4), high: round(r.f.high, 4), atr: round(r.f.atr, 4), adx: round(r.f.adx, 1) },
        ...rankLabel(cs?.score, r.f.aboveMa200),
      };
    }).filter((r) => r.score != null).sort((a, b) => b.score - a.score);
    let k = 0;
    for (const r of board) r.pfRank = r.aboveMa200 !== false ? ++k : null;
    // Ghi top 8 (đã lọc trên MA200) như một danh mục dự đoán để chấm sau 5/10/20 phiên
    recordMany(board.filter((r) => r.aboveMa200 !== false).slice(0, 8).map((r) => ({
      source: 'rank_top', symbol: r.symbol, date: r.date, direction: 1, label: `Top xếp hạng (${r.score})`, price: r.close,
    })));
    return { date: rows.reduce((m, r) => (r.date > m ? r.date : m), ''), universe: board.length, criteria: screenCriteria(), ref, rows: board, updatedAt: new Date().toISOString() };
  });
}

/** Điểm xếp hạng của một mã bất kỳ (kể cả ngoài rổ) so với rổ. */
export async function rankSymbol(symbol, bars) {
  const board = await getRankBoard();
  const f = factorReader(bars)(bars.length - 1);
  const cs = compositeScore(f, board.ref);
  if (!cs) return null;
  const better = board.rows.filter((r) => r.symbol !== symbol && r.score > cs.score).length;
  // Hạng trong nhóm trên MA200 (nhóm danh mục chọn mua / giữ)
  const pfRank = f.aboveMa200 === false ? null
    : board.rows.filter((r) => r.symbol !== symbol && r.aboveMa200 !== false && r.score > cs.score).length + 1;
  return {
    score: cs.score,
    parts: Object.fromEntries(Object.entries(cs.parts).map(([k, v]) => [k, Math.round(v * 100)])),
    factors: { mom: round(f.mom, 4), high: round(f.high, 4), atr: round(f.atr, 4), adx: round(f.adx, 1) },
    aboveMa200: f.aboveMa200,
    position: better + 1,
    pfRank,
    universe: board.rows.length + (board.rows.some((r) => r.symbol === symbol) ? 0 : 1),
    ...rankLabel(cs.score, f.aboveMa200),
  };
}

// ---------- Backtest danh mục: mỗi kỳ nắm giữ N mã điểm cao nhất, chia đều vốn ----------

/**
 * @param {{ years?: number, top?: number, rebalance?: number, buffer?: number, trendFilter?: boolean, initialCash?: number, regime?: string }} opts
 *   buffer: giữ mã đang nắm khi còn trong top (buffer × N) mã trên MA200; 1 = luôn đổi về đúng top N.
 *   earnings: true = thêm yếu tố tăng trưởng LN quý (dữ liệu tại thời điểm) và bỏ mã có LN quý gần nhất giảm so cùng kỳ.
 *   regime: lọc theo xu hướng VN-Index ở ngày tái cơ cấu — 'none' (luôn đầy vốn), 'half' (VN-Index dưới MA200
 *   thì chỉ giữ nửa số mã, phần còn lại để tiền mặt), 'cash' (VN-Index dưới MA200 thì bán hết, cầm tiền).
 */
export async function runRankPortfolio(opts = {}) {
  const years = Math.min(4, Math.max(1, Number(opts.years) || 3));
  const top = Math.min(15, Math.max(3, Number(opts.top) || 8));
  const rebalance = Math.min(60, Math.max(5, Number(opts.rebalance) || PORTFOLIO_RULE.rebalance));
  const buffer = Math.min(4, Math.max(1, Number(opts.buffer) || PORTFOLIO_RULE.buffer));
  const trendFilter = opts.trendFilter !== false && opts.trendFilter !== '0' && opts.trendFilter !== 'false';
  const regime = REGIMES.includes(opts.regime) ? opts.regime : DEFAULT_REGIME;
  const earnings = opts.earnings === true || opts.earnings === '1' || opts.earnings === 'true';
  const factors = earnings ? [...FACTORS, EARN_FACTOR] : FACTORS;
  const initialCash = Number(opts.initialCash) > 0 ? Number(opts.initialCash) : DEFAULTS.initialCash;
  const { brokerage, sellTax, slippage } = DEFAULTS;
  const days = Math.round((years + 1.3) * 365);

  const c = screenCriteria();
  const key = `rank-pf:${years}:${top}:${rebalance}:${buffer}:${earnings}:${trendFilter}:${regime}:${initialCash}:${c.floors}:${c.minValue}`;
  return cached(key, 30 * MIN, async () => {
    const indexRes = await getPriceHistory('VNINDEX', days);
    const uni = await getScreenUniverse();
    const { minValue } = screenCriteria();
    const all = await poolMap(uni.map((u) => u.symbol), (s) => getPriceHistory(s, days));
    const quarterly = earnings ? await poolMap(uni.map((u) => u.symbol), (s) => getQuarterly(s)) : [];
    const cal = indexRes.bars;
    const start = Math.max(1, cal.length - Math.round(years * 252));
    const idxMa = sma(cal.map((b) => b.close), 200);
    const idxBear = (t) => idxMa[t] != null && cal[t].close < idxMa[t];
    const regimeLog = [];
    const data = {};
    uni.forEach(({ symbol: s, exchange }, k) => {
      const bars = all[k]?.bars;
      if (!bars?.length) return;
      data[s] = { bars, at: new Map(bars.map((b, i) => [b.time, i])), read: factorReader(bars), ex: BANDS[exchange] ? exchange : 'HOSE', earn: earnings ? earningsReader(quarterly[k]) : null };
    });
    const syms = Object.keys(data);

    let cash = initialCash;
    const pos = new Map(); // sym -> { shares, price, cost, time, t }
    const lastClose = {};
    let pendingSell = new Set(), pendingBuy = [];
    const trades = [];
    const equity = [];
    const periods = [];
    const blocked = { ceiling: 0, floor: 0 };
    let fees = 0;
    let current = null;

    for (let t = start; t < cal.length; t++) {
      const date = cal[t].time;
      // 1. Khớp lệnh ở giá mở cửa: bán trước, mua sau
      for (const s of [...pendingSell]) {
        const d = data[s], i = d.at.get(date), p = pos.get(s);
        if (i == null || i < 1 || !p) { if (!p) pendingSell.delete(s); continue; }
        const { floor } = priceLimits(d.bars[i - 1].close, BANDS[d.ex], d.ex);
        if (t - p.t < DEFAULTS.settlementBars) continue;
        if (d.bars[i].open <= floor + tickSize(floor, d.ex) - 1e-9) { blocked.floor++; continue; }
        const price = Math.max(roundDown(d.bars[i].open * (1 - slippage), d.ex), floor);
        const gross = p.shares * price * 1000, fee = gross * (brokerage + sellTax);
        cash += gross - fee;
        fees += fee;
        trades.push({ symbol: s, entryTime: p.time, exitTime: date, entryPrice: p.price, exitPrice: price, pnl: Math.round(gross - fee - p.cost), returnPct: round(((gross - fee) / p.cost - 1) * 100), bars: t - p.t });
        pos.delete(s);
        pendingSell.delete(s);
      }
      if (pendingBuy.length) {
        const value = cash + [...pos].reduce((sum, [s, p]) => sum + p.shares * (lastClose[s] ?? p.price) * 1000, 0);
        const slot = value / top; // mỗi mã tối đa 1/top vốn; khi thị trường yếu phần không mua để tiền mặt
        const still = [];
        for (const s of pendingBuy) {
          const d = data[s], i = d.at.get(date);
          if (i == null || i < 1 || pos.has(s)) continue;
          const { ceiling } = priceLimits(d.bars[i - 1].close, BANDS[d.ex], d.ex);
          if (d.bars[i].open >= ceiling - tickSize(ceiling, d.ex) + 1e-9) { blocked.ceiling++; still.push(s); continue; }
          const price = Math.min(roundUp(d.bars[i].open * (1 + slippage), d.ex), ceiling);
          const budget = Math.min(slot, cash);
          const shares = Math.floor(budget / (price * 1000 * (1 + brokerage)) / LOT) * LOT;
          if (shares <= 0) continue;
          const gross = shares * price * 1000, fee = gross * brokerage;
          cash -= gross + fee;
          fees += fee;
          pos.set(s, { shares, price, cost: gross + fee, time: date, t });
        }
        pendingBuy = still;
      }

      // 2. Định giá cuối phiên
      for (const s of syms) {
        const i = data[s].at.get(date);
        if (i != null) lastClose[s] = data[s].bars[i].close;
      }
      const value = cash + [...pos].reduce((sum, [s, p]) => sum + p.shares * (lastClose[s] ?? p.price) * 1000, 0);
      equity.push({ time: date, value, index: cal[t].close });

      // 3. Chọn lại danh mục ở giá đóng cửa ngày tái cơ cấu (khớp phiên sau)
      if ((t - start) % rebalance === 0 && t < cal.length - 1) {
        const snap = [];
        for (const s of syms) {
          const i = data[s].at.get(date);
          if (i == null) continue;
          // Chỉ chọn mã đạt ngưỡng thanh khoản TẠI THỜI ĐIỂM đó (giảm thiên lệch nhìn từ hiện tại)
          if (avgTradedValue(data[s].bars, 20, i) < minValue) continue;
          const f = data[s].read(i);
          if (!f) continue;
          if (earnings) {
            const eg = data[s].earn(date);
            if (eg != null && eg < 0) continue; // LN quý gần nhất đã công bố giảm so cùng kỳ: bỏ
            f.eg = eg;
          }
          snap.push({ s, f });
        }
        const ref = buildRef(snap.map((x) => x.f), factors);
        const scored = snap.map((x) => ({ ...x, score: compositeScore(x.f, ref, factors)?.score })).filter((x) => x.score != null)
          .filter((x) => !trendFilter || x.f.aboveMa200 !== false)
          .sort((a, b) => b.score - a.score);
        const slots = regimeSlots(regime, idxBear(t), top);
        // Giữ mã đang nắm nếu còn trong top (buffer × N); phần còn lại lấp bằng mã điểm cao nhất
        const rankOf = new Map(scored.map((x, k) => [x.s, k]));
        const target = new Set([...pos.keys()].filter((s) => rankOf.has(s) && rankOf.get(s) < top * buffer).slice(0, slots));
        for (const x of scored) { if (target.size >= slots) break; target.add(x.s); }
        const picked = scored.filter((x) => target.has(x.s));
        pendingSell = new Set([...pos.keys()].filter((s) => !target.has(s)));
        pendingBuy = [...target].filter((s) => !pos.has(s));
        if (current) periods.push(closePeriod(current, data, date, cal[t].close));
        regimeLog.push({ date, bear: idxBear(t) });
        current = { from: date, bear: idxBear(t), picks: picked.map((x) => ({ symbol: x.s, score: x.score, close: x.f.close })), index: cal[t].close };
      }
    }
    if (current) periods.push(closePeriod(current, data, cal.at(-1).time, cal.at(-1).close, true));

    const values = equity.map((e) => e.value);
    const bench = equity.map((e) => e.index);
    const metrics = calcMetrics(values, trades, initialCash, bench);
    // Rổ chia đều, mua và nắm giữ (không phí) để so sánh
    const base = syms.filter((s) => data[s].at.has(equity[0].time));
    const ew = equity.map((e) => {
      const r = base.map((s) => {
        const d = data[s];
        const i0 = d.at.get(equity[0].time);
        let i = d.at.get(e.time);
        if (i == null) i = i0;
        return d.bars[i].close / d.bars[i0].close;
      });
      return r.reduce((a, b) => a + b, 0) / r.length;
    });
    const step = Math.max(1, Math.ceil(equity.length / 400));
    const curve = [];
    equity.forEach((e, k) => {
      if (k % step && k !== equity.length - 1) return;
      curve.push({ time: e.time, equity: Math.round(e.value), index: Math.round((e.index / equity[0].index) * initialCash), equalWeight: Math.round(ew[k] * initialCash) });
    });
    const done = periods.filter((p) => !p.open);
    const picksN = done.reduce((s, p) => s + p.picks.length, 0);
    const picksBeat = done.reduce((s, p) => s + p.picks.filter((x) => x.excess > 0).length, 0);
    const out = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'number' ? (Number.isFinite(v) ? round(v, 4) : null) : v]));
    return {
      regime: { mode: regime, bearPeriods: regimeLog.filter((x) => x.bear).length, periods: regimeLog.length, now: idxBear(cal.length - 1) ? 'bear' : 'bull' },
      config: { years, top, rebalance, buffer, earnings, trendFilter, regime, initialCash, brokerage, sellTax, slippage, universe: syms.length, criteria: c },
      period: { from: equity[0].time, to: equity.at(-1).time, bars: equity.length },
      metrics: out(metrics),
      equalWeight: { totalReturn: round(ew.at(-1) - 1, 4), maxDrawdown: round(maxDrawdown(ew, 1), 4) },
      accuracy: {
        periods: done.length,
        periodsBeatIndex: done.filter((p) => p.excess > 0).length,
        picks: picksN,
        picksBeatIndex: picksBeat,
        avgExcess: done.length ? round(done.reduce((s, p) => s + p.excess, 0) / done.length, 4) : null,
      },
      blocked, fees: Math.round(fees),
      holdings: [...pos].map(([s, p]) => ({ symbol: s, since: p.time, price: p.price, returnPct: round(((lastClose[s] * p.shares * 1000) / p.cost - 1) * 100) })),
      periods: periods.slice(-24).reverse(),
      trades: trades.slice(-40).reverse(),
      curve,
    };
  });
}

// Lợi nhuận từng mã đã chọn trong kỳ (giá đóng cửa ngày chọn → cuối kỳ) so với VN-Index
function closePeriod(cur, data, toDate, indexClose, open = false) {
  const idxRet = indexClose / cur.index - 1;
  const picks = cur.picks.map((p) => {
    const d = data[p.symbol];
    let i = d.at.get(toDate);
    if (i == null) i = d.bars.findLastIndex((b) => b.time <= toDate);
    const ret = d.bars[i].close / p.close - 1;
    return { symbol: p.symbol, score: p.score, ret: round(ret, 4), excess: round(ret - idxRet, 4) };
  });
  const avg = picks.length ? picks.reduce((s, p) => s + p.ret, 0) / picks.length : 0;
  return { from: cur.from, to: toDate, open, indexReturn: round(idxRet, 4), ret: round(avg, 4), excess: round(avg - idxRet, 4), picks };
}
