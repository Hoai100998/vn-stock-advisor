import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intradayWindow } from '../src/intraday.js';
import { suggest, formatDiagnosis } from '../src/diagnose.js';

const at = (date, hhmm) => new Date(`${date}T${hhmm}:00+07:00`);

test('Khung thu thập trong phiên: bỏ ATO, nghỉ trưa, ATC và cuối tuần', () => {
  const d = '2026-10-22';
  assert.equal(intradayWindow(at(d, '09:10')), false);
  assert.equal(intradayWindow(at(d, '09:15')), true);
  assert.equal(intradayWindow(at(d, '12:00')), false);
  assert.equal(intradayWindow(at(d, '13:30')), true);
  assert.equal(intradayWindow(at(d, '14:50')), false);
  assert.equal(intradayWindow(at('2026-10-24', '10:00')), false);
});

test('Chưa đủ mẫu: không đề xuất gì', () => {
  assert.deepEqual(suggest({
    accuracy: [{ source: 'rank_all', horizon: 10, evaluated: 30, beat_index_rate: 0.2 }],
    fill: { n: 5, fill_rate: 0.1 }, hours: [{ hour: 10, n: 100, to_close: 0.01 }],
    news: [{ label: 'TICH_CUC', n: 10, avg_excess: 0.01 }, { label: 'TIEU_CUC', n: 10, avg_excess: -0.01 }],
  }), []);
});

test('Đủ mẫu: đề xuất theo từng vùng', () => {
  const s = suggest({
    accuracy: [
      { source: 'ai', horizon: 10, evaluated: 150, beat_index_rate: 0.4 },
      { source: 'rank_all', horizon: 10, evaluated: 2000, beat_index_rate: 0.58 },
      { source: 'rule', horizon: 10, evaluated: 300, beat_index_rate: 0.5 }, // trong ngưỡng: không nói
    ],
    fill: { n: 40, fill_rate: 0.3 },
    hours: [{ hour: 9, n: 1000, to_close: -0.002 }, { hour: 10, n: 1000, to_close: 0.003 }, { hour: 13, n: 1000, to_close: 0.001 }],
    news: [{ label: 'TICH_CUC', n: 80, avg_excess: 0.004 }, { label: 'TIEU_CUC', n: 60, avg_excess: -0.003 }],
  });
  assert.deepEqual(s.map((x) => x.area), ['source', 'source', 'zone', 'timing', 'news']);
  assert.match(s[0].text, /"ai".*40%/);
  assert.match(s[3].text, /10h/);
  assert.match(s[4].text, /có giá trị/);
});

test('Tin Telegram chẩn đoán khi chưa có dữ liệu', () => {
  const t = formatDiagnosis({ date: '2026-10-22', accuracy: [], fill: { n: 0 }, hours: [], news: [], suggestions: [] });
  assert.match(t, /CHẨN ĐOÁN DỰ ĐOÁN 22\/10/);
  assert.match(t, /Chưa có dự đoán nào đủ 10 phiên/);
  assert.match(t, /Chưa đủ mẫu/);
});
