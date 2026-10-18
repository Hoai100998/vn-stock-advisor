import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQuarters } from '../src/company.js';

// 8 quý: lợi nhuận năm sau cao hơn năm trước, quý gần nhất tăng mạnh hơn quý trước
const q = (date, revenue, profit, cfo = profit, equity = 1000) => ({ date, revenue, profit, cfo, equity, grossProfit: revenue * 0.3 });
const rows = [
  q('2024-09-30', 100, 10), q('2024-12-31', 100, 10), q('2025-03-31', 100, 10), q('2025-06-30', 100, 10),
  q('2025-09-30', 110, 11), q('2025-12-31', 115, 12), q('2026-03-31', 120, 12.5), q('2026-06-30', 130, 15),
];

test('KQKD theo quý: tăng trưởng so cùng kỳ, tăng tốc, chuỗi quý, ROE và báo cáo kế tiếp', () => {
  const e = analyzeQuarters(rows);
  assert.equal(e.latest, 'Q2/2026');
  assert.equal(e.profitYoY, 0.5);            // 15 so với 10
  assert.equal(e.accel, 0.25);                // 50% so với 25% của quý trước
  assert.equal(e.trend, 'TANG_TOC');
  assert.equal(e.growthStreak, 4);
  assert.equal(e.profitTTM, 50.5);
  assert.equal(e.profitTTMGrowth, 0.2625);    // 50,5 / 40 − 1
  assert.equal(e.cfoToProfit, 1);
  assert.equal(e.nextReport.quarter, 'Q3/2026');
  assert.equal(e.nextReport.dueBy, '2026-11-14'); // 30/9 + 45 ngày
});

test('KQKD theo quý: lợi nhuận giảm so cùng kỳ là suy giảm; năm trước lỗ thì không tính %', () => {
  const down = analyzeQuarters([...rows.slice(0, 7), q('2026-06-30', 130, 8)]);
  assert.equal(down.trend, 'SUY_GIAM');
  assert.equal(down.declineStreak, 1);
  const fromLoss = analyzeQuarters([q('2025-06-30', 100, -5), q('2026-06-30', 100, 5)]);
  assert.equal(fromLoss.profitYoY, null);
});
