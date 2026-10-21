import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, handleMessage } from '../src/telegrambot.js';

const T = '2026-10-21';
const trade = (type, symbol, qty, price, date = T) => ({ cmd: 'trade', type, symbol, qty, price, date });

test('Đọc lệnh mua/bán nhiều cách viết', () => {
  assert.deepEqual(parseCommand('mua HPG 1000 25.5 21/10', T), trade('BUY', 'HPG', 1000, 25.5));
  assert.deepEqual(parseCommand('Mua hpg 1.000 25,5', T), trade('BUY', 'HPG', 1000, 25.5)); // không ngày = hôm nay
  assert.deepEqual(parseCommand('MUA HPG 1000 cp giá 25500 ngày 20/10/2026', T), trade('BUY', 'HPG', 1000, 25.5, '2026-10-20'));
  assert.deepEqual(parseCommand('bán VPB 500 24.2 22-10-26', T), trade('SELL', 'VPB', 500, 24.2, '2026-10-22'));
  assert.deepEqual(parseCommand('ban vpb 1k 24.200', T), trade('SELL', 'VPB', 1000, 24.2));
  assert.deepEqual(parseCommand('mua FPT 100 57.4 hôm nay', T), trade('BUY', 'FPT', 100, 57.4));
  assert.deepEqual(parseCommand('HPG mua 1000 25.5', T), trade('BUY', 'HPG', 1000, 25.5));
  assert.deepEqual(parseCommand('mua HPG giá 25.5 sl 1000 ngày 20/10', T), trade('BUY', 'HPG', 1000, 25.5, '2026-10-20'));
  assert.deepEqual(parseCommand('mua mã HPG 25.5 1000', T), trade('BUY', 'HPG', 1000, 25.5)); // giá trước số lượng
  assert.deepEqual(parseCommand('Mua: HPG, 1000, 25.5', T), trade('BUY', 'HPG', 1000, 25.5));
});

test('Lệnh khác và tin không phải lệnh', () => {
  assert.equal(parseCommand('danh mục', T).cmd, 'portfolio');
  assert.equal(parseCommand('/dm', T).cmd, 'portfolio');
  assert.equal(parseCommand('Hoàn tác', T).cmd, 'undo');
  assert.equal(parseCommand('/start', T).cmd, 'help');
  assert.equal(parseCommand('chào bot', T), null);
  assert.equal(parseCommand('tôi muốn mua HPG', T), null); // "mua" không ở đầu câu: không phải lệnh
  assert.equal(parseCommand('mua 1000 25.5', T).cmd, 'error'); // thiếu mã
  assert.equal(parseCommand('mua HPG 1000', T).cmd, 'error'); // thiếu giá
  assert.match(parseCommand('mua HPG 1000 25 40/10', T).error, /Ngày/);
});

test('Ghi giao dịch qua bot rồi hoàn tác', async () => {
  const txs = [];
  const portfolio = {
    addTransaction: async (b) => { const tx = { id: `t${txs.length}`, ...b }; txs.push(tx); return tx; },
    removeTransaction: async (id) => { txs.splice(txs.findIndex((t) => t.id === id), 1); },
    getPortfolio: async () => ({ holdings: txs.map((t) => ({ symbol: t.symbol, qty: t.qty, avgCost: t.price })), summary: {} }),
  };
  const r = await handleMessage('mua HPG 1000 25.5 21/10', { portfolio });
  assert.match(r, /Đã ghi MUA <b>HPG<\/b>/);
  assert.match(r, /1\.000 cp · giá 25,5 · ngày 21\/10\/2026/);
  assert.equal(txs.length, 1);
  assert.match(await handleMessage('hoàn tác', { portfolio }), /Đã xóa: MUA <b>HPG<\/b>/);
  assert.equal(txs.length, 0);
});
