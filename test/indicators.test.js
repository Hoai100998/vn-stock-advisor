import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollinger, atr, pctChange, stochastic, adx, mfi, obv, rsiDivergence } from '../src/indicators.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('SMA', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('EMA khởi tạo bằng SMA', () => {
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  close(e[2], 2);
  close(e[3], 3); // 4*0.5 + 2*0.5
  close(e[4], 4);
});

test('RSI: chỉ tăng = 100, chỉ giảm = 0', () => {
  const up = Array.from({ length: 30 }, (_, i) => 10 + i);
  const down = Array.from({ length: 30 }, (_, i) => 50 - i);
  assert.equal(rsi(up, 14).at(-1), 100);
  assert.equal(rsi(down, 14).at(-1), 0);
  assert.equal(rsi(up, 14)[13], null);
});

test('RSI khớp giá trị tham chiếu', () => {
  // Bộ dữ liệu kinh điển của Wilder (StockCharts): RSI(14) tại điểm thứ 15 ≈ 70.53
  const data = [44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433,
    46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820];
  close(rsi(data, 14)[14], 70.53, 0.05);
});

test('MACD: chuỗi tăng đều có MACD dương', () => {
  const v = Array.from({ length: 60 }, (_, i) => 100 + i);
  const m = macd(v);
  assert.ok(m.line.at(-1) > 0);
  assert.ok(m.signal.at(-1) != null);
  assert.equal(m.hist[30], null);
});

test('Bollinger với chuỗi hằng', () => {
  const b = bollinger(Array(25).fill(10), 20);
  assert.equal(b.upper.at(-1), 10);
  assert.equal(b.lower.at(-1), 10);
});

test('ATR', () => {
  const bars = Array.from({ length: 20 }, () => ({ high: 11, low: 9, close: 10 }));
  close(atr(bars, 14).at(-1), 2);
});

const trendBars = (n, step) => Array.from({ length: n }, (_, i) => {
  const c = 100 + i * step;
  return { open: c - step / 2, high: c + 1, low: c - 1, close: c, volume: 1000 };
});

test('Stochastic: giá đóng cửa tại đỉnh phạm vi cho %K gần 100', () => {
  const st = stochastic(trendBars(40, 1));
  assert.ok(st.k.at(-1) > 90);
  assert.ok(st.d.at(-1) > 90);
  assert.equal(st.k[10], null);
});

test('ADX: xu hướng tăng đều cho ADX cao và +DI > −DI', () => {
  const r = adx(trendBars(80, 1));
  assert.ok(r.adx.at(-1) > 25, `ADX = ${r.adx.at(-1)}`);
  assert.ok(r.plusDI.at(-1) > r.minusDI.at(-1));
  const d = adx(trendBars(80, -1));
  assert.ok(d.minusDI.at(-1) > d.plusDI.at(-1));
});

test('MFI: chỉ tăng = 100', () => {
  assert.equal(mfi(trendBars(30, 1)).at(-1), 100);
});

test('OBV cộng/trừ khối lượng theo chiều giá', () => {
  const bars = [10, 11, 10.5, 12].map((c) => ({ close: c, volume: 100 }));
  assert.deepEqual(obv(bars), [0, 100, 0, 100]);
});

test('Phân kỳ dương RSI', () => {
  // Giảm sâu tạo đáy 1, hồi lên, rồi giảm nhẹ tạo đáy 2 thấp hơn chút (RSI cao hơn)
  const closes = [];
  for (let i = 0; i < 20; i++) closes.push(100 - i * 2);   // 100 -> 62
  for (let i = 0; i < 10; i++) closes.push(62 + i * 1.5);  // hồi lên ~75.5
  for (let i = 0; i < 9; i++) closes.push(75 - i * 1.6);   // xuống ~62.2
  closes.push(61.5, 62.5, 63);                              // đáy 2 thấp hơn đáy 1 (62)
  assert.equal(rsiDivergence(closes, rsi(closes, 14)), 'bullish');
});

test('pctChange', () => {
  close(pctChange([100, 105, 110], 2), 10);
  assert.equal(pctChange([1], 5), null);
});
