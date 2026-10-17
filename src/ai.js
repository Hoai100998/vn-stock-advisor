// Phân tích chuyên sâu bằng AI (Gemini, tự chuyển sang Mistral/Groq/OpenRouter… khi hết hạn mức — xem src/llm.js).
// AI nhận toàn bộ dữ liệu đã thu thập (giá, chỉ báo, chỉ số tài chính, tin tức, điểm theo quy tắc)
// và trả về quyết định MUA/BÁN/GIỮ có cấu trúc kèm lập luận.
import { cached, uncache } from './http.js';
import { providers, providerStatus, generateJson } from './llm.js';

const MIN = 60_000;

export const DECISIONS = {
  MUA: 'MUA',
  MUA_THAM_DO: 'MUA THĂM DÒ',
  GIU: 'GIỮ / THEO DÕI',
  DUNG_NGOAI: 'ĐỨNG NGOÀI',
  BAN_BOT: 'BÁN BỚT',
  BAN: 'BÁN',
};

// Bật khi có ít nhất một nhà cung cấp AI; "model" là nhà cung cấp đứng đầu để hiển thị.
export function aiConfig() {
  const list = providers();
  const status = providerStatus();
  const first = status.find((p) => p.status === 'ready') || status[0];
  return {
    enabled: list.length > 0,
    model: first ? `${first.label} · ${first.model}` : '',
    providers: status,
  };
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    decision: { type: 'STRING', enum: Object.keys(DECISIONS), description: 'Quyết định chính' },
    headline: { type: 'STRING', description: 'MỘT câu kết luận cho nhà đầu tư, tối đa 25 từ, nêu hành động và lý do chính' },
    marketFlowView: { type: 'STRING', description: '1-2 câu: dòng tiền thị trường chung, khối ngoại toàn sàn và của mã này đang ủng hộ hay bất lợi' },
    confidence: { type: 'INTEGER', description: 'Độ tin cậy 0-100' },
    horizon: { type: 'STRING', description: 'Khung thời gian nắm giữ phù hợp, ví dụ "ngắn hạn 2-4 tuần"' },
    summary: { type: 'STRING', description: 'Tóm tắt 3-5 câu lý do chính của quyết định' },
    forNewBuyers: { type: 'STRING', description: 'Hành động cụ thể cho người chưa có cổ phiếu' },
    forHolders: { type: 'STRING', description: 'Hành động cụ thể cho người đang nắm giữ' },
    entryZone: {
      type: 'OBJECT',
      properties: { from: { type: 'NUMBER' }, to: { type: 'NUMBER' } },
      description: 'Vùng giá mua hợp lý (nghìn đồng)',
    },
    stopLoss: { type: 'NUMBER', description: 'Giá cắt lỗ (nghìn đồng)' },
    targets: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Các mức chốt lời (nghìn đồng), tăng dần' },
    positionSizing: { type: 'STRING', description: 'Gợi ý tỷ trọng vốn và cách giải ngân' },
    bullCase: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Luận điểm ủng hộ mua' },
    bearCase: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Luận điểm phản bác / rủi ro' },
    newsInsights: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Nhận định rút ra từ tin tức, nêu rõ tin nào' },
    catalysts: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Sự kiện có thể làm giá thay đổi mạnh sắp tới' },
    watchItems: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Tín hiệu cần theo dõi để đổi quyết định' },
    ruleScoreComment: { type: 'STRING', description: 'Đồng ý hay không với điểm theo quy tắc của hệ thống và vì sao' },
    dataGaps: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Dữ liệu còn thiếu hoặc đáng ngờ' },
  },
  required: ['decision', 'headline', 'marketFlowView', 'confidence', 'horizon', 'summary', 'forNewBuyers', 'forHolders',
    'stopLoss', 'targets', 'positionSizing', 'bullCase', 'bearCase', 'newsInsights', 'catalysts', 'watchItems',
    'ruleScoreComment', 'dataGaps'],
  propertyOrdering: ['summary', 'bullCase', 'bearCase', 'newsInsights', 'marketFlowView', 'catalysts', 'ruleScoreComment',
    'decision', 'headline', 'confidence', 'horizon', 'forNewBuyers', 'forHolders', 'entryZone', 'stopLoss', 'targets',
    'positionSizing', 'watchItems', 'dataGaps'],
};

