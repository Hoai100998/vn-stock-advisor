import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDataQuality } from '../src/dataquality.js';
import { applyAiLabel, buildNewsPrompt, newsKey } from '../src/newsai.js';

const bar = (time, close, volume = 1000) => ({ time, open: close, high: close, low: close, close, volume });

test('Dữ liệu chuẩn: không có vấn đề', () => {
  const bars = [bar('2026-10-19', 20), bar('2026-10-20', 20.5), bar('2026-10-21', 21)];
  const q = checkDataQuality(bars, { indexDate: '2026-10-21', fundReportDate: '2026-09-30', now: new Date('2026-10-21') });
  assert.equal(q.ok, true);
  assert.equal(q.critical, false);
});

test('Giá chưa cập nhật phiên mới nhất hoặc chưa khớp lệnh: lỗi nghiêm trọng', () => {
  const stale = checkDataQuality([bar('2026-10-19', 20), bar('2026-10-20', 20)], { indexDate: '2026-10-21' });
  assert.equal(stale.critical, true);
  assert.ok(stale.issues.some((x) => x.code === 'stale'));
  const noVol = checkDataQuality([bar('2026-10-20', 20), bar('2026-10-21', 20, 0)], { indexDate: '2026-10-21' });
  assert.ok(noVol.issues.some((x) => x.code === 'no_volume' && x.level === 'critical'));
});

test('Nhảy giá vượt biên độ sàn và số liệu cơ bản cũ: cảnh báo, không chặn', () => {
  const bars = [bar('2026-10-20', 20), bar('2026-10-21', 10)]; // −50%: chia tách chưa điều chỉnh
  const q = checkDataQuality(bars, { indexDate: '2026-10-21', exchange: 'HOSE', fundReportDate: '2025-12-31', now: new Date('2026-10-21') });
  assert.equal(q.critical, false);
  assert.deepEqual(q.issues.map((x) => x.code).sort(), ['jump', 'old_fund']);
  // +6,9% trên HOSE là trong biên độ
  assert.equal(checkDataQuality([bar('2026-10-20', 20), bar('2026-10-21', 21.38)], { exchange: 'HOSE' }).ok, true);
  // +12% hợp lệ với UPCOM (±15%)
  assert.equal(checkDataQuality([bar('2026-10-20', 20), bar('2026-10-21', 22.4)], { exchange: 'UPCOM' }).ok, true);
});

test('AI lọc tin: đổi nhãn, giữ độ mạnh khi cùng chiều, rủi ro chỉ khi liên quan', () => {
  const it = { title: 'X', link: 'L', label: 'tieu_cuc', sentiment: -0.6, keywords: ['điều tra'] };
  const same = applyAiLabel(it, { relevant: true, label: 'TIEU_CUC', risk: true, reason: 'r' });
  assert.equal(same.sentiment, -0.6);
  assert.equal(same.ai.risk, true);
  const flip = applyAiLabel(it, { relevant: true, label: 'TICH_CUC', risk: false, reason: 'r' });
  assert.equal(flip.label, 'tich_cuc');
  assert.equal(flip.sentiment, 0.4);
  const neutral = applyAiLabel(it, { relevant: true, label: 'TRUNG_LAP', risk: false, reason: 'r' });
  assert.equal(neutral.sentiment, 0);
  const off = applyAiLabel(it, { relevant: false, label: 'TIEU_CUC', risk: true, reason: 'nói về mã khác' });
  assert.equal(off.ai.relevant, false);
  assert.equal(off.ai.risk, false);
  assert.equal(applyAiLabel(it, undefined).ai, null); // AI chưa đọc: giữ nhãn từ khóa
});

test('Prompt lọc tin đánh số từng tin; khóa lưu theo cả mã', () => {
  const p = buildNewsPrompt([{ title: 'A' }, { title: 'B', summary: 'tóm tắt' }], { symbol: 'FPT', companyName: 'Công ty FPT' });
  assert.match(p, /\[0\] A/);
  assert.match(p, /\[1\] B — tóm tắt/);
  assert.notEqual(newsKey({ link: 'u' }, 'FPT'), newsKey({ link: 'u' }, 'HPG'));
});
