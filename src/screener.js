// Bộ lọc cổ phiếu tiềm năng, quét toàn thị trường theo 3 bước:
//  1. Lọc nhanh mọi mã đạt tiêu chí sàn + thanh khoản (mặc định HOSE, ≥ 5 tỷ/phiên): chấm kỹ thuật + cơ bản + khối ngoại, nhận diện setup.
//  2. Phân tích đầy đủ (có tin tức) nhóm dẫn đầu, loại mã có tin rủi ro hoặc bị chấm tiêu cực.
//  3. Gemini đánh giá và xếp hạng danh sách cuối trong một lần gọi.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPriceHistory, getFundamentals, getForeignFlow, getScreenUniverse, screenCriteria } from './data.js';
import { technicalAnalysis, fundamentalAnalysis, marketContext, analyzeSymbol } from './analyze.js';
import { aiPickStocks } from './ai.js';
import { rankSymbol } from './ranking.js';
import { recordMany } from './predictions.js';

const PICK_DIRECTION = { MUA: 1, MUA_THAM_DO: 1, CHO_DIEM_MUA: 0, LOAI: -1 };

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'screener.json');
const STAGE2_SIZE = 14;     // số mã phân tích đầy đủ
const FINAL_SIZE = 10;      // số mã gửi Gemini và hiển thị
const CONCURRENCY = 6;

const state = { status: 'idle', progress: null, error: null, result: null };
let loaded = false;

async function load() {
  if (loaded) return;
  loaded = true;
  try { state.result = JSON.parse(await readFile(FILE, 'utf8')); } catch { /* chưa có kết quả */ }
}

/** Nhận diện kiểu cơ hội mua từ các chỉ báo đã tính. */
export function detectSetups({ close, changePct, i, plan, faScore, flow }) {
  const s = [];
  const add = (id, label, desc) => s.push({ id, label, desc });
  const upStructure = i.sma50 != null && close > i.sma50 && (i.sma200 == null || i.sma50 > i.sma200);

  if (plan && close >= plan.resistance * 0.985 && i.avgVolume20 && i.volume >= 1.5 * i.avgVolume20 && changePct > 0) {
    add('breakout', 'Bứt phá', `Giá sát/vượt đỉnh 20 phiên ${plan.resistance} với khối lượng gấp ${(i.volume / i.avgVolume20).toFixed(1)} lần TB20`);
  }
  if (i.sma20 != null && upStructure && close > i.sma20 && i.sma20 > i.sma50 && i.rsi14 >= 50 && i.rsi14 <= 72) {
    add('uptrend', 'Xu hướng tăng', `Giá > MA20 > MA50${i.sma200 != null ? ' > MA200' : ''}, RSI ${i.rsi14}`);
  }
  if (upStructure && i.sma20 != null && Math.abs(close - i.sma20) / i.sma20 < 0.025 && i.rsi14 >= 40 && i.rsi14 <= 55) {
    add('pullback', 'Điều chỉnh về hỗ trợ', `Xu hướng tăng, giá lùi về sát MA20 (${i.sma20}), RSI ${i.rsi14} đã nguội`);
  }
  if ((i.rsi14 < 38 || i.stochK < 25) && (i.rsiDivergence === 'bullish' || i.stochK > i.stochD) && faScore >= 20) {
    add('reversal', 'Hồi phục từ quá bán', `RSI ${i.rsi14}, Stochastic ${i.stochK} bắt đầu quay lên; cơ bản tốt (điểm ${faScore})`);
  }
  if (i.adx14 != null && i.adx14 < 20 && Math.abs(i.return20d ?? 99) < 5 && i.obvTrend === 'up' && faScore >= 10) {
    add('accumulation', 'Tích lũy', `Đi ngang 20 phiên (ADX ${i.adx14}) trong khi OBV tăng: dòng tiền âm thầm vào`);
  }
  if (flow && flow.ratio20 > 3 && flow.buyDays5 >= 3) {
    add('foreign', 'Khối ngoại gom', `Mua ròng ${(flow.net20 / 1e9).toFixed(0)} tỷ trong 20 phiên, ${flow.buyDays5}/5 phiên gần nhất mua`);
  }
  return s;
}

// Cổ phiếu ứng viên: sàn và ngưỡng thanh khoản theo screenCriteria() (mặc định HOSE, ≥ 5 tỷ/phiên TB 20 phiên)
const universe = () => getScreenUniverse();

