// Nhật ký dự đoán: ghi lại mọi khuyến nghị (hệ thống, xếp hạng, Gemini, hội đồng, cổ phiếu tiềm năng)
// rồi tự chấm đúng/sai sau 5, 10, 20 phiên dựa trên giá thực tế. Lưu ở data/predictions.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory } from './data.js';
import { cached, uncache } from './http.js';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'predictions.json');
const MAX_ITEMS = 40000; // ~150 phiên × (2 dự đoán × ~130 mã) + dự đoán lẻ
export const HORIZONS = [5, 10, 20];
export const SOURCES = {
  rank_all: 'Điểm xếp hạng — toàn bộ rổ (mỗi phiên)',
  legacy_all: 'Điểm kiểu cũ — toàn bộ rổ (mỗi phiên)',
  final: 'Quyết định cuối (hệ thống + AI thẩm định)',
  rule: 'Khuyến nghị hệ thống (mã đã xem)',
  rank: 'Điểm xếp hạng (mã đã xem)',
  rank_top: 'Top 8 bảng xếp hạng',
  ai: 'Gemini phân tích',
  committee: 'Hội đồng đầu tư',
  screener: 'Cổ phiếu tiềm năng (Gemini chọn)',
  outlook: 'Xu hướng VN-Index tuần (AI)',
  outlook_sector: 'Mã thuộc ngành AI dự báo triển vọng tuần',
};

let state = null;
let loading = null;
let saving = Promise.resolve();
let dirty = false;

// Chỉ đọc file một lần kể cả khi nhiều lời gọi đến cùng lúc
function load() {
  loading ??= readFile(FILE, 'utf8').then((s) => JSON.parse(s)).catch(() => ({})).then((s) => {
    state = s;
    state.items ??= [];
    return state;
  });
  return loading;
}

// Gom nhiều lần ghi trong vài giây thành một lần ghi file
function scheduleSave() {
  if (dirty) return;
  dirty = true;
  setTimeout(() => {
    dirty = false;
    saving = saving.then(async () => {
      await mkdir(dirname(FILE), { recursive: true });
      await writeFile(FILE, JSON.stringify(state), 'utf8');
    }).catch((err) => console.error('Lỗi ghi nhật ký dự đoán:', err.message));
  }, 2000).unref?.();
}

/**
 * Ghi một dự đoán. Mỗi nguồn + mã + phiên chỉ giữ dự đoán mới nhất.
 * @param {{ source: string, symbol: string, date: string, direction: -1|0|1, label: string, price?: number, detail?: string }} p
 */
export async function recordPrediction(p) {
  if (!SOURCES[p.source] || !p.symbol || !/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) return;
  await load();
  const item = {
    source: p.source, symbol: p.symbol, date: p.date, direction: Math.sign(p.direction || 0),
    label: String(p.label || ''), price: p.price ?? null, detail: p.detail ? String(p.detail).slice(0, 160) : undefined,
    at: new Date().toISOString(),
  };
  const k = state.items.findIndex((x) => x.source === item.source && x.symbol === item.symbol && x.date === item.date);
  if (k >= 0) state.items[k] = item;
  else state.items.push(item);
  if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS);
  uncache('pred-eval');
  scheduleSave();
}

export function recordMany(list) {
  return Promise.all(list.map((p) => recordPrediction(p).catch(() => {})));
}

/** Chấm một dự đoán với chuỗi giá của mã và VN-Index. */
export function scoreItem(item, bars, indexBars) {
  const i = bars.findIndex((b) => b.time === item.date);
  if (i < 0) return null;
  const j = indexBars.findIndex((b) => b.time === item.date);
  const out = {};
  for (const h of HORIZONS) {
    if (i + h >= bars.length) continue;
    const ret = bars[i + h].close / bars[i].close - 1;
    const iret = j >= 0 && j + h < indexBars.length ? indexBars[j + h].close / indexBars[j].close - 1 : null;
    out[h] = {
      ret, excess: iret == null ? null : ret - iret,
      correct: item.direction ? Math.sign(ret) === item.direction : null,
      beatIndex: item.direction && iret != null ? (item.direction > 0 ? ret > iret : ret < iret) : null,
    };
  }
  return out;
}

/** Tổng hợp độ chính xác theo nguồn và khung thời gian (cache 10 phút). */
export function evaluatePredictions() {
  return cached('pred-eval', 10 * 60_000, async () => {
    await load();
    const items = state.items;
    const syms = [...new Set(items.map((x) => x.symbol))];
    const indexRes = await getPriceHistory('VNINDEX').catch(() => null);
    const bars = {};
    for (let k = 0; k < syms.length; k += 6) {
      await Promise.all(syms.slice(k, k + 6).map(async (s) => {
        bars[s] = (await getPriceHistory(s).catch(() => null))?.bars || null;
      }));
    }
    const idx = indexRes?.bars || [];
    const scored = items.map((it) => ({ ...it, result: bars[it.symbol] ? scoreItem(it, bars[it.symbol], idx) : null }));

    const summary = Object.entries(SOURCES).map(([source, label]) => {
      const mine = scored.filter((x) => x.source === source);
      const horizons = HORIZONS.map((h) => {
        const done = mine.filter((x) => x.direction && x.result?.[h]);
        const buys = done.filter((x) => x.direction > 0), sells = done.filter((x) => x.direction < 0);
        const avg = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : null);
        return {
          h,
          evaluated: done.length,
          hitRate: done.length ? done.filter((x) => x.result[h].correct).length / done.length : null,
          beatIndexRate: done.filter((x) => x.result[h].beatIndex != null).length
            ? done.filter((x) => x.result[h].beatIndex).length / done.filter((x) => x.result[h].beatIndex != null).length : null,
          buyCount: buys.length, sellCount: sells.length,
          buyAvgReturn: avg(buys, (x) => x.result[h].ret),
          sellAvgReturn: avg(sells, (x) => x.result[h].ret),
          // Tín hiệu xếp hạng là tương đối (mua = hơn thị trường, tránh = kém thị trường) nên chấm chính theo VN-Index
          buyAvgExcess: avg(buys.filter((x) => x.result[h].excess != null), (x) => x.result[h].excess),
          sellAvgExcess: avg(sells.filter((x) => x.result[h].excess != null), (x) => x.result[h].excess),
        };
      });
      return {
        source, label,
        total: mine.length,
        directional: mine.filter((x) => x.direction).length,
        pending: mine.filter((x) => x.direction && !x.result?.[HORIZONS[0]]).length,
        horizons,
      };
    });
    const recent = scored.slice().sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at)).slice(0, 80);
    return { updatedAt: new Date().toISOString(), totalItems: items.length, firstDate: items.reduce((m, x) => (!m || x.date < m ? x.date : m), null), summary, recent };
  });
}
