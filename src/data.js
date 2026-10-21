// Lấy dữ liệu giá và chỉ số cơ bản từ các API công khai.
import { fetchJson, cached } from './http.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

// Chuẩn TradingView UDF: { s, t[], o[], h[], l[], c[], v[] }
function udfToBars(d) {
  if (!d || !Array.isArray(d.t) || d.t.length === 0) return null;
  return d.t.map((t, i) => ({
    time: new Date(t * 1000).toISOString().slice(0, 10),
    open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i], volume: d.v[i],
  }));
}

const PRICE_SOURCES = [
  {
    name: 'VNDirect',
    url: (s, from, to) => `https://dchart-api.vndirect.com.vn/dchart/history?resolution=D&symbol=${s}&from=${from}&to=${to}`,
    parse: (d) => udfToBars(d),
  },
  {
    name: 'VPS',
    url: (s, from, to) => `https://histdatafeed.vps.com.vn/tradingview/history?symbol=${s}&resolution=D&from=${from}&to=${to}`,
    parse: (d) => udfToBars(d),
  },
  {
    name: 'SSI',
    url: (s, from, to) => `https://iboard-api.ssi.com.vn/statistics/charts/history?resolution=1D&symbol=${s}&from=${from}&to=${to}`,
    parse: (d) => udfToBars(d?.data),
  },
];

/**
 * Giá ngày (đơn vị nghìn đồng với cổ phiếu, điểm với chỉ số) của ~1,5 năm gần nhất.
 * Thử lần lượt các nguồn, nguồn đầu tiên trả dữ liệu hợp lệ sẽ được dùng.
 */
export function getPriceHistory(symbol, days = 550) {
  return cached(`price:${symbol}:${days}`, 2 * MIN, async () => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    const errors = [];
    for (const src of PRICE_SOURCES) {
      try {
        const bars = src.parse(await fetchJson(src.url(symbol, from, to)));
        // Quanh giờ đóng cửa nguồn có thể trả nến tạm cho phiên chưa chốt (volume 0, high = low):
        // bỏ đi để không phân tích/chụp bằng giá phiên trước.
        const last = bars?.at(-1);
        if (bars?.length > 1 && !last.volume && last.high === last.low) bars.pop();
        if (bars && bars.length) return { source: src.name, bars };
        errors.push(`${src.name}: không có dữ liệu`);
      } catch (err) {
        errors.push(`${src.name}: ${err.message}`);
      }
    }
    throw new Error(`Không lấy được giá ${symbol} (${errors.join('; ')})`);
  });
}

// Mã chỉ tiêu trong API ratios của VNDirect
const RATIO_CODES = {
  high52w: 51001,
  low52w: 51002,
  marketCap: 51003,
  sharesOutstanding: 51004,
  pe: 51006,
  beta: 51007,
  ps: 51011,
  pb: 51012,
  avgVol10d: 51016,
  bookValuePerShare: 51023,
  dividendYield: 51033,
  roa: 52001,
  roe: 52002,
  profitGrowthTTM: 52005,
  netProfitTTM: 52015,
  revenueTTM: 52016,
  netMarginTTM: 52021,
  grossMarginTTM: 53006,
  epsTTM: 53007,
  revenueGrowthTTM: 53030,
  profitGrowthQoQYoY: 53035,
  revenueGrowthQYoY: 53032,
  profitGrowth3Y: 53034,
  debtToEquity: 54018,
  currentRatio: 55001,
  foreignOwnership: 57052,
};

export function getFundamentals(symbol) {
  return cached(`fund:${symbol}`, 6 * HOUR, async () => {
    const codes = Object.values(RATIO_CODES).join(',');
    const url = `https://api-finfo.vndirect.com.vn/v4/ratios/latest?filter=itemCode:${codes}&where=code:${symbol}&order=reportDate&fields=itemCode,value,reportDate`;
    const res = await fetchJson(url);
    const byCode = new Map((res.data || []).map((d) => [Number(d.itemCode), d]));
    const out = { reportDate: null };
    for (const [key, code] of Object.entries(RATIO_CODES)) {
      const d = byCode.get(code);
      out[key] = d && Number.isFinite(d.value) ? d.value : null;
    }
    // Ngày báo cáo tài chính gần nhất (dựa trên chỉ tiêu ROE)
    out.reportDate = byCode.get(RATIO_CODES.roe)?.reportDate ?? null;
    return out;
  });
}

