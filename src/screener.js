// Bộ lọc cổ phiếu tiềm năng, quét toàn thị trường theo 3 bước:
//  1. Lọc nhanh mọi mã đạt tiêu chí sàn + thanh khoản (mặc định HOSE, ≥ 5 tỷ/phiên): chấm kỹ thuật + cơ bản + khối ngoại, nhận diện setup.
//     Bắt buộc: thanh khoản ĐỀU (TB 20 phiên ≥ ngưỡng và ≥ 16/20 phiên đạt ngưỡng) và "cổ ngon" (qualityCheck).
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
import { getSectorFlows } from './sectors.js';

// ---------- Tiêu chí "cổ ngon" (cơ bản doanh nghiệp) và thanh khoản đều ----------
export const QUALITY_RULES = { minRoe: 0.12, minProfitGrowth: 0, maxPe: 25, maxDebtToEquity: 1.5 };
export const LIQUIDITY_RULES = { days: 20, minDays: 16 };
const FINANCIAL = /ngân hàng|chứng khoán|bảo hiểm|tài chính/i;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Kiểm tra doanh nghiệp có "ngon" không. Thiếu dữ liệu thì không đạt (không xác minh được).
 * Nợ vay/vốn chủ không áp dụng cho ngân hàng, chứng khoán, bảo hiểm (mô hình kinh doanh dùng đòn bẩy).
 * @returns {{ pass: boolean, score: number|null, checks: {label: string, ok: boolean}[], failed: string[] }}
 */
export function qualityCheck(f, sectorName = '') {
  const R = QUALITY_RULES;
  const pc = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
  if (!f) return { pass: false, score: null, checks: [{ ok: false, label: 'Chưa có dữ liệu tài chính' }], failed: ['Chưa có dữ liệu tài chính'] };
  const checks = [];
  const add = (ok, label) => checks.push({ ok, label });
  const fin = FINANCIAL.test(sectorName);
  add(f.epsTTM != null && f.epsTTM > 0, f.epsTTM == null ? 'Chưa có EPS' : f.epsTTM > 0 ? 'Đang có lãi (EPS 4 quý dương)' : 'Đang lỗ 4 quý gần nhất');
  add(f.roe != null && f.roe >= R.minRoe, f.roe == null ? 'Chưa có ROE' : `ROE ${pc(f.roe, 1)} ${f.roe >= R.minRoe ? '≥' : '<'} ${pc(R.minRoe)}`);
  add(f.profitGrowthTTM != null && f.profitGrowthTTM >= R.minProfitGrowth,
    f.profitGrowthTTM == null ? 'Chưa có tăng trưởng lợi nhuận' : `Lợi nhuận 4 quý ${f.profitGrowthTTM >= 0 ? 'tăng' : 'giảm'} ${pc(Math.abs(f.profitGrowthTTM))}`);
  add(f.pe != null && f.pe > 0 && f.pe <= R.maxPe, f.pe == null || f.pe <= 0 ? 'Chưa có P/E' : `P/E ${f.pe.toFixed(1)} ${f.pe <= R.maxPe ? '≤' : '>'} ${R.maxPe}`);
  if (!fin) {
    add(f.debtToEquity == null || f.debtToEquity <= R.maxDebtToEquity,
      f.debtToEquity == null ? 'Nợ vay/vốn chủ: không có dữ liệu' : `Nợ vay/vốn chủ ${f.debtToEquity.toFixed(2)} ${f.debtToEquity <= R.maxDebtToEquity ? '≤' : '>'} ${R.maxDebtToEquity}`);
  }
  const failed = checks.filter((c) => !c.ok).map((c) => c.label);
  // Điểm chất lượng 0–100 để xếp hạng giữa các mã đã đạt
  const parts = [];
  if (f.roe != null) parts.push(clamp01((f.roe - R.minRoe) / (0.25 - R.minRoe)));
  if (f.profitGrowthTTM != null) parts.push(clamp01(f.profitGrowthTTM / 0.3));
  if (f.revenueGrowthTTM != null) parts.push(clamp01((f.revenueGrowthTTM + 0.05) / 0.25));
  if (f.pe != null && f.pe > 0) parts.push(clamp01((R.maxPe - f.pe) / (R.maxPe - 8)));
  if (!fin && f.debtToEquity != null) parts.push(clamp01((R.maxDebtToEquity - f.debtToEquity) / R.maxDebtToEquity));
  const score = parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100) : null;
  return { pass: failed.length === 0, score, checks, failed };
}

