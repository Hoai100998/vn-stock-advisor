// Các chỉ báo kỹ thuật. Mỗi hàm trả mảng cùng độ dài với đầu vào,
// các vị trí chưa đủ dữ liệu có giá trị null.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI theo cách làm mượt của Wilder
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  const calc = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = calc();
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = calc();
  }
  return out;
}

export function macd(values, fast = 12, slow = 26, signal = 9) {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const line = values.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const start = line.findIndex((v) => v != null);
  const sig = new Array(values.length).fill(null);
  if (start >= 0) {
    const e = ema(line.slice(start), signal);
    e.forEach((v, i) => (sig[start + i] = v));
  }
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const win = values.slice(i - period + 1, i + 1);
    const sd = Math.sqrt(win.reduce((a, v) => a + (v - mid[i]) ** 2, 0) / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

// Average True Range (Wilder)
export function atr(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  const tr = bars.map((b, i) =>
    i === 0 ? b.high - b.low
      : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Tỷ suất sinh lời sau n phiên, tính theo %
export function pctChange(values, n) {
  if (values.length <= n) return null;
  const a = values[values.length - 1 - n];
  return a ? ((values[values.length - 1] - a) / a) * 100 : null;
}

// SMA bỏ qua các giá trị null ở đầu chuỗi
function smaFrom(values, period) {
  const out = new Array(values.length).fill(null);
  const start = values.findIndex((v) => v != null);
  if (start < 0) return out;
  sma(values.slice(start), period).forEach((v, i) => (out[start + i] = v));
  return out;
}

/** Stochastic Oscillator (14, 3, 3): %K đã làm mượt và %D. */
export function stochastic(bars, period = 14, smoothK = 3, smoothD = 3) {
  const raw = bars.map((_, i) => {
    if (i < period - 1) return null;
    const win = bars.slice(i - period + 1, i + 1);
    const hh = Math.max(...win.map((b) => b.high));
    const ll = Math.min(...win.map((b) => b.low));
    return hh === ll ? 50 : ((bars[i].close - ll) / (hh - ll)) * 100;
  });
  const k = smaFrom(raw, smoothK);
  return { k, d: smaFrom(k, smoothD) };
}

/** ADX và hai đường +DI/-DI (Wilder). ADX > 25: có xu hướng rõ; < 20: đi ngang. */
export function adx(bars, period = 14) {
  const n = bars.length;
  const out = { adx: new Array(n).fill(null), plusDI: new Array(n).fill(null), minusDI: new Array(n).fill(null) };
  if (n <= period * 2) return out;
  const tr = [0], pdm = [0], mdm = [0];
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const down = bars[i - 1].low - bars[i].low;
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  }
  let sTR = 0, sP = 0, sM = 0;
  for (let i = 1; i <= period; i++) { sTR += tr[i]; sP += pdm[i]; sM += mdm[i]; }
  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      sTR = sTR - sTR / period + tr[i];
      sP = sP - sP / period + pdm[i];
      sM = sM - sM / period + mdm[i];
    }
    const p = sTR ? (sP / sTR) * 100 : 0;
    const m = sTR ? (sM / sTR) * 100 : 0;
    out.plusDI[i] = p;
    out.minusDI[i] = m;
    dx[i] = p + m ? (Math.abs(p - m) / (p + m)) * 100 : 0;
  }
  let a = dx.slice(period, period * 2).reduce((s, v) => s + v, 0) / period;
  out.adx[period * 2 - 1] = a;
  for (let i = period * 2; i < n; i++) {
    a = (a * (period - 1) + dx[i]) / period;
    out.adx[i] = a;
  }
  return out;
}

/** Money Flow Index: RSI có trọng số khối lượng. */
export function mfi(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  for (let i = period; i < bars.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const flow = tp[j] * bars[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** On-Balance Volume. */
export function obv(bars) {
  let acc = 0;
  return bars.map((b, i) => {
    if (i > 0) {
      if (b.close > bars[i - 1].close) acc += b.volume;
      else if (b.close < bars[i - 1].close) acc -= b.volume;
    }
    return acc;
  });
}

// Chỉ số các đáy (hoặc đỉnh) cục bộ: thấp (cao) nhất trong cửa sổ ±w phiên
function swings(values, w, findLows) {
  const idx = [];
  for (let i = w; i < values.length - 1; i++) {
    const win = values.slice(i - w, Math.min(values.length, i + w + 1));
    const v = values[i];
    if (findLows ? v === Math.min(...win) : v === Math.max(...win)) idx.push(i);
  }
  return idx;
}

/**
 * Phân kỳ RSI trong `lookback` phiên gần nhất.
 * Tăng giá: giá tạo đáy thấp hơn nhưng RSI tạo đáy cao hơn. Giảm giá: ngược lại ở đỉnh.
 * Chỉ tính khi điểm thứ hai nằm trong `recent` phiên cuối.
 * @returns {'bullish'|'bearish'|null}
 */
export function rsiDivergence(closes, rsiValues, { lookback = 45, recent = 8, w = 3 } = {}) {
  const n = closes.length;
  const from = n - lookback;
  const check = (findLows) => {
    const pts = swings(closes, w, findLows).filter((i) => i >= from && rsiValues[i] != null);
    if (pts.length < 2) return false;
    const [a, b] = pts.slice(-2);
    if (b < n - recent || b - a < 5) return false;
    return findLows
      ? closes[b] < closes[a] && rsiValues[b] > rsiValues[a] + 2
      : closes[b] > closes[a] && rsiValues[b] < rsiValues[a] - 2;
  };
  if (check(true)) return 'bullish';
  if (check(false)) return 'bearish';
  return null;
}
