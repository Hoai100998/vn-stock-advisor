// Tự đối chiếu và tự cải thiện: mỗi ngày giao dịch sau 15:30 so các gợi ý trước đây với giá thực tế, rồi chỉnh
// một số thông số trong tuning.js KHI có đủ bằng chứng.
//
// Rào chắn chống "học theo nhiễu":
//  - chỉ dùng lệnh đã đủ phiên (đã chạm cắt lỗ / chốt lời hoặc đủ 20 phiên), cần ≥ MIN_SAMPLE lệnh;
//  - mỗi lần chỉnh một bước nhỏ, kẹp trong giới hạn BOUNDS; mỗi thông số tối đa 1 lần / COOLDOWN phiên;
//  - không tự đổi chiến lược xếp hạng gốc (đã kiểm chứng 4 năm; ~40 biến thể thử nghiệm đều không vững hơn).
// Mọi thay đổi được ghi nhật ký (data/tuning.json) và báo qua Telegram.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory } from './data.js';
import { evaluatePredictions } from './predictions.js';
import { getTuning, setParam, tuningLog } from './tuning.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const TRADES = join(DIR, 'trades.json');
const REVIEWS = join(DIR, 'reviews.json');
export const RULES = { minSample: 30, window: 60, cooldown: 5, hold: 20, minBand: 50 };

const readJson = (f, d) => readFile(f, 'utf8').then(JSON.parse).catch(() => d);
async function writeJson(f, v) {
  await mkdir(DIR, { recursive: true });
  await writeFile(f, JSON.stringify(v), 'utf8');
}
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const share = (a, f) => (a.length ? a.filter(f).length / a.length : null);
const r = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// ---------- Ghi gợi ý đã gửi ----------
/**
 * Lưu các mã đã gợi ý mua (status 'pick') và mã hệ thống muốn mua nhưng AI loại (status 'rejected').
 * Mỗi mã / phiên giữ bản mới nhất (bản tin đóng cửa ghi đè bản mở cửa vì giá đã chốt).
 * @param {{ symbol, date, entry, stop, target, buyFrom, buyTo, code, status }[]} list
 */
export async function recordTrades(list) {
  const store = await readJson(TRADES, { items: [] });
  for (const t of list) {
    if (!t.symbol || !t.date || !t.entry) continue;
    const k = store.items.findIndex((x) => x.symbol === t.symbol && x.date === t.date);
    const item = { ...t, at: new Date().toISOString() };
    if (k >= 0) store.items[k] = item;
    else store.items.push(item);
  }
  if (store.items.length > 5000) store.items.splice(0, store.items.length - 5000);
  await writeJson(TRADES, store);
}

// ---------- Chấm ----------
/**
 * Mô phỏng một lệnh mua ở giá `entry` phiên `date`: thoát khi giá thấp nhất chạm cắt lỗ (nếu mở cửa đã dưới cắt lỗ
 * thì bán giá mở cửa), khi giá cao nhất chạm chốt lời, hoặc đóng cửa phiên thứ `hold`. Cùng phiên chạm cả hai thì tính
 * cắt lỗ (thận trọng). Kèm lợi suất 10 / 20 phiên giữ nguyên (để biết cắt lỗ có bị "quét" rồi giá hồi không).
 */
export function scoreTrade(t, bars, indexBars = [], hold = RULES.hold) {
  const i = bars.findIndex((b) => b.time === t.date);
  if (i < 0) return null;
  const at = (h) => (i + h < bars.length ? bars[i + h].close / t.entry - 1 : null);
  const j0 = indexBars.findIndex((b) => b.time === t.date);
  const idx = (h) => (j0 >= 0 && j0 + h < indexBars.length ? indexBars[j0 + h].close / indexBars[j0].close - 1 : null);
  let outcome = null, exit = null, days = null;
  for (let j = i + 1; j <= Math.min(i + hold, bars.length - 1); j++) {
    const b = bars[j];
    if (t.stop && b.low <= t.stop) { outcome = 'stop'; exit = Math.min(b.open, t.stop); days = j - i; break; }
    if (t.target && b.high >= t.target) { outcome = 'target'; exit = Math.max(b.open, t.target); days = j - i; break; }
  }
  if (!outcome && i + hold < bars.length) { outcome = 'time'; exit = bars[i + hold].close; days = hold; }
  const ret10 = at(10), ret20 = at(20);
  return {
    matured: outcome != null, outcome, days, ret: exit != null ? exit / t.entry - 1 : null,
    ret10, excess10: ret10 != null && idx(10) != null ? ret10 - idx(10) : null, ret20,
  };
}

