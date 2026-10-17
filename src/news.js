// Thu thập tin tức từ RSS (Google News, CafeF, Vietstock) và chấm điểm cảm xúc.
import { fetchText, cached } from './http.js';
import { analyzeSentiment, normalize } from './sentiment.js';

const MIN = 60_000;
const DAY = 86_400_000;

const MARKET_FEEDS = [
  { source: 'CafeF', url: 'https://cafef.vn/thi-truong-chung-khoan.rss' },
  { source: 'CafeF', url: 'https://cafef.vn/doanh-nghiep.rss' },
  { source: 'Vietstock', url: 'https://vietstock.vn/830/chung-khoan/co-phieu.rss' },
  { source: 'Vietstock', url: 'https://vietstock.vn/737/doanh-nghiep/hoat-dong-kinh-doanh.rss' },
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]).trim() : '';
}

// CafeF dùng năm 2 chữ số: "Thu, 15 Oct 26 19:11:00 +0700"
function parseDate(s) {
  const fixed = s.replace(/^(\w{3},\s*\d{1,2}\s+\w{3}\s+)(\d{2})(\s)/, '$120$2$3');
  const t = Date.parse(fixed);
  return Number.isFinite(t) ? t : null;
}

export function parseRss(xml, defaultSource) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return items.map((it) => {
    let title = stripTags(tag(it, 'title'));
    const source = stripTags(tag(it, 'source')) || defaultSource;
    // Google News nối " - Tên báo" vào cuối tiêu đề
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const description = stripTags(decode(tag(it, 'description')));
    return {
      title,
      link: tag(it, 'link'),
      source,
      // Mô tả của Google News chỉ lặp lại tiêu đề nên bỏ qua
      summary: defaultSource === 'Google News' ? '' : description.slice(0, 300),
      publishedAt: parseDate(tag(it, 'pubDate')),
    };
  }).filter((x) => x.title);
}

function getFeed(url, source) {
  return cached(`rss:${url}`, 15 * MIN, async () => parseRss(await fetchText(url), source));
}

// Phân loại sự kiện theo từ khóa (theo thứ tự ưu tiên, một tin có thể thuộc nhiều nhóm)
export const CATEGORIES = [
  { id: 'insider', label: 'Giao dịch nội bộ', re: /(đăng ký|hoàn tất) (mua|bán)|cổ đông lớn|người (thân|có liên quan)|(chủ tịch|lãnh đạo|tổng giám đốc|thành viên hđqt|con trai|con gái|chị gái|em gái|em trai|anh trai|(?<![\p{L}])(vợ|chồng)(?![\p{L}]))[^.]{0,60}(mua|bán|gom|thoái)/u },
  { id: 'earnings', label: 'Kết quả kinh doanh', re: /lợi nhuận|doanh thu|báo lãi|báo lỗ|lãi ròng|lãi sau thuế|kqkd|kết quả kinh doanh|bctc|báo cáo tài chính|quý [1-4i]|(6|9) tháng|nửa đầu năm|kế hoạch (năm|lợi nhuận)/u },
  { id: 'dividend', label: 'Cổ tức / phát hành', re: /cổ tức|chia thưởng|thưởng cổ phiếu|phát hành|tăng vốn|esop|chốt quyền|ngày đăng ký cuối cùng|cổ phiếu quỹ|mua lại cổ phiếu/u },
  { id: 'flow', label: 'Dòng tiền / khối ngoại', re: /khối ngoại|nhà đầu tư nước ngoài|mua ròng|bán ròng|tự doanh|room ngoại|etf|dòng tiền|thanh khoản/u },
  { id: 'legal', label: 'Pháp lý / rủi ro', re: /khởi tố|điều tra|bị phạt|xử phạt|vi phạm|truy thu|thanh tra|bắt giam|bị bắt|diện cảnh báo|diện kiểm soát|đình chỉ|hủy niêm yết|kiện|tranh chấp/u },
  { id: 'business', label: 'Dự án / hợp đồng / M&A', re: /hợp đồng|trúng thầu|dự án|khởi công|khánh thành|mở rộng|nhà máy|đầu tư|m&a|sáp nhập|thâu tóm|mua lại công ty|hợp tác|ký kết|văn phòng|thị trường mới/u },
  { id: 'rating', label: 'Khuyến nghị / định giá', re: /khuyến nghị|giá mục tiêu|định giá|công ty chứng khoán|ctck|báo cáo phân tích|nâng hạng|hạ hạng|outperform|underperform|khả quan/u },
  { id: 'price', label: 'Diễn biến giá', re: /tăng trần|giảm sàn|kịch trần|phiên|vốn hóa|lao dốc|bứt phá|đỉnh|đáy|giảm \d|tăng \d|chuỗi (tăng|giảm)/u },
];

function categorize(text) {
  const t = normalize(text);
  return CATEGORIES.filter((c) => c.re.test(t)).map((c) => c.id);
}

