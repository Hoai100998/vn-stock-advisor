// Quá khứ → tương lai: dải dao động giá các phiên tới, kịch bản AI, lời/lỗ dự kiến và kiểm chứng trên quá khứ.
//
// Dải thống kê: phân phối lợi suất h phiên của CHÍNH mã đó trong ~2 năm trước (các cửa sổ chồng nhau), bỏ phần
// trôi trung bình (không giả định giá tự tăng hay giảm) → phân vị 5/25/50/75/95. Phương pháp chỉ ước lượng
// BIÊN ĐỘ, không dự báo hướng; hướng do AI đưa ra theo kịch bản và được đối chiếu sau khi đủ phiên.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory } from './data.js';
import { DEFAULTS } from './backtest.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'forecasts.json');
export const LOOKBACK = 500;      // số phiên quá khứ dùng để ước lượng
export const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
export const AI_HORIZONS = [5, 10, 20];
// Phí mua + phí bán + thuế bán (đọc khi dùng: forecast.js nằm trong vòng import với backtest.js)
const roundTrip = () => DEFAULTS.brokerage * 2 + DEFAULTS.sellTax;

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Lợi suất log h phiên (đã bỏ trôi trung bình) trong cửa sổ [from, to] của chuỗi giá đóng cửa. */
function hReturns(closes, h, from, to) {
  const out = [];
  for (let i = Math.max(0, from); i + h <= to; i++) out.push(Math.log(closes[i + h] / closes[i]));
  if (!out.length) return out;
  const mean = out.reduce((a, b) => a + b, 0) / out.length;
  return out.map((x) => x - mean).sort((a, b) => a - b);
}

/** Các phiên giao dịch tiếp theo (thứ 2 – thứ 6; chưa trừ ngày lễ). */
export function futureDates(lastDate, n) {
  const out = [];
  const d = new Date(`${lastDate}T00:00:00Z`);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Dải giá cho từng phiên 1..H tính từ phiên cuối.
 * @returns {{ h: number, date: string, p05: number, p25: number, p50: number, p75: number, p95: number, probUp: number }[]}
 */
export function priceCone(bars, H, { lookback = LOOKBACK } = {}) {
  const closes = bars.map((b) => b.close);
  const end = closes.length - 1, close = closes[end];
  const dates = futureDates(bars.at(-1).time, H);
  const out = [];
  for (let h = 1; h <= H; h++) {
    const r = hReturns(closes, h, end - lookback, end);
    if (r.length < 30) break;
    const [p05, p25, p50, p75, p95] = QUANTILES.map((q) => round(close * Math.exp(quantile(r, q))));
    // Xác suất giá sau h phiên đủ bù phí + thuế khứ hồi (nếu không có xu hướng)
    const be = Math.log(1 + roundTrip());
    out.push({ h, date: dates[h - 1], p05, p25, p50, p75, p95, probProfit: round(r.filter((x) => x > be).length / r.length, 3) });
  }
  return out;
}

/** Tóm tắt dải ở một số mốc (dùng trong prompt AI). */
export function coneSummary(bars, horizons = AI_HORIZONS) {
  const H = Math.max(...horizons);
  const cone = priceCone(bars, H);
  return horizons.map((h) => cone.find((c) => c.h === h)).filter(Boolean);
}

/**
 * Kiểm chứng trên quá khứ: tại mỗi phiên t (cách nhau `step` phiên, trong `years` năm gần nhất), dựng dải chỉ bằng
 * dữ liệu TRƯỚC t rồi so với giá thực tế sau h phiên. Dải 50% chứa giá thật ~50% số lần, dải 90% ~90% là dải chuẩn.
 */
export function validateCone(bars, h, { years = 2, step = 5, lookback = LOOKBACK } = {}) {
  const closes = bars.map((b) => b.close);
  const end = closes.length - 1;
  const first = Math.max(lookback / 2, end - Math.round(years * 250));
  const points = [];
  for (let t = first; t + h <= end; t += step) {
    const r = hReturns(closes, h, t - lookback, t);
    if (r.length < 60) continue;
    const c = closes[t];
    const q = QUANTILES.map((p) => c * Math.exp(quantile(r, p)));
    const actual = closes[t + h];
    points.push({
      from: bars[t].time, date: bars[t + h].time, close: c, actual,
      p05: round(q[0]), p25: round(q[1]), p50: round(q[2]), p75: round(q[3]), p95: round(q[4]),
      in50: actual >= q[1] && actual <= q[3], in90: actual >= q[0] && actual <= q[4],
    });
  }
  const n = points.length;
  return {
    h, n, step, years,
    coverage50: n ? round(points.filter((p) => p.in50).length / n, 3) : null,
    coverage90: n ? round(points.filter((p) => p.in90).length / n, 3) : null,
    above95: n ? round(points.filter((p) => p.actual > p.p95).length / n, 3) : null,
    below05: n ? round(points.filter((p) => p.actual < p.p05).length / n, 3) : null,
    points,
  };
}

// ---------- Lưu dự báo AI để đối chiếu sau ----------
let store = null;
async function load() {
  if (store) return store;
  try { store = JSON.parse(await readFile(FILE, 'utf8')); } catch { store = {}; }
  return store;
}

/** Ghi dự báo kịch bản của AI (mỗi mã/phiên giữ bản mới nhất). */
export async function recordForecast(symbol, { date, close, forecast, source = 'gemini' }) {
  if (!forecast?.scenarios?.length || !date) return;
  await load();
  store[symbol] ??= {};
  store[symbol][date] = { date, close, source, at: new Date().toISOString(), scenarios: forecast.scenarios, expected: forecast.expected ?? null };
  const dates = Object.keys(store[symbol]).sort();
  for (const d of dates.slice(0, Math.max(0, dates.length - 120))) delete store[symbol][d];
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store), 'utf8');
}

