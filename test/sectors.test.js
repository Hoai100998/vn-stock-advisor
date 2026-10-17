import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stockFlow, aggregateSectors } from '../src/sectors.js';

const day = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
// 25 phiên giá trị 10 tỷ/phiên, rồi phiên cuối 30 tỷ và tăng 2%
const days = Array.from({ length: 26 }, (_, i) => ({ date: day(i), value: i === 25 ? 30e9 : 10e9, pctChange: i % 2 ? 1 : -1 }));
days[25].pctChange = 2;

test('Dòng tiền ròng: cộng phiên tăng, trừ phiên giảm; so với TB 20 phiên trước', () => {
  const f1 = stockFlow(days, [{ netVal: 5e9 }, { netVal: -1e9 }], 1);
  assert.equal(f1.value, 30e9);
  assert.equal(f1.net, 30e9);
  assert.equal(f1.valueRatio, 3);
  assert.ok(Math.abs(f1.ret - 0.02) < 1e-12);
  assert.equal(f1.foreignNet, 5e9);
  const f5 = stockFlow(days, null, 5); // phiên 21..25: giảm(10) tăng(10) giảm(10) tăng(10) tăng(30)
  assert.equal(f5.net, 30e9 + 10e9 - 10e9 + 10e9 - 10e9);
  assert.equal(f5.foreignNet, null);
  assert.equal(stockFlow(days.slice(0, 10), null, 5), null); // không đủ dữ liệu
});

test('Gộp theo ngành, xếp theo dòng tiền ròng và tìm mã dẫn dắt', () => {
  const s = (symbol, industry, net, value = 100) => ({ symbol, industry, net, value, ret: net > 0 ? 0.01 : -0.01, valueRatio: 1, foreignNet: net / 2 });
  const out = aggregateSectors([s('VCB', 'Ngân hàng', 50), s('TCB', 'Ngân hàng', 30), s('VIC', 'Bất động sản', -80), s('VHM', 'Bất động sản', 10)]);
  assert.deepEqual(out.map((x) => x.name), ['Ngân hàng', 'Bất động sản']);
  assert.equal(out[0].net, 80);
  assert.deepEqual(out[0].topBought, ['VCB', 'TCB']);
  assert.deepEqual(out[1].topSold, ['VIC']);
  assert.equal(out[1].foreignNet, -35);
  assert.equal(out[0].share, 0.5);
});

test('Số phiên tùy chỉnh được giới hạn 1–60', async () => {
  const { normalizePeriod } = await import('../src/sectors.js');
  assert.equal(normalizePeriod(10), 10);
  assert.equal(normalizePeriod('7.6'), 8);
  assert.equal(normalizePeriod(999), 60);
  assert.equal(normalizePeriod(0), 1);
  assert.equal(normalizePeriod('abc'), 1);
});
