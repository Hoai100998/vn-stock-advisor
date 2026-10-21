import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreTrade, tradeStats, proposeChanges, RULES } from '../src/selfreview.js';
import { priceLevels } from '../src/tradeplan.js';

// Chuỗi giá: phiên 0 là ngày gợi ý, các phiên sau theo danh sách [open, high, low, close]
const mk = (rows, start = Date.UTC(2026, 9, 1)) => rows.map(([open, high, low, close], i) => ({
  time: new Date(start + i * 86400_000).toISOString().slice(0, 10), open, high, low, close, volume: 1,
}));
const flat = (n, p = 10) => Array.from({ length: n }, () => [p, p, p, p]);

test('Chấm lệnh: chạm cắt lỗ trước, chạm chốt lời, hết 20 phiên, chưa đủ phiên', () => {
  const t = { date: '2026-10-01', entry: 10, stop: 9.5, target: 11 };
  const stop = scoreTrade(t, mk([[10, 10, 10, 10], [10, 10.2, 9.4, 9.6], ...flat(25)]));
  assert.equal(stop.outcome, 'stop');
  assert.equal(stop.days, 1);
  assert.equal(stop.ret, 9.5 / 10 - 1);
  assert.equal(stop.ret20, 0); // giá hồi về 10 sau đó
  // Mở cửa đã dưới cắt lỗ: bán giá mở cửa
  assert.equal(scoreTrade(t, mk([[10, 10, 10, 10], [9, 9.2, 8.9, 9], ...flat(25)])).ret, 9 / 10 - 1);
  // Cùng phiên chạm cả hai: tính cắt lỗ (thận trọng)
  assert.equal(scoreTrade(t, mk([[10, 10, 10, 10], [10, 11.5, 9.4, 11], ...flat(25)])).outcome, 'stop');
  const tgt = scoreTrade(t, mk([[10, 10, 10, 10], ...flat(3), [10.5, 11.2, 10.4, 11], ...flat(25)]));
  assert.equal(tgt.outcome, 'target');
  assert.equal(tgt.ret, 11 / 10 - 1);
  assert.equal(scoreTrade(t, mk([[10, 10, 10, 10], ...flat(25, 10.3)])).outcome, 'time');
  const pending = scoreTrade(t, mk([[10, 10, 10, 10], ...flat(5, 10.3)]));
  assert.equal(pending.matured, false);
});

const stats = (over) => ({ n: 40, winRate: 0.5, avgRet: 0, stopRate: 0.3, stop5Rate: 0.2, targetRate: 0.3, shakeN: 12, shakeAvgRet20: -0.02, ...over });
const ex = (n, e) => ({ n, avgRet10: e, avgExcess10: e });
const T = { widen: 1.12, minStopAtr: 0, aiVeto: true, caution: false };
const none = { picks: stats(), picks10: ex(40, 0.005), rejected10: ex(40, 0), band: { n: 60, coverage90: 0.9 } };

test('Tự chỉnh: không đổi gì khi chỉ số trong ngưỡng hoặc chưa đủ mẫu', () => {
  assert.deepEqual(proposeChanges(none, T), []);
  const few = { picks: stats({ n: RULES.minSample - 1, stop5Rate: 0.8, shakeAvgRet20: 0.05 }), picks10: ex(5, -0.05), rejected10: ex(5, 0.05), band: { n: 10, coverage90: 0.5 } };
  assert.deepEqual(proposeChanges(few, T), []);
});

test('Tự chỉnh: nới cắt lỗ chỉ khi bị quét sớm rồi giá hồi lại', () => {
  const shaken = proposeChanges({ ...none, picks: stats({ stop5Rate: 0.5, shakeAvgRet20: 0.03 }) }, T);
  assert.deepEqual(shaken.map((c) => [c.name, c.value]), [['minStopAtr', 0.25]]);
  // Bị cắt lỗ sớm nhưng giá tiếp tục giảm: cắt lỗ đúng, không nới
  assert.deepEqual(proposeChanges({ ...none, picks: stats({ stop5Rate: 0.5, shakeAvgRet20: -0.04 }) }, T), []);
});

test('Tự chỉnh: dải giá, quyền loại mã của AI, chế độ thận trọng', () => {
  assert.equal(proposeChanges({ ...none, band: { n: 60, coverage90: 0.8 } }, T)[0].value, 1.12 * 1.04);
  const veto = proposeChanges({ ...none, picks10: ex(40, 0), rejected10: ex(40, 0.02) }, T);
  assert.deepEqual(veto.map((c) => [c.name, c.value]), [['aiVeto', false]]);
  const caution = proposeChanges({ ...none, picks10: ex(40, -0.02), rejected10: ex(40, -0.025) }, T);
  assert.deepEqual(caution.map((c) => [c.name, c.value]), [['caution', true]]);
  assert.deepEqual(proposeChanges({ ...none, picks10: ex(40, 0.01) }, { ...T, caution: true }).map((c) => c.name), ['caution']);
});

test('Thống kê lệnh: tỷ lệ cắt lỗ sớm và lợi suất sau khi bị quét', () => {
  const s = tradeStats([
    { s: { matured: true, outcome: 'stop', days: 2, ret: -0.05, ret20: 0.04 } },
    { s: { matured: true, outcome: 'target', days: 8, ret: 0.08, ret20: 0.1 } },
    { s: { matured: false } },
  ]);
  assert.equal(s.n, 2);
  assert.equal(s.stop5Rate, 0.5);
  assert.equal(s.shakeAvgRet20, 0.04);
});

test('Cắt lỗ tối thiểu theo ATR: đẩy cắt lỗ xa hơn nhưng không quá 10%', () => {
  const bars = mk([...flat(60, 50), ...Array.from({ length: 10 }, (_, i) => [50 + i * 0.1, 50.5 + i * 0.1, 49.9 + i * 0.1, 50.2 + i * 0.1])]);
  const base = priceLevels(bars, { atr: 1, ma20: null, ma50: null, ma200: null });
  const wide = priceLevels(bars, { atr: 1, ma20: null, ma50: null, ma200: null, minStopAtr: 2 });
  const close = bars.at(-1).close;
  assert.ok(wide.stop <= close - 2 + 1e-9, `cắt lỗ ${wide.stop}`);
  assert.ok(wide.stop <= base.stop);
  assert.ok(priceLevels(bars, { atr: 3, ma20: null, ma50: null, ma200: null, minStopAtr: 2 }).stop >= close * 0.9 - 0.05);
});