const SYSTEM = `Bạn là chuyên viên phân tích chứng khoán Việt Nam giàu kinh nghiệm, kỷ luật và thận trọng.
Nhiệm vụ: dựa HOÀN TOÀN vào dữ liệu được cung cấp, đưa ra quyết định giao dịch cho một mã cổ phiếu.
Nguyên tắc:
- Chỉ dùng số liệu có trong dữ liệu; không bịa thêm số liệu, sự kiện hay tin tức. Thiếu dữ liệu thì ghi vào dataGaps.
- Cân nhắc cả xu hướng kỹ thuật, định giá, chất lượng tăng trưởng, tin tức và bối cảnh VN-Index.
- Không dựa vào một chỉ báo đơn lẻ: xác nhận chéo xu hướng (MA + ADX), động lượng (RSI + MACD + Stochastic),
  dòng tiền (MFI + OBV + khối lượng + khối ngoại) và sức mạnh tương đối so với VN-Index. Nêu rõ khi các nhóm mâu thuẫn.
- Tiêu đề tin tức chỉ là tín hiệu; nhãn cảm xúc do máy chấm theo từ khóa nên có thể sai, hãy tự đánh giá lại.
  Đối chiếu tin với phản ứng giá của phiên sau khi tin ra: tin tốt mà giá giảm là dấu hiệu tin đã được phản ánh hoặc lực bán mạnh.
  Ưu tiên tin về kết quả kinh doanh, giao dịch nội bộ, cổ tức và pháp lý hơn tin mô tả diễn biến giá.
- Ưu tiên bảo toàn vốn: khi tín hiệu trái chiều hãy chọn GIU hoặc DUNG_NGOAI thay vì MUA.
- Giá tính bằng nghìn đồng. Biên độ HOSE ±7%, HNX ±10%, UPCoM ±15%; giao dịch T+2.
- Cắt lỗ phải thấp hơn giá hiện tại; mục tiêu phải cao hơn giá hiện tại.
- Viết bằng tiếng Việt, ngắn gọn, cụ thể, có con số.
Các lựa chọn decision: MUA (mua mạnh), MUA_THAM_DO (mua tỷ trọng nhỏ), GIU (giữ/theo dõi), DUNG_NGOAI (chưa mua),
BAN_BOT (hạ tỷ trọng), BAN (bán toàn bộ).`;

const n = (v, d = 2) => (v == null || !Number.isFinite(v) ? 'n/a' : Number(v.toFixed(d)));
const p = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

