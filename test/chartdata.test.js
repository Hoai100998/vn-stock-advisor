import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateBars } from '../src/chartdata.js';

const bar = (time, open, high, low, close, volume = 100) => ({ time, open, high, low, close, volume });
// Thứ Năm 1/10/2026 → thứ Ba 13/10/2026 (thứ Hai 5/10 và 12/10 là đầu tuần)
const daily = [
  bar('2026-10-01', 10, 11, 9.5, 10.5), bar('2026-10-02', 10.5, 12, 10, 11.5),
  bar('2026-10-05', 11.5, 11.8, 11, 11.2), bar('2026-10-09', 11.2, 13, 11.1, 12.8),
  bar('2026-10-12', 12.8, 12.9, 12, 12.1), bar('2026-10-13', 12.1, 12.5, 11.9, 12.4),
];

test('Gộp nến tuần: mở = phiên đầu, đóng = phiên cuối, cao/thấp/khối lượng của cả tuần', () => {
  const w = aggregateBars(daily, 'W');
  assert.equal(w.length, 3);
  assert.deepEqual(w[0], bar('2026-10-01', 10, 12, 9.5, 11.5, 200));
  assert.deepEqual(w[1], bar('2026-10-05', 11.5, 13, 11, 12.8, 200));
  assert.equal(w[2].time, '2026-10-12');
});

test('Gộp nến tháng và giữ nguyên nến ngày', () => {
  const m = aggregateBars([bar('2026-09-30', 9, 10, 8, 9.5), ...daily], 'M');
  assert.equal(m.length, 2);
  assert.deepEqual(m[1], bar('2026-10-01', 10, 13, 9.5, 12.4, 600));
  assert.equal(aggregateBars(daily, 'D'), daily);
});