const FINFO = 'https://api-finfo.vndirect.com.vn/v4';

/** Giao dịch khối ngoại theo ngày của một mã (mới nhất trước). Giá trị tính bằng đồng. */
export function getForeignFlow(symbol, days = 20) {
  return cached(`foreign:${symbol}:${days}`, 10 * MIN, async () => {
    const url = `${FINFO}/foreigns?q=code:${symbol}&sort=tradingDate:desc&size=${days}&fields=tradingDate,buyVal,sellVal,netVal,netVol`;
    const res = await fetchJson(url);
    return (res.data || []).map((d) => ({
      date: d.tradingDate, buyVal: d.buyVal, sellVal: d.sellVal, netVal: d.netVal, netVol: d.netVol,
    }));
  });
}

export const FLOORS = ['HOSE', 'HNX', 'UPCOM'];

/**
 * Tiêu chí chọn cổ phiếu cho bộ lọc tiềm năng và bảng xếp hạng (đổi trong .env):
 *  SCREEN_FLOORS    sàn được xét, mặc định HOSE (vd "HOSE,HNX")
 *  SCREEN_MIN_VALUE giá trị khớp lệnh trung bình 20 phiên tối thiểu, mặc định 5 tỷ đồng
 */
export function screenCriteria() {
  const floors = (process.env.SCREEN_FLOORS || 'HOSE').toUpperCase().split(',').map((s) => s.trim()).filter((s) => FLOORS.includes(s));
  const minValue = Number(process.env.SCREEN_MIN_VALUE) > 0 ? Number(process.env.SCREEN_MIN_VALUE) : 5e9;
  return { floors: floors.length ? floors : ['HOSE'], minValue };
}

/** Giá trị khớp lệnh trung bình `n` phiên tính đến phiên `end` (đồng; giá nghìn đồng × 1000). */
export function avgTradedValue(bars, n = 20, end = bars.length - 1) {
  const from = Math.max(0, end - n + 1);
  let sum = 0;
  for (let i = from; i <= end; i++) sum += bars[i].close * 1000 * bars[i].volume;
  return end >= from ? sum / (end - from + 1) : 0;
}

/**
 * Danh sách cổ phiếu ứng viên theo sàn đã chọn. Lấy rộng (phiên gần nhất khớp ≥ 1/5 ngưỡng) để không bỏ sót
 * mã có một phiên giao dịch thấp; ngưỡng trung bình 20 phiên được kiểm tra sau khi tải giá.
 */
export function getScreenUniverse() {
  const { floors, minValue } = screenCriteria();
  return cached(`universe:${floors.join(',')}:${minValue}`, 6 * HOUR, async () => {
    const { bars } = await getPriceHistory('VNINDEX', 550);
    const date = bars.at(-1)?.time;
    const lists = await Promise.all(floors.map((floor) => fetchJson(
      `${FINFO}/stock_prices?q=date:${date}~floor:${floor}~type:STOCK~nmValue:gte:${Math.round(minValue / 5)}&size=1000&fields=code,floor`,
    ).then((r) => r.data || [])));
    return lists.flat().filter((d) => /^[A-Z0-9]{3}$/.test(d.code)).map((d) => ({ symbol: d.code, exchange: d.floor }));
  });
}

/**
 * Top cổ phiếu của một sàn trong phiên gần nhất: tăng mạnh, giảm mạnh,
 * giá trị giao dịch lớn, khối ngoại mua ròng và bán ròng nhiều nhất.
 */