function buildPrompt(a) {
  const f = a.fundamental.data;
  const i = a.technical.indicators;
  const lines = [];
  lines.push(`# Mã ${a.symbol} - ${a.info.name} (${a.info.exchange})`);
  lines.push(`Ngày dữ liệu: ${a.price.date}. Giá đóng cửa: ${a.price.close} (${a.price.changePct}% so với phiên trước).`);
  if (a.market) lines.push(`VN-Index: ${a.market.close} (${a.market.changePct}%), xu hướng: ${a.market.trend}.`);

  lines.push('\n## Chỉ báo kỹ thuật');
  lines.push(`MA20 ${n(i.sma20)}, MA50 ${n(i.sma50)}, MA200 ${n(i.sma200)}; RSI14 ${n(i.rsi14, 1)}; MACD ${n(i.macd, 3)} / signal ${n(i.macdSignal, 3)} / hist ${n(i.macdHist, 3)}`);
  lines.push(`Bollinger ${n(i.bbLower)} - ${n(i.bbUpper)}; ATR14 ${n(i.atr14)}; KL phiên ${i.volume}, TB20 ${i.avgVolume20}`);
  lines.push(`Hiệu suất: 5 phiên ${i.return5d}%, 20 phiên ${i.return20d}%, 60 phiên ${i.return60d}%, 1 năm ${i.return250d}%`);
  if (a.plan) lines.push(`Hỗ trợ 20 phiên ${a.plan.support}, kháng cự 20 phiên ${a.plan.resistance}`);
  lines.push(`ADX14 ${n(i.adx14, 1)} (+DI ${n(i.plusDI, 1)} / −DI ${n(i.minusDI, 1)}); Stochastic %K ${n(i.stochK, 1)} / %D ${n(i.stochD, 1)}; MFI14 ${n(i.mfi14, 1)}; OBV ${i.obvTrend ?? 'n/a'}; phân kỳ RSI: ${i.rsiDivergence ?? 'không'}`);
  lines.push(`KL TB5 ${i.avgVolume5} so với TB20 ${i.avgVolume20}; sức mạnh so với VN-Index: 20 phiên ${i.rs20 ?? 'n/a'} điểm %, 60 phiên ${i.rs60 ?? 'n/a'} điểm %`);

  if (a.overview?.length) {
    lines.push('\n## Tổng hợp theo nhóm chỉ báo (máy tính)');
    for (const o of a.overview) lines.push(`- ${o.label}: ${o.verdict} (${o.detail})`);
  }

  if (a.marketFlow) {
    const mf = a.marketFlow;
    lines.push(`\n## Mua bán toàn sàn ${mf.floor} phiên ${mf.date}`);
    lines.push(`Độ rộng: ${mf.advancers} mã tăng / ${mf.decliners} mã giảm / ${mf.unchanged} đứng giá; giá trị khớp lệnh ${(mf.totalValue / 1e9).toFixed(0)} tỷ`);
    lines.push(`Khối ngoại toàn sàn: mua ${(mf.foreign.buyVal / 1e9).toFixed(0)} tỷ, bán ${(mf.foreign.sellVal / 1e9).toFixed(0)} tỷ, ròng ${(mf.foreign.netVal / 1e9).toFixed(0)} tỷ`);
    lines.push(`Khối ngoại mua ròng nhiều nhất: ${mf.topForeignBuy.join(', ')}; bán ròng nhiều nhất: ${mf.topForeignSell.join(', ')}`);
  }

  if (a.foreign?.history?.length) {
    lines.push('\n## Khối ngoại 20 phiên (ngày: mua ròng tỷ đồng)');
    lines.push(a.foreign.history.map((d) => `${d.date.slice(5)}: ${(d.netVal / 1e9).toFixed(1)}`).join('; '));
    lines.push(`Tổng 5 phiên ${(a.foreign.net5 / 1e9).toFixed(1)} tỷ, 20 phiên ${(a.foreign.net20 / 1e9).toFixed(1)} tỷ (${a.foreign.ratio20}% giá trị khớp lệnh)`);
  }

  lines.push('\n## Giá 60 phiên gần nhất (ngày,mở,cao,thấp,đóng,khối lượng)');
  for (const b of a.recentBars) lines.push(`${b.time},${b.open},${b.high},${b.low},${b.close},${b.volume}`);

  if (f) {
    lines.push(`\n## Chỉ số tài chính (BCTC đến ${f.reportDate || 'n/a'})`);
    lines.push(`P/E ${n(f.pe, 1)}, P/B ${n(f.pb)}, P/S ${n(f.ps)}, EPS 4 quý ${n(f.epsTTM, 0)} đ, BVPS ${n(f.bookValuePerShare, 0)} đ`);
    lines.push(`ROE ${p(f.roe)}, ROA ${p(f.roa)}, biên LN gộp ${p(f.grossMarginTTM)}, biên LN ròng ${p(f.netMarginTTM)}`);
    lines.push(`Tăng trưởng LN 4 quý ${p(f.profitGrowthTTM)}, DT 4 quý ${p(f.revenueGrowthTTM)}, LN quý gần nhất so cùng kỳ ${p(f.profitGrowthQoQYoY)}, DT quý so cùng kỳ ${p(f.revenueGrowthQYoY)}, LN BQ 3 năm ${p(f.profitGrowth3Y)}`);
    lines.push(`Nợ vay/VCSH ${n(f.debtToEquity)}, thanh toán hiện hành ${n(f.currentRatio)}, tỷ suất cổ tức ${p(f.dividendYield)}, beta ${n(f.beta)}`);
    lines.push(`Vốn hóa ${n(f.marketCap / 1e9, 0)} tỷ đ, đỉnh/đáy 52 tuần ${n(f.high52w / 1000)}/${n(f.low52w / 1000)}, sở hữu nước ngoài ${p(f.foreignOwnership)}`);
  }

  if (a.news.categories?.length) {
    lines.push('\n## Tin theo nhóm sự kiện (số tin, điểm cảm xúc TB −100..100)');
    lines.push(a.news.categories.map((c) => `${c.label}: ${c.count} tin, ${c.sentiment}`).join('; '));
  }
  lines.push(`\n## Tin tức ${a.news.count} tin gần đây (mới nhất trước; [nhãn máy chấm | nhóm] nguồn, ngày, giá phiên sau tin: tiêu đề)`);
  for (const it of a.news.items.slice(0, 30)) {
    const date = it.publishedAt ? new Date(it.publishedAt).toISOString().slice(0, 10) : '?';
    const cats = it.categories?.length ? ` | ${it.categories.join(',')}` : '';
    const react = it.reaction ? `, giá ${it.reaction.pct > 0 ? '+' : ''}${it.reaction.pct}%` : '';
    lines.push(`- [${it.label}${cats}] ${it.source}, ${date}${react}: ${it.title}${it.summary ? ` — ${it.summary.slice(0, 200)}` : ''}`);
  }

  lines.push('\n## Điểm theo quy tắc của hệ thống (−100..100)');
  lines.push(`Tổng ${a.total} → ${a.recommendation.label}. Kỹ thuật ${a.scores.technical}, cơ bản ${a.scores.fundamental ?? 'n/a'}, tin tức ${a.scores.news ?? 'n/a'}.`);
  for (const s of [...a.technical.signals, ...a.fundamental.signals, ...a.news.signals]) lines.push(`- (${s.points > 0 ? '+' : ''}${s.points}) ${s.text}`);
  for (const w of a.warnings) lines.push(`- CẢNH BÁO: ${w}`);

  lines.push('\nHãy phân tích và trả về JSON theo schema.');
  return lines.join('\n');
}

