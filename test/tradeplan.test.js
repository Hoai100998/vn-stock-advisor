import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceLevels, tradeSteps, splitShares, tick } from '../src/tradeplan.js';

const day = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
// Chuỗi dao động quanh xu hướng tăng: có đỉnh/đáy rõ
const bars = Array.from({ length: 150 }, (_, i) => {
  const c = 20 + i * 0.03 + Math.sin(i / 5) * 0.8;
  return { time: day(i), open: c, high: c + 0.3, low: c - 0.3, close: c, volume: 1e6 };
});

test('Bậc thang giá: cắt lỗ < hỗ trợ 2 < hỗ trợ 1 < giá < kháng cự 1 < kháng cự 2, đúng bước giá', () => {
  const L = priceLevels(bars, { atr: 0.5, ma20: 24, ma50: 23.5, ma200: null });
  assert.ok(L.stop < (L.s2 ?? L.s1) && (L.s2 ?? 0) < L.s1 && L.s1 < L.close && L.close < L.r1 && L.r1 < L.r2, JSON.stringify(L));
  assert.ok(L.stop >= L.close * 0.9 - 0.05, 'rủi ro không quá 10%');
  for (const k of ['r2', 'r1', 's1', 'stop']) {
    const t = tick(L[k]);
    assert.ok(Math.abs(L[k] / t - Math.round(L[k] / t)) < 1e-6, `${k}=${L[k]} không đúng bước giá ${t}`);
  }
});

test('Chia cổ phiếu: lô 100 khi ≥ 300 cp, dư dồn vào bước cuối', () => {
  assert.deepEqual(splitShares(1000, [1 / 3, 1 / 3, 1 / 3]), [300, 300, 400]);
  assert.deepEqual(splitShares(20, [0.5, 0.5]), [10, 10]);
});

const L = { r2: 22.2, r1: 21.2, close: 20.9, s1: 20.75, s2: 20.1, stop: 19.85, atr: 0.42 };

test('NÊN MUA, chưa có: 3 lần mua (hỗ trợ gần, hỗ trợ 2, bứt phá) tổng đúng tỷ trọng + cắt lỗ', () => {
  const { fresh } = tradeSteps('BUY', L, { weight: 0.2, rsi: 55, avgVol20: 1e6 });
  const buys = fresh.filter((x) => x.side === 'buy');
  assert.equal(buys.length, 3);
  assert.ok(Math.abs(buys.reduce((t, x) => t + x.portion, 0) - 0.2) < 1e-9);
  assert.match(buys[2].condition, /21,2 với khối lượng > 1\.500\.000 cp/);
  assert.equal(fresh.at(-1).side, 'stop');
  // RSI nóng: lần 1 chờ giá lùi về hỗ trợ, không mua quanh giá hiện tại
  assert.ok(tradeSteps('BUY', L, { weight: 0.2, rsi: 78 }).fresh[0].zone[1] < L.close);
});

test('Đang nắm giữ: số cp mỗi bước bán theo vị thế thật, giảm (không phải chốt lời) khi dưới giá vốn', () => {
  const { hold } = tradeSteps('HOLD', L, { holding: { qty: 3000, avgCost: 23, pnlPct: -0.09 } });
  const sells = hold.filter((x) => x.side === 'sell');
  assert.deepEqual(sells.map((x) => x.shares), [1000, 1000]);
  assert.ok(sells.every((x) => /^Giảm/.test(x.condition)));
  assert.ok(hold.some((x) => x.side === 'wait' && x.shares === 1000));
  assert.equal(hold.find((x) => x.side === 'stop').shares, 3000);
  const t2 = tradeSteps('AVOID', { ...L, close: 19.5 }, { holding: { qty: 500, avgCost: 21 } });
  assert.match(t2.hold[0].condition, /thủng cắt lỗ/);
});