/** Thanh khoản đều: TB N phiên ≥ ngưỡng và ít nhất minDays phiên có giá trị khớp lệnh ≥ ngưỡng (đồng). */
export function liquidityCheck(bars, minValue, { days = LIQUIDITY_RULES.days, minDays = LIQUIDITY_RULES.minDays } = {}) {
  const values = bars.slice(-days).map((b) => b.close * b.volume * 1000);
  const avg = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const okDays = values.filter((v) => v >= minValue).length;
  return { pass: avg >= minValue && okDays >= minDays, avg, okDays, days: values.length, last: values.at(-1) ?? 0, minDays };
}

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
  const liquidity = liquidityCheck(bars, screenCriteria().minValue);
  const quality = qualityCheck(fund, ctx.sectorOf?.get(item.symbol) || '');

  const setups = detectSetups({ close, changePct, i, plan: tech.plan, faScore: fa.score ?? 0, flow: tech.flow });
  // Tiêu chí chính: điểm xếp hạng 4 yếu tố (đã kiểm chứng). Chỉ nhóm ≥ 70 và trên MA200 thắng VN-Index ổn định,
  // nên chỉ những mã đó được đưa vào vòng phân tích sâu. Điểm kỹ thuật/cơ bản cũ chỉ để hiển thị.
  const rank = await rankSymbol(item.symbol, bars).catch(() => null);
  const quick = rank ? rank.score : null;
  return {
    symbol: item.symbol, exchange: item.exchange, close, changePct,
    quick: Math.round(quick), technical: tech.score, fundamental: fa.score, setups, avgValue20,
    rankScore: rank?.score ?? null, aboveMa200: rank?.aboveMa200 ?? null,
    liquidity, quality,
    // Xếp hạng chung: nửa điểm xu hướng (xếp hạng 4 yếu tố) + nửa điểm chất lượng doanh nghiệp
    combined: quick != null && quality.score != null ? Math.round((quick + quality.score) / 2) : null,
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
  const flows = await getSectorFlows(5).catch(() => null);
  const sectorOf = new Map();
  for (const s of flows?.sectors || []) for (const x of s.stocks) sectorOf.set(x.symbol, s.name);
  const ctx = { indexBars, market, sectorOf };

  // Bước 1
  const uni = await universe();
  state.progress = { stage: 1, label: 'Lọc nhanh toàn thị trường', done: 0, total: uni.length };
  const scanned = await pool(uni, (it) => quickScan(it, ctx), () => state.progress.done++);

  // Bước 2
  // Bắt buộc: thanh khoản đều + cổ ngon + xu hướng (điểm xếp hạng ≥ 70, trên MA200); xếp theo điểm chung
  const trendOk = (c) => c.quick != null && c.quick >= 70 && c.aboveMa200 !== false;
  const funnel = {
    scanned: scanned.length,
    liquidity: scanned.filter((c) => c.liquidity.pass).length,
    quality: scanned.filter((c) => c.liquidity.pass && c.quality.pass).length,
    trend: scanned.filter((c) => c.liquidity.pass && c.quality.pass && trendOk(c)).length,
  };
  const shortlist = scanned
    .filter((c) => c.liquidity.pass && c.quality.pass && trendOk(c))
    .sort((a, b) => b.combined - a.combined)
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
      liquidity: c.liquidity, quality: qualityCheck(a.fundamental.data, a.sector?.name || ''), combined: c.combined,
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
    .filter((c) => c.quality.pass)
    .sort((a, b) => (b.combined ?? 0) - (a.combined ?? 0))
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
    criteria: screenCriteria(), quality: QUALITY_RULES, liquidityRule: LIQUIDITY_RULES, funnel,
    universe: uni.length, scanned: scanned.length, shortlisted: shortlist.length,
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