/** Giữ tên cũ cho các module đang dùng; tham số model bị bỏ qua vì lớp llm tự chọn nhà cung cấp. */
export async function callWithRetry(prompt, _model, { system = SYSTEM, schema = SCHEMA, timeout = 180_000 } = {}) {
  return generateJson(prompt, { system, schema, timeout });
}

// Kiểm tra lại số liệu Gemini trả về: loại bỏ mức giá vô lý so với giá hiện tại
function sanitize(r, close) {
  const sane = (v) => (Number.isFinite(v) && v > close * 0.5 && v < close * 2 ? v : null);
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  const stop = sane(r.stopLoss);
  const ez = r.entryZone && sane(r.entryZone.from) && sane(r.entryZone.to)
    ? { from: Math.min(r.entryZone.from, r.entryZone.to), to: Math.max(r.entryZone.from, r.entryZone.to) } : null;
  return {
    decision: DECISIONS[r.decision] ? r.decision : 'GIU',
    decisionLabel: DECISIONS[r.decision] || DECISIONS.GIU,
    confidence: Math.max(0, Math.min(100, Math.round(r.confidence ?? 0))),
    horizon: String(r.horizon || ''),
    summary: String(r.summary || ''),
    headline: String(r.headline || ''),
    marketFlowView: String(r.marketFlowView || ''),
    forNewBuyers: String(r.forNewBuyers || ''),
    forHolders: String(r.forHolders || ''),
    entryZone: ez,
    stopLoss: stop != null && stop < close ? stop : null,
    targets: (Array.isArray(r.targets) ? r.targets : []).map(sane).filter((v) => v != null && v > close).sort((a, b) => a - b),
    positionSizing: String(r.positionSizing || ''),
    bullCase: arr(r.bullCase),
    bearCase: arr(r.bearCase),
    newsInsights: arr(r.newsInsights),
    catalysts: arr(r.catalysts),
    watchItems: arr(r.watchItems),
    ruleScoreComment: String(r.ruleScoreComment || ''),
    dataGaps: arr(r.dataGaps),
  };
}

/**
 * Gửi kết quả analyzeSymbol() cho Gemini. Kết quả được cache 30 phút cho mỗi mã + phiên giá + model,
 * truyền { force: true } để bắt buộc gọi lại.
 */
export function aiAnalyze(analysis, { force = false } = {}) {
  const cfg = aiConfig();
  if (!cfg.enabled) {
    return Promise.reject(new Error('Chưa cấu hình API key AI nào (GEMINI_API_KEY, MISTRAL_API_KEY…). Xem hướng dẫn trong README.md'));
  }
  if (analysis.isIndex) return Promise.reject(new Error('Phân tích AI chỉ áp dụng cho cổ phiếu'));
  const useModel = cfg.model;
  const key = `ai:${analysis.symbol}:${analysis.price.date}:${analysis.price.close}`;
  const run = async () => {
    const started = Date.now();
    const { json, usage, model } = await callWithRetry(buildPrompt(analysis), useModel);
    return {
      symbol: analysis.symbol,
      price: analysis.price.close,
      priceDate: analysis.price.date,
      model,
      createdAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      tokens: usage?.totalTokenCount ?? null,
      ...sanitize(json, analysis.price.close),
    };
  };
  if (force) uncache(key);
  return cached(key, 30 * MIN, run);
}

export { buildPrompt };

