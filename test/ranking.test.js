import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRef, compositeScore, rankLabel, factorReader } from '../src/ranking.js';
import { scoreItem } from '../src/predictions.js';

const day = (i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);

test('Điểm tổng hợp: mã tốt nhất mọi yếu tố gần 100, biến động được tính ngược chiều', () => {
  const list = [
    { mom: 0.5, high: 0, atr: 0.01, adx: 40 },
    { mom: 0.1, high: -0.1, atr: 0.02, adx: 25 },
    { mom: -0.2, high: -0.4, atr: 0.04, adx: 10 },
  ];
  const ref = buildRef(list);
  const best = compositeScore(list[0], ref), worst = compositeScore(list[2], ref);
  assert.ok(best.score > 80, `best ${best.score}`);
  assert.ok(worst.score < 20, `worst ${worst.score}`);
  assert.ok(best.parts.atr > worst.parts.atr); // ATR thấp hơn → phân vị cao hơn
  assert.equal(compositeScore({ mom: null, high: null, atr: 0.01, adx: null }, ref), null);
});

test('Nhãn xếp hạng và lọc MA200', () => {
  assert.equal(rankLabel(80, true).direction, 1);
  assert.equal(rankLabel(80, false).code, 'WAIT');
  assert.equal(rankLabel(20, true).direction, -1);
  assert.equal(rankLabel(50, true).direction, 0);
});

test('Yếu tố chỉ dùng dữ liệu đến phiên đang xét', () => {
  const bars = Array.from({ length: 300 }, (_, i) => ({ time: day(i), open: 10 + i / 10, high: 10.2 + i / 10, low: 9.8 + i / 10, close: 10 + i / 10, volume: 1 }));
  const read = factorReader(bars);
  const f = read(260);
  assert.ok(Math.abs(f.mom - (bars[240].close / bars[10].close - 1)) < 1e-12);
  assert.equal(f.high, 0); // chuỗi tăng đều: luôn ở đỉnh
  assert.equal(f.aboveMa200, true);
  bars[299].close = 1; // thay đổi tương lai không ảnh hưởng quá khứ
  assert.deepEqual(factorReader(bars)(260), f);
  assert.equal(read(100), null);
});

test('Chấm dự đoán sau 5/10/20 phiên so với VN-Index', () => {
  const mk = (f) => Array.from({ length: 30 }, (_, i) => ({ time: day(i), close: f(i) }));
  const stock = mk((i) => 10 + i), index = mk(() => 100);
  const r = scoreItem({ date: day(0), direction: 1 }, stock, index);
  assert.equal(r[5].correct, true);
  assert.equal(r[20].beatIndex, true);
  const s = scoreItem({ date: day(0), direction: -1 }, stock, index);
  assert.equal(s[10].correct, false);
  assert.equal(scoreItem({ date: day(25), direction: 1 }, stock, index)[5], undefined); // chưa đủ phiên
});