async function quickScan(item, ctx) {
  const [priceRes, fund, foreign] = await Promise.all([
    getPriceHistory(item.symbol),
    getFundamentals(item.symbol).catch(() => null),
    getForeignFlow(item.symbol, 20).catch(() => null),
  ]);
  const { bars } = priceRes;
  if (bars.length < 60) return null;
  const close = bars.at(-1).close;
  const changePct = Math.round(((close - bars.at(-2).close) / bars.at(-2).close) * 10000) / 100;
  const tech = technicalAnalysis(bars, ctx.market, { indexBars: ctx.indexBars, foreign });
  const fa = fund ? fundamentalAnalysis(fund) : { score: null };
  const i = tech.indicators;
  const avgValue20 = i.avgVolume20 * close * 1000;
  if (avgValue20 < screenCriteria().minValue) return null;

  const setups = detectSetups({ close, changePct, i, plan: tech.plan, faScore: fa.score ?? 0, flow: tech.flow });
  // Tiêu chí chính: điểm xếp hạng 4 yếu tố (đã kiểm chứng). Chỉ nhóm ≥ 70 và trên MA200 thắng VN-Index ổn định,
  // nên chỉ những mã đó được đưa vào vòng phân tích sâu. Điểm kỹ thuật/cơ bản cũ chỉ để hiển thị.
  const rank = await rankSymbol(item.symbol, bars).catch(() => null);
  const quick = rank ? rank.score : null;
  return {
    symbol: item.symbol, exchange: item.exchange, close, changePct,
    quick: Math.round(quick), technical: tech.score, fundamental: fa.score, setups, avgValue20,
    rankScore: rank?.score ?? null, aboveMa200: rank?.aboveMa200 ?? null,
  };
}

async function pool(items, worker, onDone) {
  const queue = [...items];
  const out = [];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const it = queue.shift();
      try {
        const r = await worker(it);
        if (r) out.push(r);
      } catch { /* bỏ qua mã lỗi */ }
      onDone();
    }
  }));
  return out;
}

const RISK_WARNING = /tin rủi ro nghiêm trọng|đang lỗ/;

async function run() {
  const started = Date.now();
  const { bars: indexBars } = await getPriceHistory('VNINDEX');
  const date = indexBars.at(-1).time;
  const market = await marketContext().catch(() => null);
  const ctx = { indexBars, market };

  // Bước 1
  const uni = await universe();
  state.progress = { stage: 1, label: 'Lọc nhanh toàn thị trường', done: 0, total: uni.length };
  const scanned = await pool(uni, (it) => quickScan(it, ctx), () => state.progress.done++);

  // Bước 2
  const shortlist = scanned
    .filter((c) => c.quick != null && c.quick >= 70 && c.aboveMa200 !== false)
    .sort((a, b) => b.quick - a.quick)
    .slice(0, STAGE2_SIZE);
  state.progress = { stage: 2, label: 'Phân tích sâu nhóm dẫn đầu (kèm tin tức)', done: 0, total: shortlist.length };
  let marketFlow = null;
  const detailed = await pool(shortlist, async (c) => {
    const a = await analyzeSymbol(c.symbol, { withChart: false });
    marketFlow ??= a.marketFlow;
    if (a.recommendation.code === 'SELL' || a.recommendation.code === 'AVOID') return null;
    if (a.warnings.some((w) => RISK_WARNING.test(w))) return null;
    return {
      symbol: a.symbol, name: a.info.name, exchange: a.info.exchange,
      close: a.price.close, changePct: a.price.changePct, date: a.price.date,
      setups: c.setups, quick: c.quick, avgValue20: c.avgValue20,
      total: a.total, scores: a.scores, recommendation: a.recommendation,
      indicators: a.technical.indicators, fundamentals: a.fundamental.data,
      foreign: a.foreign ? { net1: a.foreign.net1, net5: a.foreign.net5, net20: a.foreign.net20, buyDays5: a.foreign.buyDays5 } : null,
      plan: a.plan, overview: a.overview, warnings: a.warnings,
      ranking: a.ranking ? { score: a.ranking.score, label: a.ranking.label, code: a.ranking.code, position: a.ranking.position, universe: a.ranking.universe } : null,
      news: a.news.items.filter((n) => n.label !== 'trung_lap').slice(0, 4)
        .map((n) => ({ title: n.title, label: n.label, link: n.link, source: n.source, publishedAt: n.publishedAt, reaction: n.reaction })),
    };
  }, () => state.progress.done++);

  const final = detailed
    .sort((a, b) => (b.ranking?.score ?? 0) - (a.ranking?.score ?? 0))
    .slice(0, FINAL_SIZE);

  // Bước 3
  state.progress = { stage: 3, label: 'Gemini đánh giá và xếp hạng', done: 0, total: 1 };
  let ai = null;
  try {
    ai = await aiPickStocks(final, { marketFlow, market });
  } catch (err) {
    ai = { error: err.message };
  }
  state.progress.done = 1;
  if (ai?.picks) {
    const close = new Map(final.map((c) => [c.symbol, c]));
    recordMany(ai.picks.map((p) => ({
      source: 'screener', symbol: p.symbol, date: close.get(p.symbol)?.date || date, direction: PICK_DIRECTION[p.verdict],
      label: p.verdictLabel, price: close.get(p.symbol)?.close, detail: `Tin cậy ${p.confidence}%`,
    })));
  }

  const setupCounts = {};
  for (const c of scanned) for (const s of c.setups) setupCounts[s.label] = (setupCounts[s.label] || 0) + 1;

  return {
    date, createdAt: new Date().toISOString(), durationMs: Date.now() - started,
    criteria: screenCriteria(), universe: uni.length, scanned: scanned.length, shortlisted: shortlist.length,
    market, marketFlow, setupCounts, candidates: final, ai,
  };
}

