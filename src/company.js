// Hồ sơ doanh nghiệp cho phân tích sâu (nguồn VNDirect finfo):
//  - Kết quả kinh doanh 12 quý gần nhất: doanh thu, lợi nhuận gộp, lợi nhuận sau thuế công ty mẹ, dòng tiền kinh doanh;
//    tăng trưởng so cùng kỳ, lợi nhuận tăng tốc hay chậm lại, chất lượng lợi nhuận (dòng tiền / lợi nhuận).
//  - Định giá so với chính lịch sử (P/E, P/B 5 năm) và so với các mã cùng ngành trong rổ theo dõi.
//  - Sự kiện doanh nghiệp: cổ tức, cổ phiếu thưởng, phát hành thêm (pha loãng), ĐHCĐ, cảnh báo — sắp tới và gần đây.
//  - Cổ đông lớn và khuyến nghị của công ty chứng khoán (giá không điều chỉnh theo chia tách → chỉ dùng % kỳ vọng tại ngày báo cáo).
import { fetchJson, cached } from './http.js';
import { getFundamentals } from './data.js';

const FINFO = 'https://api-finfo.vndirect.com.vn/v4';
const MIN = 60_000, HOUR = 60 * MIN;
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

// Mã chỉ tiêu BCTC (dùng chung các loại hình; ngân hàng không có doanh thu thuần mà dùng tổng thu nhập hoạt động)
const ITEMS = {
  revenue: 21001, grossProfit: 23100, profit: 23000, cfo: 32000, equity: 14000, assets: 12700,
  bankIncome: 421701, netInterest: 421900, provision: 422900,
};

// ---------- Kết quả kinh doanh theo quý ----------
export function getQuarterly(symbol) {
  return cached(`quarterly:${symbol}`, 6 * HOUR, async () => {
    const codes = Object.values(ITEMS).join(',');
    const r = await fetchJson(`${FINFO}/financial_statements?q=code:${symbol}~reportType:QUARTER~itemCode:${codes}&sort=fiscalDate:desc&size=600`);
    const byDate = new Map();
    for (const x of r.data || []) {
      if (!byDate.has(x.fiscalDate)) byDate.set(x.fiscalDate, {});
      const row = byDate.get(x.fiscalDate);
      for (const [k, c] of Object.entries(ITEMS)) if (x.itemCode === c && row[k] == null) row[k] = x.numericValue;
    }
    return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({
      date,
      revenue: v.revenue ?? v.bankIncome ?? null,
      bank: v.revenue == null && v.bankIncome != null,
      grossProfit: v.grossProfit ?? null, profit: v.profit ?? null, cfo: v.cfo ?? null,
      equity: v.equity ?? null, assets: v.assets ?? null, netInterest: v.netInterest ?? null, provision: v.provision ?? null,
    }));
  });
}

const qLabel = (date) => `Q${Math.ceil(Number(date.slice(5, 7)) / 3)}/${date.slice(0, 4)}`;
const growth = (a, b) => (a != null && b != null && b > 0 ? a / b - 1 : null); // b ≤ 0: không tính % (lỗ → lãi)

/**
 * Phân tích chuỗi quý: tăng trưởng so cùng kỳ, tăng tốc, chuỗi quý tăng trưởng, chất lượng lợi nhuận.
 * @param {object[]} q các quý tăng dần
 */
