import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tickSize, roundDown, roundUp, priceLimits, simulate, calcMetrics, maxDrawdown, bootstrapTrades, walkForward, STRATEGIES,
} from '../src/backtest.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const day = (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
const flat = (n, price = 20) => Array.from({ length: n }, (_, i) => ({ time: day(i), open: price, high: price, low: price, close: price, volume: 1e6 }));
const cfg = { initialCash: 100_000_000, slippage: 0, exchange: 'HOSE' };

test('Bước giá HOSE và HNX', () => {
  assert.equal(tickSize(9.99), 0.01);
  assert.equal(tickSize(10), 0.05);
  assert.equal(tickSize(49.95), 0.05);
  assert.equal(tickSize(50), 0.1);
  assert.equal(tickSize(5, 'HNX'), 0.1);
  assert.equal(roundDown(21.43), 21.4);
  assert.equal(roundUp(21.41), 21.45);
  assert.equal(roundUp(21.4), 21.4);
});

test('Giá trần/sàn nằm trong biên độ và trên lưới bước giá', () => {
  const { ceiling, floor } = priceLimits(20, 0.07, 'HOSE');
  assert.equal(ceiling, 21.4);
  assert.equal(floor, 18.6);
  const b = priceLimits(23.15, 0.07, 'HOSE'); // 24.7705 → 24.75, 21.5295 → 21.55
  assert.equal(b.ceiling, 24.75);
  assert.equal(b.floor, 21.55);
});

test('Khớp ở giá mở cửa phiên sau, lô 100, phí mua và phí + thuế bán', () => {
  const bars = flat(10);
  const target = bars.map((_, i) => (i >= 1 && i < 5 ? 1 : 0));
  const r = simulate(bars, target, cfg);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.entryTime, day(2)); // tín hiệu phiên 1 → mua phiên 2
  assert.equal(t.exitTime, day(6));  // tín hiệu tắt ở phiên 5 → bán phiên 6
  assert.equal(t.shares % 100, 0);
  const gross = t.shares * 20 * 1000;
  close(t.pnl, Math.round(-gross * 0.0015 - gross * 0.0025), 1);
  close(r.equity.at(-1).value, 100_000_000 + t.pnl, 1);
});

test('T+2: không bán được trước phiên thứ 2 sau khi mua', () => {
  const bars = flat(10);
  const target = bars.map((_, i) => (i === 1 ? 1 : 0)); // muốn bán ngay phiên sau khi mua
  const r = simulate(bars, target, cfg);
  assert.equal(r.blocked.settlement, 1);
  assert.equal(r.trades[0].entryTime, day(2));
  assert.equal(r.trades[0].exitTime, day(4));
  assert.equal(r.trades[0].bars, 2);
});

test('Mở cửa giá trần thì không mua được, giá sàn thì không bán được', () => {
  const bars = flat(8);
  bars[2] = { ...bars[2], open: 21.4, high: 21.4, low: 21.4, close: 21.4 }; // trần so với 20
  for (let i = 3; i < 8; i++) bars[i] = { ...bars[i], open: 21.4, high: 21.4, low: 21.4, close: 21.4 };
  const r = simulate(bars, bars.map((_, i) => (i >= 1 ? 1 : 0)), cfg);
  assert.equal(r.blocked.ceiling, 1);
  assert.equal(r.trades.length, 0);
  assert.ok(r.openPosition);
  assert.equal(r.openPosition.entryTime, day(3));

  const down = flat(10);
  for (let i = 5; i < 10; i++) {
    const ref = down[i - 1].close;
    const f = priceLimits(ref, 0.07, 'HOSE').floor;
    down[i] = { ...down[i], open: f, high: f, low: f, close: f };
  }
  const r2 = simulate(down, down.map((_, i) => (i >= 1 && i < 5 ? 1 : 0)), cfg);
  assert.ok(r2.blocked.floor >= 1);
  assert.equal(r2.trades.length, 0); // chuỗi giảm sàn liên tiếp: kẹt hàng
});

test('Cắt lỗ theo % thoát ở phiên sau khi giá đóng cửa chạm ngưỡng', () => {
  const bars = flat(12);
  for (let i = 5; i < 12; i++) bars[i] = { ...bars[i], open: 18.8, high: 18.8, low: 18.8, close: 18.8 };
  const r = simulate(bars, bars.map(() => 1), { ...cfg, stopLossPct: 0.05 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].reason, 'stop');
  assert.equal(r.trades[0].exitTime, day(6));
});

test('Sụt giảm tối đa tính từ vốn ban đầu', () => {
  close(maxDrawdown([90, 120, 60, 100], 100), -0.5);
  close(maxDrawdown([80], 100), -0.2);
});

test('calcMetrics: lợi nhuận, beta = 1 khi đi cùng chỉ số', () => {
  const values = [100, 110, 99, 120, 132];
  const m = calcMetrics(values, [], 100, values);
  close(m.totalReturn, 0.32);
  close(m.beta, 1, 1e-9);
  close(m.excessReturn, 0.32 - 0.32);
});

test('Bootstrap và walk-forward', () => {
  const trades = [5, -2, 3, 4, -1, 6].map((r, i) => ({ returnPct: r, pnl: r, entryTime: day(i * 10) }));
  const b = bootstrapTrades(trades, { n: 500 });
  assert.ok(b.probProfit > 0.8);
  assert.ok(b.returnP5 <= b.returnP50 && b.returnP50 <= b.returnP95);
  assert.ok(bootstrapTrades(trades.slice(0, 3)).error);
  const eq = Array.from({ length: 100 }, (_, i) => ({ time: day(i), value: 100 + i }));
  const w = walkForward(eq, trades, 4);
  assert.equal(w.windows.length, 4);
  assert.equal(w.profitable, 4);
});

test('Chiến lược chỉ dùng dữ liệu quá khứ (Donchian)', () => {
  const bars = flat(30);
  bars[25] = { ...bars[25], close: 22, high: 22 };
  const t = STRATEGIES.breakout.signals(bars, { entry: 20, exit: 10 });
  assert.equal(t[24], 0);
  assert.equal(t[25], 1);
});
