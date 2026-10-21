import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasDiacritics, sanitizeForecast } from '../src/ai.js';

test('Nhận ra tiếng Việt không dấu để yêu cầu AI viết lại', () => {
  assert.equal(hasDiacritics('DHC co nen tang co ban xuat sac voi Q2/2026 tang truong 114%, dinh gia re voi P/E 7.15'), false);
  assert.equal(hasDiacritics('DHC có nền tảng cơ bản xuất sắc với Q2/2026 tăng trưởng 114%, định giá rẻ với P/E 7,15'), true);
  assert.equal(hasDiacritics('Ngắn'), true); // quá ngắn: không kết luận
});

test('Kịch bản tăng/giảm quá sát giá bị nới ra ít nhất đến mức 75% / 25% của dải thống kê', () => {
  // FPT 16/10: Gemini đặt kịch bản tăng 5 phiên chỉ +0,5%
  const f = { scenarios: [
    { name: 'TANG', probability: 30, p5: 58.5, p10: 60, p20: 62 },
    { name: 'CO_SO', probability: 45, p5: 58, p10: 58.3, p20: 58.6 },
    { name: 'GIAM', probability: 25, p5: 57.5, p10: 53.5, p20: 51.5 },
  ] };
  const cone = [
    { h: 5, p05: 54.6, p25: 56.9, p75: 59.5, p95: 62.3 },
    { h: 10, p05: 52.8, p25: 56.4, p75: 60, p95: 64 },
    { h: 20, p05: 50.5, p25: 55.8, p75: 61.3, p95: 65.8 },
  ];
  const r = sanitizeForecast(f, 58.2, cone);
  const [up, base, down] = r.scenarios;
  assert.equal(up.p5, 59.5); // nới lên mức 75%
  assert.equal(up.p20, 62); // đã rộng hơn thì giữ nguyên
  assert.equal(down.p5, 56.9); // nới xuống mức 25%
  assert.equal(down.p10, 53.5);
  assert.equal(base.p5, 58);
  assert.deepEqual(sanitizeForecast(f, 58.2).scenarios[0].p5, 58.5); // không có dải thì không đổi
});