// ---------- Xếp hạng cổ phiếu tiềm năng (một lần gọi cho cả danh sách) ----------
export const PICK_VERDICTS = { MUA: 'MUA', MUA_THAM_DO: 'MUA THĂM DÒ', CHO_DIEM_MUA: 'CHỜ ĐIỂM MUA', LOAI: 'LOẠI' };

const PICK_SCHEMA = {
  type: 'OBJECT',
  properties: {
    marketView: { type: 'STRING', description: '2-3 câu: bối cảnh thị trường và dòng tiền hiện tại có thuận lợi để mua mới không' },
    picks: {
      type: 'ARRAY',
      description: 'Đánh giá TỪNG mã trong danh sách, sắp xếp từ hấp dẫn nhất',
      items: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING' },
          verdict: { type: 'STRING', enum: Object.keys(PICK_VERDICTS) },
          confidence: { type: 'INTEGER', description: '0-100' },
          thesis: { type: 'STRING', description: '2-3 câu: vì sao mã này có tiềm năng, dựa trên số liệu được cung cấp' },
          trigger: { type: 'STRING', description: 'Điều kiện cụ thể để mua (vd: giá về vùng X hoặc vượt Y kèm khối lượng)' },
          mainRisk: { type: 'STRING', description: 'Rủi ro lớn nhất' },
          entryFrom: { type: 'NUMBER' },
          entryTo: { type: 'NUMBER' },
          stopLoss: { type: 'NUMBER' },
          target: { type: 'NUMBER' },
          horizon: { type: 'STRING', description: 'Khung thời gian nắm giữ' },
        },
        required: ['symbol', 'verdict', 'confidence', 'thesis', 'trigger', 'mainRisk', 'entryFrom', 'entryTo', 'stopLoss', 'target', 'horizon'],
        propertyOrdering: ['symbol', 'thesis', 'mainRisk', 'verdict', 'confidence', 'trigger', 'entryFrom', 'entryTo', 'stopLoss', 'target', 'horizon'],
      },
    },
    note: { type: 'STRING', description: 'Lưu ý chung về quản lý vốn khi mua các mã này' },
  },
  required: ['marketView', 'picks', 'note'],
  propertyOrdering: ['marketView', 'picks', 'note'],
};

const PICK_SYSTEM = `Bạn là chuyên viên phân tích chứng khoán Việt Nam, kỷ luật và thận trọng.
Nhiệm vụ: từ danh sách cổ phiếu đã được bộ lọc định lượng chọn ra, đánh giá mã nào thực sự đáng mua trong 1-3 tháng tới.
Nguyên tắc:
- Chỉ dùng dữ liệu được cung cấp, không bịa số liệu hay tin tức. Không hứa hẹn lợi nhuận.
- Ưu tiên mã có nhiều nhóm tín hiệu cùng chiều (xu hướng, động lượng, dòng tiền, khối ngoại, cơ bản, tin tức).
- Thị trường chung xấu thì hạ mức quyết định (MUA → MUA_THAM_DO hoặc CHO_DIEM_MUA) và nói rõ.
- Mã đã tăng nóng (RSI > 70, xa MA20) thì chọn CHO_DIEM_MUA với vùng mua thấp hơn giá hiện tại.
- LOAI nếu rủi ro lớn hơn tiềm năng. Được phép loại nhiều mã.
- Giá tính bằng nghìn đồng; cắt lỗ < vùng mua < mục tiêu; tỷ lệ lợi nhuận/rủi ro nên ≥ 1,5.
- Viết tiếng Việt, ngắn gọn, có con số. Trong văn bản không viết mã kỹ thuật như CHO_DIEM_MUA, MUA_THAM_DO;
  dùng "chờ điểm mua", "mua thăm dò".`;

