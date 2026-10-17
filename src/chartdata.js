// Dữ liệu biểu đồ theo khung thời gian: nến ngày / tuần / tháng kèm MA20, MA50, MA200 tính trên chính khung đó.
import { getPriceHistory } from './data.js';
import { sma } from './indicators.js';

// Số ngày lịch sử cần lấy cho mỗi khung (nến tuần ~10 năm, nến tháng từ 2013)
export const TIMEFRAMES = {
  D: { label: 'Ngày', days: 1825 },
  W: { label: 'Tuần', days: 3650 },
  M: { label: 'Tháng', days: 7300 },
};

// Khóa nhóm: tuần = ngày thứ Hai của tuần (UTC), tháng = YYYY-MM
function periodKey(time, tf) {
  if (tf === 'M') return time.slice(0, 7);
  const d = new Date(`${time}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Gộp nến ngày thành nến tuần/tháng. Mốc thời gian của nến gộp = phiên giao dịch đầu tiên trong kỳ.
 * @param {{time: string, open: number, high: number, low: number, close: number, volume: number}[]} bars nến ngày, tăng dần
 */
export function aggregateBars(bars, tf) {
  if (tf === 'D') return bars;
  const out = [];
  let cur = null, key = null;
  for (const b of bars) {
    const k = periodKey(b.time, tf);
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const round = (v) => Math.round(v * 1000) / 1000;

/** Nến + MA cho một mã theo khung D/W/M. */
export async function getChartSeries(symbol, tf = 'D') {
  const frame = TIMEFRAMES[tf] ? tf : 'D';
  const { bars: daily } = await getPriceHistory(symbol, TIMEFRAMES[frame].days);
  const bars = aggregateBars(daily, frame);
  const closes = bars.map((b) => b.close);
  const line = (arr) => arr.map((v, i) => (v == null ? null : { time: bars[i].time, value: round(v) })).filter(Boolean);
  return {
    symbol, tf: frame, label: TIMEFRAMES[frame].label,
    bars, sma20: line(sma(closes, 20)), sma50: line(sma(closes, 50)), sma200: line(sma(closes, 200)),
  };
}