export function analyzeQuarters(q) {
  if (!q?.length) return null;
  const rows = q.map((r, i) => {
    const ly = q.find((x) => x.date.slice(5) === r.date.slice(5) && Number(x.date.slice(0, 4)) === Number(r.date.slice(0, 4)) - 1);
    return {
      ...r, label: qLabel(r.date),
      revenueYoY: round(growth(r.revenue, ly?.revenue), 4),
      profitYoY: round(growth(r.profit, ly?.profit), 4),
      grossMargin: r.grossProfit != null && r.revenue ? round(r.grossProfit / r.revenue, 4) : null,
      netMargin: r.profit != null && r.revenue ? round(r.profit / r.revenue, 4) : null,
      prevQoQ: i ? round(growth(r.profit, q[i - 1].profit), 4) : null,
    };
  });
  const last = rows.at(-1), prev = rows.at(-2);
  const sum4 = (k, end = rows.length) => {
    const s = rows.slice(Math.max(0, end - 4), end);
    return s.length === 4 && s.every((x) => x[k] != null) ? s.reduce((a, x) => a + x[k], 0) : null;
  };
  const profitTTM = sum4('profit'), profitTTMPrev = sum4('profit', rows.length - 4);
  const cfoTTM = sum4('cfo');
  // Chuỗi quý liên tiếp lợi nhuận tăng so cùng kỳ (tính từ quý gần nhất lùi lại)
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].profitYoY != null && rows[i].profitYoY > 0; i--) streak++;
  let declineStreak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].profitYoY != null && rows[i].profitYoY < 0; i--) declineStreak++;
  const accel = last?.profitYoY != null && prev?.profitYoY != null ? round(last.profitYoY - prev.profitYoY, 4) : null;
  let trend = 'CHUA_RO';
  if (last?.profitYoY != null) {
    if (last.profitYoY > 0.15 && (accel == null || accel > 0)) trend = 'TANG_TOC';
    else if (last.profitYoY > 0) trend = accel != null && accel < -0.15 ? 'CHAM_LAI' : 'ON_DINH';
    else trend = 'SUY_GIAM';
  }
  const roeTTM = profitTTM != null && last?.equity ? round(profitTTM / last.equity, 4) : null;
  // Báo cáo quý tiếp theo: hạn công bố BCTC hợp nhất ~45 ngày sau khi kết thúc quý
  const end = new Date(`${last.date}T00:00:00Z`);
  const nextEnd = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 4, 0));
  const due = new Date(nextEnd.getTime() + 45 * 86400_000);
  return {
    quarters: rows.slice(-12),
    latest: last.label, latestDate: last.date,
    profitYoY: last.profitYoY, revenueYoY: last.revenueYoY, accel, trend,
    growthStreak: streak, declineStreak,
    profitTTM, profitTTMGrowth: round(growth(profitTTM, profitTTMPrev), 4),
    cfoToProfit: cfoTTM != null && profitTTM > 0 ? round(cfoTTM / profitTTM, 2) : null,
    roeTTM,
    grossMarginChange: last.grossMargin != null && prev?.grossMargin != null ? round(last.grossMargin - prev.grossMargin, 4) : null,
    nextReport: { quarter: qLabel(nextEnd.toISOString().slice(0, 10)), dueBy: due.toISOString().slice(0, 10) },
    bank: last.bank,
  };
}

// ---------- Định giá so với lịch sử ----------
function ratioHistory(symbol, itemCode, size = 1300) {
  return cached(`ratio-hist:${symbol}:${itemCode}`, 6 * HOUR, async () => {
    const r = await fetchJson(`${FINFO}/ratios?q=code:${symbol}~itemCode:${itemCode}&sort=reportDate:desc&size=${size}&fields=reportDate,value`);
    return (r.data || []).filter((x) => Number.isFinite(x.value) && x.value > 0).map((x) => ({ date: x.reportDate, value: x.value }));
  });
}

function histStats(series, current) {
  if (!series.length || !Number.isFinite(current)) return null;
  const vals = series.map((x) => x.value);
  const below = vals.filter((v) => v < current).length;
  return {
    current: round(current, 2), median: round(median(vals), 2),
    min: round(Math.min(...vals), 2), max: round(Math.max(...vals), 2),
    percentile: round(below / vals.length, 3), // 0 = rẻ nhất trong lịch sử, 1 = đắt nhất
    from: series.at(-1).date, n: vals.length,
  };
}

/** Định giá: P/E, P/B so với 5 năm của chính mã và với trung vị các mã cùng ngành. */
export async function getValuation(symbol, { peers = [] } = {}) {
  const [f, pe, pb] = await Promise.all([
    getFundamentals(symbol).catch(() => null),
    ratioHistory(symbol, 51006).catch(() => []),
    ratioHistory(symbol, 51012).catch(() => []),
  ]);
  const peerF = await Promise.all(peers.filter((s) => s !== symbol).slice(0, 25).map((s) => getFundamentals(s).catch(() => null)));
  const ok = peerF.filter(Boolean);
  const sector = ok.length >= 2 ? {
    n: ok.length,
    pe: round(median(ok.map((x) => x.pe).filter((v) => v > 0 && v < 100)), 2),
    pb: round(median(ok.map((x) => x.pb).filter((v) => v > 0 && v < 20)), 2),
    roe: round(median(ok.map((x) => x.roe)), 4),
  } : null;
  const peH = histStats(pe, f?.pe), pbH = histStats(pb, f?.pb);
  let verdict = 'CHUA_RO';
  const p = peH?.percentile ?? pbH?.percentile;
  if (p != null) verdict = p <= 0.25 ? 'RE' : p >= 0.75 ? 'DAT' : 'HOP_LY';
  return { pe: peH, pb: pbH, sector, verdict, roe: f?.roe ?? null };
}

// ---------- Sự kiện doanh nghiệp ----------
const EVENT_KEEP = {
  DIVIDEND: 'Cổ tức tiền', STOCKDIV: 'Cổ tức cổ phiếu', KINDDIV: 'Cổ phiếu thưởng', ISSUE: 'Phát hành thêm',
  MEETING: 'Họp ĐHCĐ', meetingRight: 'Chốt quyền ĐHCĐ', POLL: 'Lấy ý kiến cổ đông', schedIssue: 'Dự kiến phát hành',
  schedDiv: 'Dự kiến cổ tức', noticed: 'Nhắc nhở', warning: 'Cảnh báo', control: 'Kiểm soát', restricted: 'Hạn chế giao dịch',
  ADPAYDATE: 'Đổi ngày trả cổ tức',
};
const DILUTIVE = new Set(['ISSUE', 'schedIssue', 'STOCKDIV', 'KINDDIV']);