export function getMarketMovers(floor = 'HOSE', size = 10) {
  if (!FLOORS.includes(floor)) throw new Error('Sàn không hợp lệ');
  return cached(`movers:${floor}:${size}`, 2 * MIN, async () => {
    // Ngày giao dịch gần nhất: lấy từ VN-Index (các sàn dùng chung lịch giao dịch)
    const { bars } = await getPriceHistory('VNINDEX', 550);
    const date = bars.at(-1)?.time;
    if (!date) throw new Error('Không lấy được ngày giao dịch gần nhất');

    const priceFields = 'code,close,change,pctChange,nmVolume,nmValue';
    const base = `${FINFO}/stock_prices?q=date:${date}~floor:${floor}~type:STOCK`;
    // Chỉ xếp hạng mã đạt ngưỡng giá trị giao dịch trong phiên (mặc định 5 tỷ, theo screenCriteria)
    const minValue = screenCriteria().minValue;
    const liquid = `${base}~nmValue:gte:${minValue}`;
    const fBase = `${FINFO}/foreigns?q=tradingDate:${date}~floor:${floor}~type:STOCK`;
    const fFields = 'code,buyVal,sellVal,netVal,netVol';

    const [gainers, losers, value, fBuy, fSell, all, fAll] = await Promise.all([
      fetchJson(`${liquid}&sort=pctChange:desc&size=${size}&fields=${priceFields}`),
      fetchJson(`${liquid}&sort=pctChange:asc&size=${size}&fields=${priceFields}`),
      fetchJson(`${base}&sort=nmValue:desc&size=${size}&fields=${priceFields}`),
      // Lấy dư để còn đủ mã sau khi bỏ mã thanh khoản thấp
      fetchJson(`${fBase}~netVal:gt:0&sort=netVal:desc&size=${size * 4}&fields=${fFields}`),
      fetchJson(`${fBase}~netVal:lt:0&sort=netVal:asc&size=${size * 4}&fields=${fFields}`),
      // Toàn sàn: độ rộng thị trường và tổng giao dịch khối ngoại
      fetchJson(`${base}&size=3000&fields=pctChange,nmValue`),
      fetchJson(`${fBase}&size=3000&fields=buyVal,sellVal,netVal`),
    ]);
    const sum = (arr, k) => arr.reduce((s, d) => s + (d[k] || 0), 0);
    const breadth = {
      advancers: all.data.filter((d) => d.pctChange > 0).length,
      decliners: all.data.filter((d) => d.pctChange < 0).length,
      unchanged: all.data.filter((d) => !d.pctChange).length,
      totalValue: sum(all.data, 'nmValue'),
    };
    const foreignTotal = { buyVal: sum(fAll.data, 'buyVal'), sellVal: sum(fAll.data, 'sellVal'), netVal: sum(fAll.data, 'netVal') };

    // Bổ sung giá và % thay đổi cho danh sách khối ngoại
    const fCodes = [...new Set([...fBuy.data, ...fSell.data].map((d) => d.code))];
    const prices = fCodes.length
      ? await fetchJson(`${base}~code:${fCodes.join(',')}&size=${fCodes.length}&fields=${priceFields}`)
      : { data: [] };
    const priceBy = new Map(prices.data.map((p) => [p.code, p]));

    const stock = (d) => ({
      symbol: d.code, close: d.close, change: d.change, changePct: d.pctChange, volume: d.nmVolume, value: d.nmValue,
    });
    const foreign = (d) => ({
      ...stock(priceBy.get(d.code) || { code: d.code }), buyVal: d.buyVal, sellVal: d.sellVal, netVal: d.netVal, netVol: d.netVol,
    });
    return {
      floor,
      date,
      breadth,
      foreignTotal,
      gainers: gainers.data.map(stock),
      losers: losers.data.map(stock),
      topValue: value.data.map(stock),
      foreignBuy: fBuy.data.map(foreign).filter((x) => x.value >= minValue).slice(0, size),
      foreignSell: fSell.data.map(foreign).filter((x) => x.value >= minValue).slice(0, size),
      minValue,
    };
  });
}

export function getCompanyInfo(symbol) {
  return cached(`info:${symbol}`, 24 * HOUR, async () => {
    const url = `https://api-finfo.vndirect.com.vn/v4/stocks?q=code:${symbol}&fields=code,companyName,floor,type`;
    const res = await fetchJson(url);
    const d = res.data?.[0];
    return d ? { symbol: d.code, name: d.companyName, exchange: d.floor, type: d.type } : null;
  });
}
