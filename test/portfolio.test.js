import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPositions, pendingQty, behavior } from '../src/portfolio.js';
import { historicalVar, historicalCvar, correlation } from '../src/risk.js';

const fees = { brokerage: 0.0015, sellTax: 0.001 };
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Giá vốn bình quân gồm phí mua, lãi chốt trừ phí bán và thuế', () => {
  const { positions, closed } = buildPositions([
    { seq: 1, type: 'BUY', symbol: 'FPT', qty: 1000, price: 100, date: '2026-01-02' },
    { seq: 2, type: 'BUY', symbol: 'FPT', qty: 1000, price: 90, date: '2026-02-02' },
    { seq: 3, type: 'SELL', symbol: 'FPT', qty: 500, price: 110, date: '2026-03-02' },
  ], fees);
  const p = positions[0];
  assert.equal(p.qty, 1500);
  const avg = (190_000_000 * 1.0015) / 2000;
  close(p.cost, avg * 1500, 1e-3);
  close(closed[0].pnl, Math.round(500 * 110_000 * 0.9975 - avg * 500), 1);
  assert.equal(closed[0].holdDays, 59);
});

test('Bán hết thì vị thế về 0, lô bán trừ vào lô cũ nhất', () => {
  const { positions } = buildPositions([
    { seq: 1, type: 'BUY', symbol: 'HPG', qty: 300, price: 20, date: '2026-01-02' },
    { seq: 2, type: 'BUY', symbol: 'HPG', qty: 200, price: 21, date: '2026-01-05' },
    { seq: 3, type: 'SELL', symbol: 'HPG', qty: 400, price: 22, date: '2026-01-10' },
  ], fees);
  assert.equal(positions[0].qty, 100);
  assert.deepEqual(positions[0].lots, [{ date: '2026-01-05', qty: 100 }]);
});

test('T+2: lô mua chưa đủ 2 phiên chưa bán được', () => {
  const sessions = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
  assert.equal(pendingQty([{ date: '2026-10-15', qty: 500 }], sessions), 500); // mới qua 1 phiên
  assert.equal(pendingQty([{ date: '2026-10-14', qty: 500 }], sessions), 0);   // đã qua 2 phiên
});

test('Chẩn đoán gồng lỗ', () => {
  const b = behavior([
    { symbol: 'A', pnl: 100, returnPct: 3, holdDays: 5 },
    { symbol: 'B', pnl: 120, returnPct: 4, holdDays: 6 },
    { symbol: 'C', pnl: -300, returnPct: -12, holdDays: 30 },
    { symbol: 'D', pnl: -200, returnPct: -8, holdDays: 25 },
  ]);
  assert.equal(b.winRate, 0.5);
  assert.ok(b.insights.some((i) => i.text.startsWith('Gồng lỗ')));
  assert.ok(b.insights.some((i) => i.text.includes('lỗ trên 10%')));
});

test('VaR, CVaR và tương quan', () => {
  const r = Array.from({ length: 100 }, (_, i) => (i - 50) / 1000); // -5% … +4.9%
  close(historicalVar(r, 0.95), 0.045);
  close(historicalCvar(r, 0.95), 0.048);
  close(correlation(r, r.map((x) => 2 * x + 1)), 1, 1e-9);
  close(correlation(r, r.map((x) => -x)), -1, 1e-9);
});