export function getEvents(symbol) {
  return cached(`events:${symbol}`, 3 * HOUR, async () => {
    const r = await fetchJson(`${FINFO}/events?q=code:${symbol}~locale:VN&sort=disclosureDate:desc&size=80`);
    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const seen = new Set();
    const list = [];
    for (const e of r.data || []) {
      if (!EVENT_KEEP[e.type]) continue;
      const key = `${e.type}|${e.effectiveDate || e.disclosureDate}|${e.note}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const date = e.effectiveDate || e.disclosureDate;
      list.push({
        type: e.type, label: EVENT_KEEP[e.type], note: String(e.note || '').trim(),
        disclosed: e.disclosureDate, date, payDate: e.expiredDate || null,
        upcoming: date >= today, dilutive: DILUTIVE.has(e.type), alert: ['noticed', 'warning', 'control', 'restricted'].includes(e.type),
        shares: e.numberOfShares || null,
      });
    }
    const daysAgo = (d) => (Date.parse(today) - Date.parse(d)) / 86400_000;
    return {
      upcoming: list.filter((x) => x.upcoming).sort((a, b) => a.date.localeCompare(b.date)),
      recent: list.filter((x) => !x.upcoming && daysAgo(x.date) <= 365).slice(0, 10),
      alerts: list.filter((x) => x.alert && daysAgo(x.date) <= 365),
    };
  });
}

// ---------- Cổ đông lớn & khuyến nghị CTCK ----------
export function getShareholders(symbol) {
  return cached(`holders:${symbol}`, 12 * HOUR, async () => {
    const r = await fetchJson(`${FINFO}/shareholders?q=code:${symbol}&sort=ownershipPct:desc&size=8`);
    return (r.data || []).map((x) => ({ name: x.shareholderName, role: x.roleType, type: x.shareholderType, pct: round(x.ownershipPct, 2), date: x.effectiveDate }));
  });
}

export function getBrokerViews(symbol) {
  return cached(`brokers:${symbol}`, 6 * HOUR, async () => {
    const r = await fetchJson(`${FINFO}/recommendations?q=code:${symbol}&sort=reportDate:desc&size=10`);
    const today = Date.now();
    return (r.data || []).map((x) => ({
      firm: x.firm, source: x.source, type: x.type, date: x.reportDate,
      reportPrice: x.reportPrice, targetPrice: x.targetPrice,
      upside: x.reportPrice > 0 && x.targetPrice > 0 ? round(x.targetPrice / x.reportPrice - 1, 3) : null,
      ageDays: Math.round((today - Date.parse(x.reportDate)) / 86400_000),
    }));
  });
}

/**
 * Hồ sơ đầy đủ cho một mã. Mỗi phần lỗi riêng thì bỏ qua phần đó.
 * @param {{ peers?: string[] }} opts peers = các mã cùng ngành (để so định giá)
 */
export async function getCompanyProfile(symbol, { peers = [], financial = false } = {}) {
  const [q, valuation, events, holders, brokers] = await Promise.all([
    getQuarterly(symbol).catch(() => null),
    getValuation(symbol, { peers }).catch(() => null),
    getEvents(symbol).catch(() => null),
    getShareholders(symbol).catch(() => []),
    getBrokerViews(symbol).catch(() => []),
  ]);
  const earnings = q?.length ? analyzeQuarters(q) : null;
  // Ngân hàng / chứng khoán / bảo hiểm: dòng tiền kinh doanh gồm cả cho vay, tiền gửi → không phản ánh chất lượng lợi nhuận
  if (earnings && (financial || earnings.bank)) earnings.cfoToProfit = null;
  return {
    earnings, valuation, events, holders,
    brokers: brokers.filter((b) => b.ageDays <= 365),
    brokersOld: brokers.filter((b) => b.ageDays > 365).length,
  };
}

export const EARNINGS_TREND = { TANG_TOC: 'Lợi nhuận tăng tốc', ON_DINH: 'Tăng trưởng ổn định', CHAM_LAI: 'Tăng trưởng chậm lại', SUY_GIAM: 'Lợi nhuận suy giảm', CHUA_RO: 'Chưa rõ' };
export const VALUATION_VERDICT = { RE: 'Rẻ so với lịch sử', HOP_LY: 'Hợp lý', DAT: 'Đắt so với lịch sử', CHUA_RO: 'Chưa rõ' };