function score(item) {
  const text = `${item.title}. ${item.summary}`;
  const s = analyzeSentiment(text);
  const categories = categorize(text);
  let sentiment = s.score;
  // Giao dịch nội bộ: hướng mua/bán của người trong công ty quan trọng hơn từ khóa
  // (vd "lãnh đạo đăng ký mua khi thị trường điều chỉnh" bị từ "điều chỉnh" kéo về tiêu cực)
  if (categories.includes('insider')) {
    const t = normalize(item.title);
    const buy = /(?<![\p{L}])(mua|gom)(?![\p{L}])/u.test(t) && !/mua ròng|bán ròng/u.test(t);
    const sell = /(?<![\p{L}])(bán|thoái vốn)(?![\p{L}])/u.test(t) && !/mua ròng|bán ròng/u.test(t);
    if (buy && !sell) sentiment = Math.max(sentiment, 0.5);
    else if (sell && !buy) sentiment = Math.min(sentiment, -0.4);
  }
  const label = sentiment > 0.15 ? 'tich_cuc' : sentiment < -0.15 ? 'tieu_cuc' : 'trung_lap';
  return { ...item, sentiment, label, categories, keywords: s.hits.map((h) => h.phrase) };
}

/**
 * Gắn phản ứng giá cho từng tin: % thay đổi của phiên đầu tiên sau khi tin ra
 * (tin sau 15:00 giờ VN hoặc cuối tuần tính cho phiên kế tiếp).
 */
export function attachPriceReaction(items, bars) {
  if (!bars?.length) return items;
  const dates = bars.map((b) => b.time);
  return items.map((it) => {
    if (!it.publishedAt) return it;
    const vn = new Date(it.publishedAt + 7 * 3600_000);
    if (vn.getUTCHours() >= 15) vn.setUTCDate(vn.getUTCDate() + 1);
    const day = vn.toISOString().slice(0, 10);
    const i = dates.findIndex((d) => d >= day);
    if (i < 1) return it;
    const pct = ((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * 100;
    return { ...it, reaction: { date: bars[i].time, pct: Math.round(pct * 100) / 100 } };
  });
}

/** Thống kê số tin và điểm cảm xúc trung bình theo từng nhóm sự kiện. */
export function summarizeCategories(items) {
  return CATEGORIES.map((c) => {
    const list = items.filter((i) => i.categories?.includes(c.id));
    if (!list.length) return null;
    const avg = list.reduce((s, i) => s + i.sentiment, 0) / list.length;
    return {
      id: c.id, label: c.label, count: list.length,
      sentiment: Math.round(avg * 100),
      positive: list.filter((i) => i.label === 'tich_cuc').length,
      negative: list.filter((i) => i.label === 'tieu_cuc').length,
    };
  }).filter(Boolean);
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = it.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function marketItems() {
  const results = await Promise.allSettled(MARKET_FEEDS.map((f) => getFeed(f.url, f.source)));
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

/** Tin liên quan tới một mã trong `days` ngày gần nhất, mới nhất trước. */
export async function getStockNews(symbol, { companyName, days = 30, limit = 40 } = {}) {
  const query = `"${symbol}" (cổ phiếu OR chứng khoán OR doanh nghiệp) when:${days}d`;
  const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=vi&gl=VN&ceid=VN:vi`;
  const [google, market] = await Promise.all([
    getFeed(gUrl, 'Google News').catch(() => []),
    marketItems(),
  ]);

  // Mã cổ phiếu phải xuất hiện như một từ độc lập, viết hoa
  const symRe = new RegExp(`(?<![\\p{L}\\p{N}])${symbol}(?![\\p{L}\\p{N}])`, 'u');
  const shortName = companyName?.replace(/^(Công ty|Tổng Công ty|Ngân hàng)( Cổ phần| TNHH)?\s*/i, '').trim();
  const mentions = (it) => symRe.test(it.title) || symRe.test(it.summary)
    || (shortName && shortName.length > 6 && `${it.title} ${it.summary}`.includes(shortName));

  const cutoff = Date.now() - days * DAY;
  return dedupe([...market.filter(mentions), ...google.filter(mentions)])
    .filter((it) => !it.publishedAt || it.publishedAt >= cutoff)
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, limit)
    .map(score);
}

/** Tin thị trường chung (không lọc theo mã). */
export async function getMarketNews({ days = 3, limit = 40 } = {}) {
  const cutoff = Date.now() - days * DAY;
  return dedupe(await marketItems())
    .filter((it) => !it.publishedAt || it.publishedAt >= cutoff)
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, limit)
    .map(score);
}

/**
 * Điểm cảm xúc tổng hợp trong [-100, 100]. Tin mới có trọng số cao hơn
 * (bán rã 7 ngày); tin trung lập vẫn được tính để làm loãng điểm.
 */
export function aggregateSentiment(items) {
  if (!items.length) return { score: null, positive: 0, negative: 0, neutral: 0, count: 0 };
  let wsum = 0, total = 0;
  for (const it of items) {
    const ageDays = it.publishedAt ? (Date.now() - it.publishedAt) / DAY : 15;
    const w = Math.pow(0.5, ageDays / 7);
    wsum += w;
    total += w * it.sentiment;
  }
  // Ít tin thì kém tin cậy: co điểm về 0
  const confidence = Math.min(1, items.length / 5);
  return {
    score: Math.round((total / wsum) * 100 * confidence),
    positive: items.filter((i) => i.label === 'tich_cuc').length,
    negative: items.filter((i) => i.label === 'tieu_cuc').length,
    neutral: items.filter((i) => i.label === 'trung_lap').length,
    count: items.length,
  };
}

export { score as scoreNewsItem };
