// Web server: phục vụ dashboard (public/) và các API JSON.
import './src/env.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSymbol, getMarketOverview } from './src/analyze.js';
import { aiConfig } from './src/ai.js';
import { testProviders } from './src/llm.js';
import { getMarketMovers, screenCriteria } from './src/data.js';
import { getScreener, startScreener, rerunScreenerAi, startScreenerSchedule } from './src/screener.js';
import { runBacktest, listStrategies } from './src/backtest.js';
import { startCommittee, getCommittee } from './src/committee.js';
import { getPortfolio, addTransaction, removeTransaction } from './src/portfolio.js';
import { getRankBoard, runRankPortfolio } from './src/ranking.js';
import { evaluatePredictions } from './src/predictions.js';
import { startHistorySchedule, listSnapshots } from './src/history.js';
import { getSectorFlows } from './src/sectors.js';
import { getChartSeries } from './src/chartdata.js';
import {
  getWatchlist, addToWatchlist, removeFromWatchlist, scanWatchlist,
  getAlerts, markAlertsRead, startMonitor, runAi, getAiResult, triggerTestAlert,
} from './src/tracker.js';

const PORT = Number(process.env.PORT) || 3000;
const SCAN_MINUTES = Number(process.env.SCAN_MINUTES) || 10;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1e5) throw new Error('Request quá lớn');
  }
  return data ? JSON.parse(data) : {};
}

const SYMBOL_RE = /^[A-Za-z0-9]{3,10}$/;

const routes = [
  ['GET', /^\/api\/analyze\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    send(res, 200, await analyzeSymbol(sym));
  }],
  ['GET', /^\/api\/market$/, async (req, res) => send(res, 200, await getMarketOverview())],
  // Biểu đồ theo khung: /api/chart/FPT?tf=D|W|M (nến ngày / tuần / tháng kèm MA20/50/200 của khung đó)
  ['GET', /^\/api\/chart\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const tf = (new URL(req.url, 'http://localhost').searchParams.get('tf') || 'D').toUpperCase();
    send(res, 200, await getChartSeries(sym.toUpperCase(), tf));
  }],
  // Cổ phiếu tiềm năng: trạng thái/kết quả, quét lại toàn bộ, hoặc chỉ chạy lại bước Gemini
  ['GET', /^\/api\/screener$/, async (req, res) => send(res, 200, await getScreener())],
  ['POST', /^\/api\/screener\/run$/, async (req, res) => send(res, 200, await startScreener())],
  ['POST', /^\/api\/screener\/ai$/, async (req, res) => send(res, 200, await rerunScreenerAi())],
  // Top tăng/giảm, giá trị giao dịch, khối ngoại mua/bán ròng của sàn được theo dõi (mặc định HOSE): /api/movers?floor=HOSE
  ['GET', /^\/api\/movers$/, async (req, res) => {
    const floor = (new URL(req.url, 'http://localhost').searchParams.get('floor') || 'HOSE').toUpperCase();
    const { floors } = screenCriteria();
    if (!floors.includes(floor)) return send(res, 400, { error: `Tool chỉ theo dõi sàn ${floors.join(', ')}` });
    send(res, 200, await getMarketMovers(floor));
  }],
  ['GET', /^\/api\/ai\/status$/, async (req, res) => send(res, 200, aiConfig())],
  // Gửi yêu cầu nhỏ tới từng nhà cung cấp AI để kiểm tra key
  ['POST', /^\/api\/ai\/test$/, async (req, res) => send(res, 200, await testProviders())],
  ['GET', /^\/api\/ai\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    send(res, 200, await getAiResult(sym));
  }],
  ['POST', /^\/api\/ai\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const { force } = await readBody(req);
    send(res, 200, await runAi(sym, { force: Boolean(force) }));
  }],
  // Backtest theo luật thị trường VN: /api/backtest/FPT?strategy=score&years=3&buy=30&sell=-10&stop=7
  ['GET', /^\/api\/backtest\/strategies$/, async (req, res) => send(res, 200, listStrategies())],
  ['GET', /^\/api\/backtest\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const q = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    send(res, 200, await runBacktest(sym, {
      strategy: q.strategy, years: q.years, params: q,
      stopLossPct: q.stop, takeProfitPct: q.take, positionPct: q.position, initialCash: q.cash,
    }));
  }],
  // Quy trình quyết định: Gemini → phe mua / phe bán → giám đốc đầu tư. POST bắt đầu ({ force }), GET xem tiến độ và kết quả
  ['GET', /^\/api\/committee\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    send(res, 200, await getCommittee(sym));
  }],
  ['POST', /^\/api\/committee\/([^/]+)$/, async (req, res, [sym]) => {
    if (!SYMBOL_RE.test(sym)) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const { force } = await readBody(req).catch(() => ({}));
    send(res, 200, await startCommittee(sym, { force: Boolean(force) }));
  }],
  // Xếp hạng 4 yếu tố, backtest danh mục top N, độ chính xác của các dự đoán đã ghi
  ['GET', /^\/api\/rank$/, async (req, res) => {
    const { ref, ...board } = await getRankBoard();
    send(res, 200, board);
  }],
  ['GET', /^\/api\/rank\/backtest$/, async (req, res) => {
    const q = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    send(res, 200, await runRankPortfolio({ years: q.years, top: q.top, rebalance: q.rebalance, buffer: q.buffer, trendFilter: q.trend, regime: q.regime, initialCash: q.cash }));
  }],
  ['GET', /^\/api\/predictions$/, async (req, res) => send(res, 200, await evaluatePredictions())],
  ['GET', /^\/api\/history$/, async (req, res) => send(res, 200, { dates: await listSnapshots() })],
  // Dòng tiền theo nhóm ngành: /api/sectors?period=1|5|20
  ['GET', /^\/api\/sectors$/, async (req, res) => {
    const period = new URL(req.url, 'http://localhost').searchParams.get('period') || '1';
    send(res, 200, await getSectorFlows(period));
  }],
  // Danh mục đầu tư thực tế
  ['GET', /^\/api\/portfolio$/, async (req, res) => send(res, 200, await getPortfolio())],
  ['POST', /^\/api\/portfolio\/tx$/, async (req, res) => {
    try {
      send(res, 200, await addTransaction(await readBody(req)));
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  }],
  ['DELETE', /^\/api\/portfolio\/tx\/([^/]+)$/, async (req, res, [id]) => send(res, 200, await removeTransaction(id))],
  ['GET', /^\/api\/watchlist$/, async (req, res) => send(res, 200, await getWatchlist())],
  ['POST', /^\/api\/watchlist$/, async (req, res) => {
    const body = await readBody(req);
    if (!SYMBOL_RE.test(body.symbol || '')) return send(res, 400, { error: 'Mã chứng khoán không hợp lệ' });
    const entry = await addToWatchlist(body.symbol, body);
    scanWatchlist().catch(() => {});
    send(res, 200, entry);
  }],
  ['DELETE', /^\/api\/watchlist\/([^/]+)$/, async (req, res, [sym]) => {
    await removeFromWatchlist(sym);
    send(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/scan$/, async (req, res) => send(res, 200, await scanWatchlist())],
  ['GET', /^\/api\/alerts$/, async (req, res) => send(res, 200, await getAlerts())],
  ['POST', /^\/api\/alerts\/read$/, async (req, res) => {
    await markAlertsRead();
    send(res, 200, { ok: true });
  }],
  ['POST', /^\/api\/alerts\/test$/, async (req, res) => {
    const { symbol, message } = await readBody(req);
    send(res, 200, await triggerTestAlert(symbol, message));
  }],
];

async function serveStatic(req, res, pathname) {
  const file = normalize(join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'Không tìm thấy' });
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    for (const [method, re, handler] of routes) {
      const m = pathname.match(re);
      if (m && req.method === method) return await handler(req, res, m.slice(1).map(decodeURIComponent));
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'API không tồn tại' });
    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(`${req.method} ${pathname}:`, err.message);
    const status = /Không tìm thấy/.test(err.message) ? 404
      : /Chưa cấu hình|chỉ áp dụng|không hợp lệ|quá ít dữ liệu/.test(err.message) ? 400
      : /hạn mức/.test(err.message) ? 429 : 502;
    if (!res.headersSent) send(res, status, { error: err.message });
  }
});