/** Các dự báo AI cũ kèm giá thực tế ở mốc 5/10/20 phiên (null nếu chưa đến). */
export async function pastForecasts(symbol, bars) {
  await load();
  const at = new Map(bars.map((b, i) => [b.time, i]));
  return Object.values(store[symbol] || {}).sort((a, b) => a.date.localeCompare(b.date)).map((f) => {
    const i = at.get(f.date);
    const base = f.scenarios.find((s) => s.name === 'CO_SO') || f.scenarios[0];
    const checks = AI_HORIZONS.map((h) => {
      const actual = i != null && i + h < bars.length ? bars[i + h].close : null;
      const target = base?.[`p${h}`] ?? null;
      const lo = Math.min(...f.scenarios.map((s) => s[`p${h}`]).filter(Number.isFinite));
      const hi = Math.max(...f.scenarios.map((s) => s[`p${h}`]).filter(Number.isFinite));
      return {
        h, date: i != null && i + h < bars.length ? bars[i + h].time : null, actual, target,
        error: actual != null && target ? round((actual / target - 1) * 100, 1) : null,
        inRange: actual != null && Number.isFinite(lo) ? actual >= lo && actual <= hi : null,
        directionOk: actual != null && target ? Math.sign(actual - f.close) === Math.sign(target - f.close) : null,
      };
    });
    return { ...f, checks };
  });
}

/** Lời/lỗ khi mua `capital` đồng ở giá `entry` và bán ở `exit` (đã trừ phí mua, phí bán, thuế bán; lô 100). */
export function pnl(capital, entry, exit) {
  const shares = Math.floor(capital / (entry * 1000 * (1 + DEFAULTS.brokerage)) / 100) * 100;
  if (!shares) return { shares: 0, pnl: 0, pct: 0 };
  const cost = shares * entry * 1000 * (1 + DEFAULTS.brokerage);
  const proceeds = shares * exit * 1000 * (1 - DEFAULTS.brokerage - DEFAULTS.sellTax);
  return { shares, pnl: Math.round(proceeds - cost), pct: round((proceeds / cost - 1) * 100) };
}

/**
 * Dữ liệu cho thẻ "Quá khứ → Tương lai".
 * @param {{ horizon?: number, ai?: object|null }} opts ai = kết quả Gemini gần nhất (có forecast) nếu có
 */
export async function getForecast(symbol, { horizon = 20, ai = null } = {}) {
  const H = [5, 10, 20, 60].includes(Number(horizon)) ? Number(horizon) : 20;
  const { bars } = await getPriceHistory(symbol, 1100);
  if (bars.length < 300) throw new Error(`Mã ${symbol} có quá ít dữ liệu để dự báo (${bars.length} phiên)`);
  const close = bars.at(-1).close;
  const cone = priceCone(bars, H);
  const validation = validateCone(bars, H);
  const past = await pastForecasts(symbol, bars);
  return {
    symbol, date: bars.at(-1).time, close, horizon: H, lookback: LOOKBACK, roundTrip: roundTrip(),
    history: bars.slice(-Math.max(120, H * 3)).map((b) => ({ time: b.time, close: b.close })),
    cone,
    validation: { ...validation, points: validation.points.slice(-Math.round(250 / validation.step) * 2) },
    ai: ai?.forecast && ai.priceDate === bars.at(-1).time ? { ...ai.forecast, model: ai.model, createdAt: ai.createdAt } : null,
    aiStale: ai?.forecast && ai.priceDate !== bars.at(-1).time ? { date: ai.priceDate } : null,
    past,
  };
}
