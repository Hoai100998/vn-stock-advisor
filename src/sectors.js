// Dòng tiền theo nhóm ngành (phân ngành ICB cấp 3 của VNDirect) trên rổ cổ phiếu được theo dõi
// (mặc định HOSE, giá trị giao dịch TB 20 phiên ≥ 5 tỷ). Cho 1 / 5 / 20 phiên gần nhất:
//  - Dòng tiền ròng ƯỚC TÍNH: cộng giá trị giao dịch của các phiên mã tăng giá, trừ giá trị các phiên mã giảm giá.
//    Không phải số liệu lệnh mua/bán chủ động thật (nguồn công khai không có), chỉ là cách đọc phổ biến.
//  - Khối ngoại mua/bán ròng: số liệu thật từ sàn.
//  - Giá trị giao dịch so với trung bình 20 phiên trước đó, % thay đổi giá (bình quân theo giá trị), độ rộng tăng/giảm.
import { fetchJson, cached } from './http.js';
import { getPriceHistory, screenCriteria } from './data.js';
import { getRankBoard } from './ranking.js';

const FINFO = 'https://api-finfo.vndirect.com.vn/v4';
const MIN = 60_000;
export const PERIODS = [1, 5, 20];
export const MAX_PERIOD = 60; // số phiên tùy chỉnh tối đa (~3 tháng)

/** Chuẩn hóa số phiên người dùng nhập: số nguyên 1..MAX_PERIOD. */
export function normalizePeriod(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v >= 1 ? Math.min(MAX_PERIOD, v) : 1;
}

// Tên ngắn gọn, quen thuộc với nhà đầu tư Việt Nam cho một số ngành ICB
const RENAME = {
  'Dịch vụ tài chính': 'Chứng khoán & Dịch vụ tài chính',
  'Dịch vụ Đầu tư Bất Động Sản': 'Bất động sản',
  'Quỹ đầu tư Bất Động Sản': 'Bất động sản',
  'Kim loại công nghiệp': 'Thép & Kim loại',
  'Giao thông công nghiệp': 'Vận tải, Cảng & Logistics',
  'Ga, nước & dịch vụ công cộng gia dụng': 'Khí đốt, Nước & Tiện ích',
  'Dụng cụ, dịch vụ & Phân phối Dầu': 'Dịch vụ & Phân phối dầu khí',
  'Phần mềm & Dịch vụ máy tính': 'Công nghệ phần mềm',
  'Dụng cụ & công nghệ phần cứng': 'Công nghệ phần cứng',
  'Dược phẩm & công nghệ sinh học': 'Dược phẩm',
  'Bảo hiểm phi nhân thọ': 'Bảo hiểm',
  'Bảo hiểm nhân thọ': 'Bảo hiểm',
};

/** Mã → { code, name } ngành ICB cấp 3 (cache 1 ngày). */
export function getIndustryMap() {
  return cached('industry-map', 24 * 60 * MIN, async () => {
    const res = await fetchJson(`${FINFO}/industry_classification?q=industryLevel:3&size=300`);
    const map = new Map();
    for (const d of res.data || []) {
      const name = RENAME[d.vietnameseName?.trim()] || d.vietnameseName?.trim();
      for (const sym of String(d.codeList || '').split(',')) if (sym) map.set(sym.trim(), { code: d.industryCode, name });
    }
    if (!map.size) throw new Error('Không lấy được phân ngành');
    return map;
  });
}

const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Chỉ số dòng tiền của một mã cho N phiên gần nhất.
 * @param {{date:string, value:number, pctChange:number}[]} days giao dịch theo ngày, cũ → mới (value: giá trị khớp lệnh, đồng)
 * @param {{netVal:number}[]|null} foreign khối ngoại theo ngày, mới → cũ
 */
export function stockFlow(days, foreign, n) {
  const last = days.length - 1;
  if (last < n + 19) return null;
  let value = 0, net = 0, growth = 1;
  for (let i = last - n + 1; i <= last; i++) {
    const v = days[i].value || 0, p = days[i].pctChange || 0;
    value += v;
    if (p > 0) net += v; else if (p < 0) net -= v;
    growth *= 1 + p / 100;
  }
  // Trung bình 20 phiên TRƯỚC giai đoạn đang xét, để biết tiền đang vào nhiều hơn hay ít hơn bình thường
  let base = 0;
  for (let i = last - n - 19; i <= last - n; i++) base += days[i].value || 0;
  base /= 20;
  const fNet = foreign?.length ? foreign.slice(0, n).reduce((t, d) => t + (d.netVal || 0), 0) : null;
  return { value, net, valueRatio: base ? value / n / base : null, ret: growth - 1, foreignNet: fNet };
}

/**
 * Giao dịch theo ngày và khối ngoại của toàn sàn đủ cho `n` phiên + 20 phiên so sánh (cache 10 phút).
 * Cửa sổ làm tròn lên 45 hoặc 85 phiên để các số phiên khác nhau dùng chung cache.
 */
