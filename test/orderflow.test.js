import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeTicks, readSession, buildFlow } from '../src/orderflow.js';

test('Lệnh khớp: tách mua / bán chủ động, ATO-ATC và lệnh lớn (≥ 500 triệu)', () => {
  const s = summarizeTicks([
    { side: 'ATO', lastVol: 1000, last: 50 },
    { side: 'PB', lastVol: 20000, last: 50 }, // 1 tỷ → lệnh lớn
    { side: 'PB', lastVol: 1000, last: 50 },
    { side: 'PS', lastVol: 3000, last: 50 },
    { side: 'ATC', lastVol: 500, last: 50 },
  ]);
  assert.equal(s.buy, 21000);
  assert.equal(s.sell, 3000);
  assert.equal(s.auction, 1500);
  assert.equal(s.bigBuy, 20000);
  assert.equal(s.bigSell, 0);
  assert.equal(s.buyRatio, 0.875);
});

test('Đọc phiên: tăng KL lớn đóng cửa gần đỉnh = gom; giảm KL lớn đóng cửa gần đáy = xả', () => {
  assert.equal(readSession({ chg: 3, volRatio: 1.8, clv: 0.8, value: 1e11 }).read, 'GOM');
  assert.equal(readSession({ chg: -3, volRatio: 1.8, clv: -0.8, value: 1e11 }).read, 'XA');
  assert.equal(readSession({ chg: 0.2, volRatio: 0.9, clv: 0, value: 1e11 }).read, 'TRUNG_TINH');
  // khối ngoại + tự doanh bán ròng mạnh và bán chủ động áp đảo
  const x = readSession({ chg: -0.3, volRatio: 1, clv: -0.1, value: 1e11, foreignNet: -8e9, propNet: 0, active: { buyRatio: 0.4, bigBuyRatio: 0.3, bigBuy: 1, bigSell: 3 } });
  assert.equal(x.read, 'XA');
  assert.ok(x.why.some((w) => /bán ròng/.test(w)));
});

test('Bảng 10 phiên: giai đoạn tăng với KL lớn và đóng cửa cao được gợi ý GOM', () => {
  const bars = [];
  for (let i = 0; i < 40; i++) {
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    const up = i >= 30;
    const close = up ? 10 + (i - 29) * 0.3 : 10;
    bars.push({ time: day, open: close - (up ? 0.25 : 0), high: close + 0.02, low: close - (up ? 0.3 : 0.1), close, volume: up ? 2_000_000 : 1_000_000 });
  }
  const f = buildFlow(bars, { foreign: [{ date: bars.at(-1).time, netVal: 5e9 }] });
  assert.equal(f.n, 10);
  assert.equal(f.phase, 'GOM');
  assert.ok(f.upDownVolRatio == null || f.upDownVolRatio > 1);
  assert.equal(f.sessions.at(-1).foreignNet, 5e9);
});
