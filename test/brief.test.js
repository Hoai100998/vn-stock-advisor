import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, positionSize } from '../src/brief.js';

const base = (over = {}) => ({
  symbol: 'AAA', total: 10, price: { close: 20, changePct: 1, date: '2026-10-16' },
  recommendation: { code: 'BUY', label: 'NÊN MUA' },
  ranking: { score: 80, position: 2, universe: 100, aboveMa200: true, factors: { mom: 0.3, high: -0.05 } },
  technical: { indicators: { sma200: 18, rsi14: 60 } },
  fundamental: { data: { pe: 10, roe: 0.2, profitGrowthTTM: 0.15, epsTTM: 2000 } },
  foreign: { net20: 50e9, ratio20: 4 },
  news: { count: 5, score: 30, positive: 4, negative: 1 },
  plan: { support: 18.5, stopLoss: 19.2, target: 22, riskReward: 2 },
  warnings: [],
  ...over,
});

test('Tỷ trọng theo rủi ro 1% vốn, tối đa 25%', () => {
  assert.equal(positionSize(20, 19).weight, 0.2); // cắt lỗ cách 5% → 20% vốn
  assert.equal(positionSize(20, 19.8).weight, 0.25); // cắt lỗ quá gần → chặn ở 25%
  assert.equal(positionSize(20, 21), null);
});

test('Tóm tắt: kết luận, việc nên làm, lý do có số liệu, vùng mua nằm trên cắt lỗ', () => {
  const b = buildBrief(base(), { name: 'Ngân hàng', net: 8e12, rank: 1, total: 27, period: 5 });
  assert.equal(b.verdict, 'NÊN MUA');
  assert.match(b.action, /tối đa 25% vốn; cắt lỗ nếu đóng cửa dưới 19,2/);
  assert.ok(b.reasons.length >= 4 && b.reasons.length <= 6);
  assert.ok(b.reasons.some((r) => /Ngân hàng được mua ròng 8\.000 tỷ\/5 phiên \(top hút tiền\)/.test(r.text)));
  assert.ok(b.reasons.some((r) => /Khối ngoại mua ròng 50 tỷ/.test(r.text)));
  assert.ok(b.levels.buyFrom > b.levels.stop, `${b.levels.buyFrom} > ${b.levels.stop}`);
});

test('Tóm tắt: doanh nghiệp lỗ và dưới MA200 hiện là lý do tiêu cực', () => {
  const b = buildBrief(base({
    recommendation: { code: 'AVOID', label: 'CHƯA NÊN MUA' },
    ranking: { score: 75, position: 5, universe: 100, aboveMa200: false, factors: { mom: 0.1, high: -0.2 } },
    fundamental: { data: { epsTTM: -500 } },
  }));
  assert.match(b.action, /Không mua mới/);
  assert.equal(b.tone, 'down');
  assert.ok(b.reasons.some((r) => r.tone === 'down' && /dưới MA200/.test(r.text)));
  assert.ok(b.reasons.some((r) => r.tone === 'down' && /đang lỗ/.test(r.text)));
});

test('Hướng dẫn 2 trường hợp: chưa có / đang nắm giữ', async () => {
  const { playbook } = await import('../src/brief.js');
  const c = { close: 20, stop: 19, buyFrom: 19.3, buyTo: 20, target: 22, resistance: 21, weight: 0.2, rsi: 55, aboveMa200: true, ma200: 18, score: 80 };
  const buy = playbook('BUY', c);
  assert.match(buy.newBuyer[0], /chia 2 lần/);
  assert.match(buy.newBuyer.join(' '), /20% vốn/);
  assert.match(buy.holder.join(' '), /Chốt lời 1\/3 ở 22/);
  assert.match(playbook('BUY', { ...c, rsi: 78 }).newBuyer[0], /Không mua đuổi/);

  const hold = playbook('HOLD', { ...c, score: 55, aboveMa200: false, ma200: 21 });
  assert.match(hold.newBuyer[1], /điểm xếp hạng lên ≥ 70 \(hiện 55\) và giá vượt lên trên MA200 21/);

  // Đang lỗ, mục tiêu dưới giá vốn: không được gọi là "chốt lời"
  const loss = playbook('HOLD', { ...c, holding: { qty: 1000, sellable: 0, pending: 1000, avgCost: 23, pnlPct: -0.13 } });
  assert.match(loss.position, /1\.000 cp, giá vốn 23, lỗ 13,0%/);
  assert.match(loss.holder[0], /cân nhắc cắt lỗ/);
  assert.ok(!loss.holder.some((x) => /Chốt lời/.test(x)));
  assert.ok(loss.holder.some((x) => /vẫn dưới giá vốn/.test(x)));
  assert.ok(loss.holder.some((x) => /T\+2/.test(x)));

  // Thủng cắt lỗ → bán theo kỷ luật lên đầu
  const broke = playbook('AVOID', { ...c, close: 18.5, holding: { qty: 100, sellable: 100, pending: 0, avgCost: 20, pnlPct: -0.08 } });
  assert.match(broke.holder[0], /thủng cắt lỗ/);
});