export async function getScreener() {
  await load();
  return state;
}

/** Bắt đầu quét (nếu chưa chạy). Trả về trạng thái ngay, không chờ quét xong. */
export async function startScreener() {
  await load();
  if (state.status === 'running') return state;
  state.status = 'running';
  state.error = null;
  state.progress = { stage: 0, label: 'Chuẩn bị', done: 0, total: 1 };
  run().then(async (result) => {
    state.result = result;
    state.status = 'done';
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(result, null, 2), 'utf8');
    console.log(`[Tiềm năng] Quét xong ${result.scanned} mã trong ${Math.round(result.durationMs / 1000)}s, chọn ${result.candidates.length} mã`);
  }).catch((err) => {
    state.status = 'error';
    state.error = err.message;
    console.error('[Tiềm năng] Lỗi:', err.message);
  });
  return state;
}

/** Chỉ chạy lại bước Gemini trên danh sách đã lọc (khi lần trước Gemini lỗi hoặc muốn đánh giá lại). */
export async function rerunScreenerAi() {
  await load();
  if (state.status === 'running') return state;
  const r = state.result;
  if (!r?.candidates?.length) throw new Error('Chưa có danh sách ứng viên, hãy quét thị trường trước');
  state.status = 'running';
  state.error = null;
  state.progress = { stage: 3, label: 'Gemini đánh giá và xếp hạng', done: 0, total: 1 };
  aiPickStocks(r.candidates, { marketFlow: r.marketFlow, market: r.market })
    .catch((err) => ({ error: err.message }))
    .then(async (ai) => {
      r.ai = ai;
      state.status = 'done';
      const byS = new Map(r.candidates.map((c) => [c.symbol, c]));
      recordMany((ai?.picks || []).map((p) => ({
        source: 'screener', symbol: p.symbol, date: byS.get(p.symbol)?.date || r.date, direction: PICK_DIRECTION[p.verdict],
        label: p.verdictLabel, price: byS.get(p.symbol)?.close, detail: `Tin cậy ${p.confidence}%`,
      })));
      await writeFile(FILE, JSON.stringify(r, null, 2), 'utf8');
    });
  return state;
}

/** Tự quét mỗi ngày giao dịch sau 15:10 (giờ VN) nếu chưa có kết quả cho phiên đó. */
export function startScreenerSchedule() {
  const tick = async () => {
    await load();
    if (state.status === 'running') return;
    const vn = new Date(Date.now() + 7 * 3600_000);
    const minutes = vn.getUTCHours() * 60 + vn.getUTCMinutes();
    if (vn.getUTCDay() === 0 || vn.getUTCDay() === 6 || minutes < 15 * 60 + 10) return;
    const { bars } = await getPriceHistory('VNINDEX').catch(() => ({ bars: [] }));
    const latest = bars.at(-1)?.time;
    if (latest && state.result?.date !== latest) startScreener();
  };
  tick();
  return setInterval(tick, 5 * 60_000);
}