/** Thống kê một nhóm lệnh đã chấm. */
export function tradeStats(list) {
  const done = list.filter((x) => x.s?.matured);
  const stops = done.filter((x) => x.s.outcome === 'stop');
  const shaken = stops.filter((x) => x.s.ret20 != null);
  return {
    n: done.length,
    winRate: r(share(done, (x) => x.s.ret > 0), 3),
    avgRet: r(avg(done.map((x) => x.s.ret))),
    stopRate: r(share(done, (x) => x.s.outcome === 'stop'), 3),
    stop5Rate: r(share(done, (x) => x.s.outcome === 'stop' && x.s.days <= 5), 3),
    targetRate: r(share(done, (x) => x.s.outcome === 'target'), 3),
    shakeN: shaken.length,
    shakeAvgRet20: r(avg(shaken.map((x) => x.s.ret20))),
  };
}

function excessStats(list) {
  const done = list.filter((x) => x.s?.excess10 != null);
  return { n: done.length, avgRet10: r(avg(done.map((x) => x.s.ret10))), avgExcess10: r(avg(done.map((x) => x.s.excess10))) };
}

/** Tỷ lệ giá thật nằm trong dải 5–95% của các dự báo AI đã lưu, ở mốc 5 phiên. */
async function bandCoverage(barsOf) {
  const store = await readJson(join(DIR, 'forecasts.json'), {});
  const hits = [];
  for (const [sym, byDate] of Object.entries(store)) {
    const list = Object.values(byDate).filter((f) => f.band?.p5);
    if (!list.length) continue;
    const bars = await barsOf(sym);
    if (!bars) continue;
    for (const f of list) {
      const i = bars.findIndex((b) => b.time === f.date);
      if (i < 0 || i + 5 >= bars.length) continue;
      const v = bars[i + 5].close, [lo, hi] = f.band.p5;
      hits.push(v >= lo && v <= hi);
    }
  }
  return { n: hits.length, coverage90: r(share(hits, Boolean), 3) };
}

// ---------- Quyết định chỉnh ----------
/**
 * Các thay đổi đề xuất từ số liệu (hàm thuần, dễ kiểm thử).
 * @returns {{ name, value, reason, evidence }[]}
 */
export function proposeChanges({ picks, picks10, rejected10, band }, t, rules = RULES) {
  const out = [];
  if (picks.n >= rules.minSample) {
    if (picks.stop5Rate > 0.45 && picks.shakeN >= 10 && picks.shakeAvgRet20 > 0) {
      out.push({ name: 'minStopAtr', value: t.minStopAtr + 0.25, evidence: picks,
        reason: `${Math.round(picks.stop5Rate * 100)}% lệnh chạm cắt lỗ trong 5 phiên nhưng sau 20 phiên giá các mã đó lại ${(picks.shakeAvgRet20 * 100).toFixed(1)}%: cắt lỗ quá sát, nới thêm 0,25 ATR` });
    } else if (picks.stopRate < 0.15 && t.minStopAtr > 0) {
      out.push({ name: 'minStopAtr', value: t.minStopAtr - 0.25, evidence: picks,
        reason: `Chỉ ${Math.round(picks.stopRate * 100)}% lệnh chạm cắt lỗ: thu hẹp lại 0,25 ATR để giảm rủi ro mỗi lệnh` });
    }
  }
  if (band.n >= rules.minBand) {
    if (band.coverage90 < 0.85) out.push({ name: 'widen', value: t.widen * 1.04, evidence: band, reason: `Dải 5–95% chỉ chứa giá thật ${Math.round(band.coverage90 * 100)}% (chuẩn 90%): nới dải 4%` });
    else if (band.coverage90 > 0.95) out.push({ name: 'widen', value: t.widen / 1.04, evidence: band, reason: `Dải 5–95% chứa giá thật ${Math.round(band.coverage90 * 100)}% (chuẩn 90%): dải quá rộng, thu hẹp 4%` });
  }
  if (picks10.n >= rules.minSample && rejected10.n >= rules.minSample) {
    const diff = rejected10.avgExcess10 - picks10.avgExcess10;
    if (t.aiVeto && diff > 0.01) {
      out.push({ name: 'aiVeto', value: false, evidence: { picks10, rejected10 },
        reason: `Mã AI loại lại tốt hơn mã AI chọn ${(diff * 100).toFixed(1)}%/10 phiên: vẫn cho AI phân tích nhưng không loại mã, chỉ ghi chú` });
    } else if (!t.aiVeto && diff < -0.01) {
      out.push({ name: 'aiVeto', value: true, evidence: { picks10, rejected10 },
        reason: `Mã AI chọn tốt hơn mã AI loại ${(-diff * 100).toFixed(1)}%/10 phiên: bật lại quyền loại mã của AI` });
    }
  }
  if (picks10.n >= rules.minSample) {
    if (!t.caution && picks10.avgExcess10 < -0.01) {
      out.push({ name: 'caution', value: true, evidence: picks10, reason: `Gợi ý mua gần đây thua VN-Index ${(-picks10.avgExcess10 * 100).toFixed(1)}%/10 phiên: chỉ gợi ý 3 mã, kèm cảnh báo` });
    } else if (t.caution && picks10.avgExcess10 > 0) {
      out.push({ name: 'caution', value: false, evidence: picks10, reason: `Gợi ý mua đã vượt VN-Index trở lại (+${(picks10.avgExcess10 * 100).toFixed(1)}%/10 phiên): bỏ chế độ thận trọng` });
    }
  }
  return out;
}

