import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseDecision, finalDecision } from '../src/decision.js';

test('Gộp quyết định: lấy bên thận trọng hơn, AI không được nâng mức', () => {
  assert.deepEqual(fuseDecision('BUY', 'MUA'), { code: 'BUY', aiCode: 'BUY', relation: 'agree' });
  assert.equal(fuseDecision('BUY', 'GIU').code, 'HOLD');
  assert.equal(fuseDecision('BUY', 'DUNG_NGOAI').relation, 'stricter');
  assert.equal(fuseDecision('HOLD', 'MUA').code, 'HOLD'); // AI tích cực hơn: giữ mức hệ thống
  assert.equal(fuseDecision('HOLD', 'MUA').relation, 'looser');
  assert.equal(fuseDecision('AVOID', 'BAN').code, 'SELL');
  assert.equal(fuseDecision('BUY', 'KHONG_RO').relation, 'none');
});

test('Quyết định cuối: kế hoạch mua/bán tính lại theo mức đã hạ', () => {
  const a = {
    recommendation: { code: 'BUY', label: 'NÊN MUA' }, price: { close: 20.9, date: '2026-10-16' },
    technical: { indicators: { rsi14: 60, avgVolume20: 1e6, sma200: 19 } }, ranking: { score: 80, aboveMa200: true },
    brief: { levels: { r2: 22.2, r1: 21.2, close: 20.9, s1: 20.75, s2: 20.1, stop: 19.85, atr: 0.42, weight: 0.2 } },
  };
  const ai = {
    decision: 'DUNG_NGOAI', decisionLabel: 'ĐỨNG NGOÀI', headline: '',
    planReview: { verdict: 'THAN_TRONG_HON', reason: 'VN-Index dưới MA200.' },
    marketChecks: [{ factor: 'VN_INDEX', label: 'Xu hướng VN-Index', status: 'XAU', note: 'dưới MA200' }],
  };
  const f = finalDecision(a, ai);
  assert.equal(f.code, 'AVOID');
  assert.match(f.note, /AI hạ từ NÊN MUA xuống CHƯA NÊN MUA \(yếu tố xấu: xu hướng vn-index\)/);
  assert.equal(f.steps.fresh[0].side, 'wait'); // không còn bước mua ngay
  assert.match(f.action, /Không mua mới/);
});
