import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityCheck, liquidityCheck } from '../src/screener.js';

const good = { epsTTM: 3000, roe: 0.2, profitGrowthTTM: 0.15, revenueGrowthTTM: 0.1, pe: 12, debtToEquity: 0.5 };

test('Cổ ngon: đạt đủ tiêu chí thì qua, thiếu một tiêu chí thì loại và nêu lý do', () => {
  const ok = qualityCheck(good, 'Công nghệ phần mềm');
  assert.equal(ok.pass, true);
  assert.ok(ok.score > 0 && ok.score <= 100);
  const lowRoe = qualityCheck({ ...good, roe: 0.08 }, '');
  assert.equal(lowRoe.pass, false);
  assert.match(lowRoe.failed[0], /ROE 8\.0% < 12%/);
  assert.equal(qualityCheck({ ...good, profitGrowthTTM: -0.1 }).pass, false);
  assert.equal(qualityCheck({ ...good, pe: 40 }).pass, false);
  assert.equal(qualityCheck({ ...good, epsTTM: -5 }).pass, false);
  assert.equal(qualityCheck(null).pass, false);
  assert.equal(qualityCheck({ ...good, roe: null }).pass, false); // thiếu dữ liệu = không xác minh được
});

test('Cổ ngon: nợ vay cao bị loại, trừ ngân hàng / chứng khoán / bảo hiểm', () => {
  assert.equal(qualityCheck({ ...good, debtToEquity: 2.5 }, 'Bất động sản').pass, false);
  assert.equal(qualityCheck({ ...good, debtToEquity: 2.5 }, 'Chứng khoán & Dịch vụ tài chính').pass, true);
  assert.equal(qualityCheck({ ...good, debtToEquity: null }, 'Ngân hàng').pass, true);
});

test('Thanh khoản đều: cần TB ≥ 5 tỷ và ≥ 16/20 phiên đạt 5 tỷ', () => {
  // giá 10 nghìn đồng, 1 triệu cp = 10 tỷ/phiên; 100 nghìn cp = 1 tỷ/phiên
  const bars = (big, small) => [...Array(big).fill({ close: 10, volume: 1_000_000 }), ...Array(small).fill({ close: 10, volume: 100_000 })];
  const steady = liquidityCheck(bars(20, 0), 5e9);
  assert.equal(steady.pass, true);
  assert.equal(steady.okDays, 20);
  // TB vẫn ≥ 5 tỷ (12×10 + 8×1 = 128 tỷ / 20 = 6,4 tỷ) nhưng chỉ 12/20 phiên đạt → không đều, loại
  const spiky = liquidityCheck(bars(12, 8), 5e9);
  assert.ok(spiky.avg >= 5e9);
  assert.equal(spiky.pass, false);
  assert.equal(liquidityCheck(bars(16, 4), 5e9).pass, true);
});