/** Số phiên giao dịch kể từ lần chỉnh gần nhất của thông số. */
function sessionsSince(name, sessions) {
  const last = tuningLog().filter((x) => x.name === name && x.date).at(-1);
  if (!last) return Infinity;
  return sessions.filter((d) => d > last.date).length;
}

// ---------- Chạy ----------
let running = null;
/** Tự đánh giá cho phiên mới nhất; `apply` = áp dụng thay đổi (mặc định có). */
export function runSelfReview({ apply = true } = {}) {
  running ??= (async () => {
    const { bars: idx } = await getPriceHistory('VNINDEX');
    const date = idx.at(-1).time, sessions = idx.map((b) => b.time);
    const cache = new Map();
    const barsOf = async (s) => {
      if (!cache.has(s)) cache.set(s, (await getPriceHistory(s).catch(() => null))?.bars || null);
      return cache.get(s);
    };

    const items = (await readJson(TRADES, { items: [] })).items.sort((a, b) => b.date.localeCompare(a.date));
    const scored = [];
    for (const t of items) {
      const bars = await barsOf(t.symbol);
      scored.push({ ...t, s: bars ? scoreTrade(t, bars, idx) : null });
    }
    const recent = (status, f) => scored.filter((x) => x.status === status && f(x)).slice(0, RULES.window);
    const picks = tradeStats(recent('pick', (x) => x.s?.matured));
    const picks10 = excessStats(recent('pick', (x) => x.s?.excess10 != null));
    const rejected10 = excessStats(recent('rejected', (x) => x.s?.excess10 != null));
    const band = await bandCoverage(barsOf);
    const pred = await evaluatePredictions().catch(() => null);
    const accuracy = (pred?.summary || []).map((s) => ({ source: s.source, label: s.label, ...s.horizons.find((h) => h.h === 10) }))
      .filter((s) => s.evaluated > 0);

    const t = getTuning();
    const proposed = proposeChanges({ picks, picks10, rejected10, band }, t);
    const changes = [];
    for (const p of proposed) {
      const wait = RULES.cooldown - sessionsSince(p.name, sessions);
      if (wait > 0) { changes.push({ ...p, skipped: `vừa chỉnh, chờ thêm ${wait} phiên` }); continue; }
      const done = apply ? await setParam(p.name, p.value, p.reason, p.evidence, date) : null;
      if (done) changes.push({ ...p, from: done.from, value: done.to });
    }

    const review = {
      date, at: new Date().toISOString(), trades: { total: items.length, pending: scored.filter((x) => x.status === 'pick' && !x.s?.matured).length },
      picks, picks10, rejected10, band, accuracy, changes, tuning: { ...getTuning() },
    };
    const all = await readJson(REVIEWS, []);
    all.push(review);
    await writeJson(REVIEWS, all.slice(-250));
    return review;
  })().finally(() => (running = null));
  return running;
}

