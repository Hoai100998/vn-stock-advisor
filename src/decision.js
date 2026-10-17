// Quyết định cuối = hệ thống định lượng (điểm xếp hạng, đã kiểm chứng) + AI thẩm định theo yếu tố thị trường.
// Nguyên tắc chống sai lệch: khi hai bên khác nhau thì lấy bên THẬN TRỌNG hơn. AI được quyền hạ mức
// (thị trường xấu, tin rủi ro…), không được nâng vượt tín hiệu định lượng chưa xác nhận.
import { RECOMMENDATIONS } from './analyze.js';
import { tradeSteps } from './tradeplan.js';
import { actionFor } from './brief.js';

// Thứ tự từ thận trọng nhất đến tích cực nhất
const LEVEL = { SELL: 0, AVOID: 1, HOLD: 2, ACCUMULATE: 3, BUY: 4 };
const CODE_AT = Object.fromEntries(Object.entries(LEVEL).map(([k, v]) => [v, k]));
// Quyết định của AI quy về mã khuyến nghị của hệ thống
export const AI_TO_CODE = { MUA: 'BUY', MUA_THAM_DO: 'ACCUMULATE', GIU: 'HOLD', DUNG_NGOAI: 'AVOID', BAN_BOT: 'AVOID', BAN: 'SELL' };
const TONE = { BUY: 'up', ACCUMULATE: 'up', HOLD: 'ref', AVOID: 'down', SELL: 'down' };

/** Gộp: lấy mức thận trọng hơn. Trả về mã cuối và AI đã hạ, đồng ý hay tích cực hơn. */
export function fuseDecision(systemCode, aiDecision) {
  const aiCode = AI_TO_CODE[aiDecision];
  if (!aiCode || LEVEL[systemCode] == null) return { code: systemCode, relation: 'none' };
  const s = LEVEL[systemCode], a = LEVEL[aiCode];
  return { code: CODE_AT[Math.min(s, a)], aiCode, relation: a < s ? 'stricter' : a > s ? 'looser' : 'agree' };
}

/**
 * Quyết định cuối kèm kế hoạch mua/bán tính lại theo mức đã gộp.
 * @param {object} a kết quả analyzeSymbol (có brief)
 * @param {object} ai kết quả aiAnalyze (có decision, planReview, marketChecks)
 */
export function finalDecision(a, ai) {
  const b = a.brief;
  if (!b || !ai) return null;
  const sys = a.recommendation.code;
  const { code, relation, aiCode } = fuseDecision(sys, ai.decision);
  const label = RECOMMENDATIONS.find((r) => r.code === code)?.label || code;
  const sysLabel = a.recommendation.label;
  const why = ai.planReview?.reason || ai.headline || '';
  const bad = (ai.marketChecks || []).filter((x) => x.status === 'XAU').map((x) => x.label.toLowerCase());
  let note;
  if (relation === 'stricter') note = `AI hạ từ ${sysLabel} xuống ${label}${bad.length ? ` (yếu tố xấu: ${bad.join(', ')})` : ''}. ${why}`;
  else if (relation === 'looser') note = `AI tích cực hơn (${ai.decisionLabel}) nhưng tín hiệu định lượng chưa xác nhận nên giữ ${label}. ${why}`;
  else note = `AI đồng ý ${label}. ${why}`;

  const i = a.technical.indicators;
  const steps = b.levels ? tradeSteps(code, b.levels, {
    weight: b.levels.weight ?? 0.1, rsi: i.rsi14, avgVol20: i.avgVolume20, ma200: i.sma200,
    score: a.ranking?.score, aboveMa200: a.ranking?.aboveMa200, holding: a.holding ?? b.holding ?? null,
    marketWait: relation === 'stricter' && bad.length ? `các yếu tố thị trường cải thiện (${bad.join(', ')})` : null,
  }) : null;
  return {
    code, label, tone: TONE[code], relation, aiCode,
    systemCode: sys, systemLabel: sysLabel,
    note: note.trim(),
    action: actionFor(code, b.levels),
    steps,
    marketChecks: ai.marketChecks || [],
    priceDate: a.price.date, price: a.price.close,
  };
}
