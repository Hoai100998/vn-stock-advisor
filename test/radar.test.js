import { test } from 'node:test';
import assert from 'node:assert/strict';
import { radarWindow, inBuyZone, radarCandidates, RADAR } from '../src/radar.js';

// Giờ VN = UTC + 7
const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`);

test('Radar chỉ chạy 9:30–14:30 ngày thường', () => {
  assert.equal(radarWindow(at('2026-10-21', '09:20')), false); // còn ATO / bản tin mở cửa
  assert.equal(radarWindow(at('2026-10-21', '09:30')), true);
  assert.equal(radarWindow(at('2026-10-21', '14:30')), true);
  assert.equal(radarWindow(at('2026-10-21', '14:35')), false); // ATC
  assert.equal(radarWindow(at('2026-10-24', '10:00')), false); // thứ 7
});

test('Vùng mua: cho lệch 0,5%, loại khi thủng cắt lỗ', () => {
  const L = { buyFrom: 20, buyTo: 21, stop: 19 };
  assert.equal(inBuyZone(20.5, L), true);
  assert.equal(inBuyZone(21.1, L), true); // trong 0,5% trên vùng
  assert.equal(inBuyZone(21.3, L), false); // đã chạy xa
  assert.equal(inBuyZone(19.95, L), true);
  assert.equal(inBuyZone(19, { buyFrom: 18.9, buyTo: 21, stop: 19 }), false); // chạm cắt lỗ
  assert.equal(inBuyZone(20, null), false);
});

test('Ứng viên: nhóm MUA, bỏ mã đang giữ / đã báo / vừa xem, điểm cao trước', () => {
  const rows = [
    { symbol: 'AAA', score: 80, pfRank: 2 },
    { symbol: 'BBB', score: 90, pfRank: 1 },
    { symbol: 'CCC', score: 75, pfRank: null }, // dưới MA200
    { symbol: 'DDD', score: 65, pfRank: 5 }, // điểm thấp
    { symbol: 'EEE', score: 72, pfRank: 3 },
    { symbol: 'FFF', score: 71, pfRank: 4 },
    { symbol: 'GGG', score: 85, pfRank: 6 },
  ];
  const now = 1_000_000_000;
  const got = radarCandidates(rows, {
    held: new Set(['GGG']), seen: new Set(['EEE']),
    checked: { AAA: now - 10 * 60_000, FFF: now - (RADAR.recheckMinutes + 1) * 60_000 }, now,
  });
  assert.deepEqual(got, ['BBB', 'FFF']); // AAA vừa xem 10 phút trước, FFF đã quá hạn xem lại
});
