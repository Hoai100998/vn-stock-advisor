// Chấm điểm cảm xúc tin tức tiếng Việt bằng từ điển từ khóa.
// Cụm từ dài được khớp trước và "tiêu thụ" đoạn văn bản đó, nên "giảm lỗ"
// không bị tính thêm một lần nữa là "lỗ".

const POSITIVE = {
  3: [
    'lãi kỷ lục', 'lợi nhuận kỷ lục', 'doanh thu kỷ lục', 'vượt kế hoạch', 'vượt kế hoạch năm',
    'khuyến nghị mua', 'khả quan', 'tăng trần', 'kịch trần', 'mua ròng mạnh', 'lập đỉnh',
    'vượt đỉnh', 'lãi tăng', 'lợi nhuận tăng', 'lãi đột biến', 'chuyển lỗ thành lãi', 'có lãi trở lại',
    'nâng hạng', 'trúng thầu', 'ký hợp đồng', 'tăng trưởng mạnh', 'bứt phá',
  ],
  2: [
    'tăng trưởng', 'tăng mạnh', 'mua ròng', 'khối ngoại mua', 'cổ tức', 'chia cổ tức',
    'cổ phiếu thưởng', 'thưởng cổ phiếu', 'mua lại cổ phiếu', 'cổ phiếu quỹ', 'triển vọng',
    'hưởng lợi', 'phục hồi', 'tích cực', 'giảm lỗ', 'giảm nợ', 'hoàn thành kế hoạch', 'mở rộng',
    'đơn hàng', 'hợp đồng lớn', 'vượt', 'kỷ lục', 'lãi lớn', 'lãi ròng', 'đột phá', 'tăng vốn',
    'dòng tiền đổ vào', 'hút dòng tiền', 'outperform', 'đầu tư mới', 'nâng mục tiêu', 'giá mục tiêu',
    'gom mạnh', 'gom ròng', 'ngắt chuỗi giảm',
  ],
  1: [
    'tăng', 'lãi', 'đi lên', 'hồi phục', 'tăng điểm', 'xanh', 'ổn định', 'hấp dẫn', 'tiềm năng',
    'cơ hội', 'thuận lợi', 'thắng', 'hợp tác', 'kỳ vọng', 'cải thiện', 'nới lỏng', 'hỗ trợ',
    'gom', 'bắt đáy', 'khai trương',
  ],
};

const NEGATIVE = {
  3: [
    'thua lỗ', 'lỗ nặng', 'lỗ kỷ lục', 'lỗ ròng', 'báo lỗ', 'lãi giảm', 'lợi nhuận giảm', 'giảm sàn',
    'nằm sàn', 'giá sàn', 'khởi tố', 'bắt giam', 'bị bắt', 'hủy niêm yết', 'đình chỉ giao dịch',
    'điều tra', 'lừa đảo', 'thao túng', 'phá sản', 'giải chấp', 'call margin', 'bán tháo',
    'lao dốc', 'sập', 'vỡ nợ', 'chậm trả', 'không trả được', 'khuyến nghị bán', 'kém khả quan',
    'diện cảnh báo', 'diện kiểm soát', 'hạn chế giao dịch', 'mất thanh khoản',
  ],
  2: [
    'giảm mạnh', 'sụt giảm', 'bán ròng', 'khối ngoại bán', 'xử phạt', 'bị phạt', 'vi phạm',
    'nợ xấu', 'cảnh báo', 'tiêu cực', 'rủi ro', 'áp lực bán', 'áp lực', 'không đạt', 'hụt',
    'trượt', 'suy giảm', 'tụt', 'bốc hơi', 'thoái vốn', 'bán ra', 'thận trọng', 'u ám', 'lỗ',
    'đi xuống', 'thủng đáy', 'đáy mới', 'thấp nhất', 'nợ vay tăng', 'ế', 'tồn kho tăng',
    'underperform', 'hạ mục tiêu', 'liên tiếp giảm', 'giảm liên tiếp', 'tiếp đà giảm', 'về đáy',
    'bĩ cực', 'chuỗi giảm',
  ],
  1: [
    'giảm', 'đỏ', 'điều chỉnh', 'lo ngại', 'khó khăn', 'thách thức', 'chậm lại', 'bất lợi',
    'lùi', 'đi ngang', 'biến động mạnh', 'căng thẳng', 'bất ổn', 'trì hoãn', 'vùng đáy', 'rơi',
  ],
};

// Cụm trung tính: chỉ để chặn từ con bị khớp nhầm ("lãi suất" không phải "lãi")
const NEUTRAL = ['lãi suất', 'lãi vay', 'tỷ giá', 'giá trị giao dịch', 'xanh lá'];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Danh sách (cụm từ, trọng số) sắp xếp theo độ dài giảm dần
const LEXICON = [
  ...Object.entries(POSITIVE).flatMap(([w, list]) => list.map((p) => [p, Number(w)])),
  ...Object.entries(NEGATIVE).flatMap(([w, list]) => list.map((p) => [p, -Number(w)])),
  ...NEUTRAL.map((p) => [p, 0]),
]
  .sort((a, b) => b[0].length - a[0].length)
  // Biên chữ Unicode: không để "lỗ" khớp trong "lỗi", "tăng" khớp trong "tăngg"...
  .map(([phrase, weight]) => ({
    phrase,
    weight,
    re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(phrase)}(?![\\p{L}\\p{N}])`, 'gu'),
  }));

// Từ phủ định trong 3 từ đứng trước cụm khớp (cùng mệnh đề) sẽ đảo dấu
// ("không thấy màu xanh")
const NEGATION_RE = /(?<![\p{L}\p{N}])(không|chưa|chẳng|chả|ngừng|hết|ngắt|chấm dứt)(?![\p{L}\p{N}])/u;

function isNegated(before) {
  const clause = before.split(/[,.;:!?|"“”]/).pop();
  const words = clause.trim().split(/\s+/).slice(-3).join(' ');
  return NEGATION_RE.test(words);
}

export function normalize(text) {
  return String(text || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * @returns {{ score: number, label: 'tich_cuc'|'tieu_cuc'|'trung_lap', hits: {phrase:string, weight:number}[] }}
 * score nằm trong [-1, 1].
 */
export function analyzeSentiment(text) {
  let s = normalize(text);
  const hits = [];
  let raw = 0;
  for (const { phrase, weight, re } of LEXICON) {
    re.lastIndex = 0;
    if (!re.test(s)) continue;
    re.lastIndex = 0;
    s = s.replace(re, (m, offset, str) => {
      const w = isNegated(str.slice(Math.max(0, offset - 40), offset)) ? -weight : weight;
      if (w !== 0) hits.push({ phrase, weight: w });
      raw += w;
      // Tiêu thụ đoạn đã khớp. Dùng dấu câu để chặn phủ định lan sang cụm sau
      return ' , ';
    });
  }
  // Ép về [-1, 1]; 4 điểm thô ≈ 0,76
  const score = Math.tanh(raw / 4);
  const label = score > 0.15 ? 'tich_cuc' : score < -0.15 ? 'tieu_cuc' : 'trung_lap';
  return { score, label, hits };
}