// Chỉ lắng nghe trên máy local
server.listen(PORT, '127.0.0.1', () => {
  console.log(`VN Stock Advisor đang chạy tại http://localhost:${PORT}`);
  console.log(`Tự động quét danh mục mỗi ${SCAN_MINUTES} phút trong giờ giao dịch.`);
  const ai = aiConfig();
  console.log(ai.enabled
    ? `AI: BẬT — thứ tự dự phòng: ${ai.providers.map((p) => `${p.label} (${p.model})`).join(' → ')}${process.env.GEMINI_AUTO_SCAN === '1' ? ' · tự động phân tích danh mục' : ''}`
    : 'AI: TẮT (thêm GEMINI_API_KEY hoặc MISTRAL_API_KEY… vào file .env để bật)');
  startMonitor(SCAN_MINUTES);
  // Tải trước bảng top cổ phiếu HOSE để lần mở trang đầu không phải chờ
  getMarketMovers('HOSE').catch(() => {});
  // Tính bảng xếp hạng ngay và mỗi 30 phút (đồng thời ghi top 8 vào nhật ký dự đoán)
  getRankBoard().then(() => getSectorFlows(5)).catch(() => {});
  setInterval(() => getRankBoard().catch(() => {}), 30 * 60_000);
  // Ảnh chụp dữ liệu cuối ngày toàn bộ rổ + ghi dự đoán để tự chấm
  startHistorySchedule();
  // Quét cổ phiếu tiềm năng mỗi ngày giao dịch sau 15:10
  startScreenerSchedule();
});