export async function lastReview() {
  return (await readJson(REVIEWS, [])).at(-1) || null;
}

// ---------- Bản tin ----------
const pc = (v, d = 0) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toLocaleString('vi-VN', { maximumFractionDigits: d })}%`);
const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
const NAMES = { minStopAtr: 'Cắt lỗ tối thiểu (ATR)', widen: 'Độ rộng dải giá', aiVeto: 'AI được loại mã', caution: 'Chế độ thận trọng' };
const val = (v) => (v === true ? 'bật' : v === false ? 'tắt' : String(v).replace('.', ','));

/** Tin Telegram ngắn tóm tắt lần tự đánh giá. */
export function formatReview(rv) {
  const d = `${rv.date.slice(8, 10)}/${rv.date.slice(5, 7)}`;
  const L = [`🔍 <b>TỰ ĐÁNH GIÁ ${d}</b>`];
  const p = rv.picks;
  if (p.n) L.push(`Gợi ý mua (${p.n} lệnh đã xong): thắng ${pct(p.winRate)} · TB ${pc(p.avgRet, 1)}/lệnh · chạm cắt lỗ ${pct(p.stopRate)} · chạm chốt lời ${pct(p.targetRate)}`);
  else L.push(`Gợi ý mua: chưa lệnh nào đủ 20 phiên (đang theo dõi ${rv.trades.pending})`);
  if (rv.picks10.n) L.push(`Sau 10 phiên so với VN-Index: AI chọn ${pc(rv.picks10.avgExcess10, 1)} (${rv.picks10.n})${rv.rejected10.n ? ` · AI loại ${pc(rv.rejected10.avgExcess10, 1)} (${rv.rejected10.n})` : ''}`);
  const acc = rv.accuracy.filter((a) => ['rank_all', 'final', 'ai'].includes(a.source));
  if (acc.length) L.push(`Đúng so VN-Index sau 10 phiên: ${acc.map((a) => `${a.source === 'rank_all' ? 'xếp hạng' : a.source === 'final' ? 'quyết định cuối' : 'AI'} ${pct(a.beatIndexRate ?? a.hitRate)} (${a.evaluated})`).join(' · ')}`);
  if (rv.band.n) L.push(`Dải giá 5 phiên chứa giá thật ${pct(rv.band.coverage90)} (chuẩn 90%, ${rv.band.n} lần)`);
  const made = rv.changes.filter((c) => !c.skipped);
  if (made.length) for (const c of made) L.push(`🔧 ${NAMES[c.name]}: ${val(c.from)} → <b>${val(c.value)}</b>. ${c.reason}`);
  else if (p.n < RULES.minSample) L.push(`Chưa tự chỉnh: cần ≥ ${RULES.minSample} lệnh đã xong (đang có ${p.n}).`);
  else L.push('Không cần chỉnh: các chỉ số trong ngưỡng.');
  return L.join('\n');
}

/**
 * Mỗi 30 phút: phiên hôm nay đã đóng cửa (sau 15:30) mà chưa tự đánh giá thì chạy. Gửi Telegram khi có thay đổi
 * hoặc vào thứ Sáu (tổng kết tuần).
 */
export function startSelfReview(notify = null) {
  const tick = async () => {
    try {
      const vn = new Date(Date.now() + 7 * 3600_000);
      const today = vn.toISOString().slice(0, 10);
      if (vn.getUTCHours() * 60 + vn.getUTCMinutes() < 15 * 60 + 30) return;
      const { bars } = await getPriceHistory('VNINDEX');
      if (bars.at(-1)?.time !== today || (await lastReview())?.date === today) return;
      const rv = await runSelfReview();
      console.log(`[Tự đánh giá] ${today}: ${rv.picks.n} lệnh đã xong, ${rv.changes.filter((c) => !c.skipped).length} thay đổi`);
      if (notify && (rv.changes.some((c) => !c.skipped) || vn.getUTCDay() === 5)) await notify(formatReview(rv));
    } catch (err) {
      console.error('[Tự đánh giá] Lỗi:', err.message);
    }
  };
  setTimeout(tick, 90_000);
  return setInterval(tick, 30 * 60_000);
}