function pickPrompt(cands, marketFlow, market) {
  const L = [];
  if (market) L.push(`VN-Index ${market.close} (${market.changePct}%), xu hướng ${market.trend}.`);
  if (marketFlow) {
    L.push(`Sàn ${marketFlow.floor} phiên ${marketFlow.date}: ${marketFlow.advancers} mã tăng / ${marketFlow.decliners} giảm; khối ngoại ròng ${(marketFlow.foreign.netVal / 1e9).toFixed(0)} tỷ.`);
  }
  L.push(`\n# ${cands.length} mã ứng viên`);
  for (const c of cands) {
    const i = c.indicators, f = c.fundamentals || {};
    L.push(`\n## ${c.symbol} - ${c.name} (${c.exchange}) giá ${c.close} (${c.changePct}% hôm nay)`);
    L.push(`Setup: ${c.setups.map((s) => s.label).join(', ') || 'không'}; điểm hệ thống: tổng ${c.total}, kỹ thuật ${c.scores.technical}, cơ bản ${c.scores.fundamental ?? 'n/a'}, tin ${c.scores.news ?? 'n/a'}`);
    L.push(`MA20 ${i.sma20}, MA50 ${i.sma50}, MA200 ${i.sma200}; RSI ${i.rsi14}; MACD hist ${i.macdHist}; ADX ${i.adx14} (+DI ${i.plusDI}/−DI ${i.minusDI}); Stoch ${i.stochK}; MFI ${i.mfi14}; OBV ${i.obvTrend}; RS 20 phiên so với VN-Index ${i.rs20}; hiệu suất 20/60 phiên ${i.return20d}%/${i.return60d}%`);
    L.push(`P/E ${f.pe?.toFixed?.(1) ?? 'n/a'}, P/B ${f.pb?.toFixed?.(2) ?? 'n/a'}, ROE ${f.roe != null ? (f.roe * 100).toFixed(1) + '%' : 'n/a'}, LN 4Q ${f.profitGrowthTTM != null ? (f.profitGrowthTTM * 100).toFixed(0) + '%' : 'n/a'}, DT 4Q ${f.revenueGrowthTTM != null ? (f.revenueGrowthTTM * 100).toFixed(0) + '%' : 'n/a'}`);
    if (c.foreign) L.push(`Khối ngoại: 5 phiên ${(c.foreign.net5 / 1e9).toFixed(1)} tỷ, 20 phiên ${(c.foreign.net20 / 1e9).toFixed(1)} tỷ`);
    if (c.plan) L.push(`Hỗ trợ ${c.plan.support}, kháng cự ${c.plan.resistance}, ATR ${c.plan.atr}`);
    for (const n of (c.news || []).slice(0, 4)) L.push(`- Tin [${n.label}${n.reaction ? `, giá ${n.reaction.pct}%` : ''}]: ${n.title}`);
  }
  L.push('\nĐánh giá từng mã và trả về JSON theo schema.');
  return L.join('\n');
}

/** Gemini đánh giá và xếp hạng danh sách ứng viên. Trả về null nếu chưa cấu hình. */
export async function aiPickStocks(cands, { marketFlow = null, market = null } = {}) {
  const cfg = aiConfig();
  if (!cfg.enabled || !cands.length) return null;
  const started = Date.now();
  const { json, model, usage } = await callWithRetry(pickPrompt(cands, marketFlow, market), cfg.model,
    { system: PICK_SYSTEM, schema: PICK_SCHEMA, timeout: 150_000 });
  const bySym = new Map(cands.map((c) => [c.symbol, c]));
  const seen = new Set();
  const picks = (Array.isArray(json.picks) ? json.picks : []).map((p) => {
    const c = bySym.get(String(p.symbol || '').toUpperCase());
    if (!c || seen.has(c.symbol)) return null;
    seen.add(c.symbol);
    const sane = (v) => (Number.isFinite(v) && v > c.close * 0.5 && v < c.close * 2 ? v : null);
    const ef = sane(p.entryFrom), et = sane(p.entryTo), sl = sane(p.stopLoss), tg = sane(p.target);
    const lo = ef != null && et != null ? Math.min(ef, et) : null;
    const hi = ef != null && et != null ? Math.max(ef, et) : null;
    return {
      symbol: c.symbol,
      verdict: PICK_VERDICTS[p.verdict] ? p.verdict : 'CHO_DIEM_MUA',
      verdictLabel: PICK_VERDICTS[p.verdict] || PICK_VERDICTS.CHO_DIEM_MUA,
      confidence: Math.max(0, Math.min(100, Math.round(p.confidence ?? 0))),
      thesis: String(p.thesis || ''),
      trigger: String(p.trigger || ''),
      mainRisk: String(p.mainRisk || ''),
      entryZone: lo != null ? { from: lo, to: hi } : null,
      stopLoss: sl != null && (lo == null || sl < lo) ? sl : null,
      target: tg != null && tg > (hi ?? c.close) ? tg : null,
      horizon: String(p.horizon || ''),
    };
  }).filter(Boolean);
  return {
    model, createdAt: new Date().toISOString(), durationMs: Date.now() - started, tokens: usage?.totalTokenCount ?? null,
    marketView: String(json.marketView || ''), note: String(json.note || ''), picks,
  };
}