export function getFloorDaily(n = 1) {
  const { floors } = screenCriteria();
  const window = n + 22 <= 45 ? 45 : MAX_PERIOD + 25;
  return cached(`floor-daily:${floors}:${window}`, 10 * MIN, async () => {
    const { bars } = await getPriceHistory('VNINDEX', 200);
    const from = bars[Math.max(0, bars.length - window)].time;
    // Lấy theo trang nếu số dòng vượt giới hạn một lần gọi
    const q = (path, fields, dateKey) => Promise.all(floors.map(async (fl) => {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const r = await fetchJson(`${FINFO}/${path}?q=floor:${fl}~type:STOCK~${dateKey}:gte:${from}&size=20000&page=${page}&fields=${fields}`);
        out.push(...(r.data || []));
        if (!r.totalPages || page >= r.totalPages) break;
      }
      return out;
    }));
    const [prices, foreigns] = await Promise.all([
      q('stock_prices', 'code,date,close,pctChange,nmValue', 'date'),
      q('foreigns', 'code,tradingDate,netVal', 'tradingDate'),
    ]);
    const daily = new Map(), foreign = new Map();
    for (const d of prices.flat()) {
      if (!daily.has(d.code)) daily.set(d.code, []);
      daily.get(d.code).push({ date: d.date, close: d.close, pctChange: d.pctChange, value: d.nmValue });
    }
    for (const list of daily.values()) list.sort((x, y) => x.date.localeCompare(y.date));
    for (const d of foreigns.flat()) {
      if (!foreign.has(d.code)) foreign.set(d.code, []);
      foreign.get(d.code).push({ date: d.tradingDate, netVal: d.netVal });
    }
    for (const list of foreign.values()) list.sort((x, y) => y.date.localeCompare(x.date));
    return { daily, foreign, date: bars.at(-1).time };
  });
}

/** Gộp các mã theo ngành và xếp hạng ngành theo dòng tiền ròng ước tính. */
export function aggregateSectors(stocks) {
  const by = new Map();
  for (const s of stocks) {
    if (!by.has(s.industry)) by.set(s.industry, []);
    by.get(s.industry).push(s);
  }
  const totalValue = stocks.reduce((t, s) => t + s.value, 0);
  const sectors = [...by].map(([name, list]) => {
    const value = list.reduce((t, s) => t + s.value, 0);
    const net = list.reduce((t, s) => t + s.net, 0);
    const fList = list.filter((s) => s.foreignNet != null);
    const sorted = [...list].sort((a, b) => b.net - a.net);
    return {
      name, count: list.length,
      value, net, netRatio: value ? net / value : 0,
      share: totalValue ? value / totalValue : 0,
      valueRatio: value ? list.reduce((t, s) => t + (s.valueRatio ?? 1) * s.value, 0) / value : null,
      ret: value ? list.reduce((t, s) => t + s.ret * s.value, 0) / value : 0,
      up: list.filter((s) => s.ret > 0).length,
      down: list.filter((s) => s.ret < 0).length,
      foreignNet: fList.length ? fList.reduce((t, s) => t + s.foreignNet, 0) : null,
      topBought: sorted.filter((s) => s.net > 0).slice(0, 5).map((s) => s.symbol),
      topSold: [...sorted].reverse().filter((s) => s.net < 0).slice(0, 5).map((s) => s.symbol),
      stocks: [...list].sort((a, b) => b.value - a.value),
    };
  });
  return sectors.sort((a, b) => b.net - a.net);
}

/**
 * Bảng dòng tiền theo ngành cho n phiên (1, 5 hoặc 20). Cache 10 phút.
 */
export function getSectorFlows(n = 1) {
  n = normalizePeriod(n);
  return cached(`sectors:${n}`, 10 * MIN, async () => {
    const [{ daily, foreign, date }, industries, board] = await Promise.all([
      getFloorDaily(n), getIndustryMap(), getRankBoard().catch(() => null),
    ]);
    const { minValue, floors } = screenCriteria();
    const rankBy = new Map((board?.rows || []).map((r) => [r.symbol, r]));
    const data = [];
    for (const [symbol, days] of daily) {
      if (!/^[A-Z0-9]{3}$/.test(symbol)) continue;
      // Cùng tiêu chí thanh khoản với bộ lọc: giá trị khớp lệnh TB 20 phiên gần nhất
      const recent = days.slice(-20);
      if (recent.length < 20 || recent.reduce((t, x) => t + (x.value || 0), 0) / 20 < minValue) continue;
      const f = stockFlow(days, foreign.get(symbol), n);
      if (!f) continue;
      const r = rankBy.get(symbol);
      data.push({
        symbol, industry: industries.get(symbol)?.name || 'Khác', close: days.at(-1).close,
        rank: r?.score ?? null, rankCode: r?.code ?? null, ...f,
      });
    }
    const sectors = aggregateSectors(data).map((s) => ({
      ...s,
      value: Math.round(s.value), net: Math.round(s.net), netRatio: round(s.netRatio, 4), share: round(s.share, 4),
      valueRatio: round(s.valueRatio, 2), ret: round(s.ret, 4), foreignNet: s.foreignNet == null ? null : Math.round(s.foreignNet),
      stocks: s.stocks.map((x) => ({
        symbol: x.symbol, close: x.close, ret: round(x.ret, 4), value: Math.round(x.value), net: Math.round(x.net),
        valueRatio: round(x.valueRatio, 2), foreignNet: x.foreignNet == null ? null : Math.round(x.foreignNet),
        rank: x.rank, rankCode: x.rankCode,
      })),
    }));
    const market = {
      value: Math.round(data.reduce((t, s) => t + s.value, 0)),
      net: Math.round(data.reduce((t, s) => t + s.net, 0)),
      foreignNet: Math.round(data.reduce((t, s) => t + (s.foreignNet || 0), 0)),
    };
    return { period: n, date, universe: data.length, criteria: { floors, minValue }, market, sectors, updatedAt: new Date().toISOString() };
  });
}
