// Kiểm tra dữ liệu trước khi phân tích / đưa cho AI: giá có cập nhật tới phiên mới nhất không, nến tạm (chưa khớp),
// biến động vượt biên độ sàn (thường do chia tách / cổ tức chưa điều chỉnh làm sai chỉ báo), số liệu cơ bản quá cũ.
// Lỗi "critical" thì không dùng mã đó để gợi ý mua (bản tin, radar).

// Biên độ ngày theo sàn (+1 điểm % dung sai làm tròn bước giá)
const BAND = { HOSE: 0.07, HNX: 0.1, UPCOM: 0.15 };
const FUND_MAX_DAYS = 200; // quá ~2 quý chưa có báo cáo mới

/**
 * @param {{ time: string, open: number, high: number, low: number, close: number, volume: number }[]} bars
 * @param {{ indexDate?: string, exchange?: string, fundReportDate?: string|null, now?: Date, lookback?: number }} opts
 * @returns {{ ok: boolean, critical: boolean, issues: { level: 'critical'|'warn', code: string, text: string }[] }}
 */
export function checkDataQuality(bars, { indexDate = null, exchange = 'HOSE', fundReportDate = null, now = new Date(), lookback = 20 } = {}) {
  const issues = [];
  const add = (level, code, text) => issues.push({ level, code, text });
  const last = bars?.at(-1);
  if (!last) return { ok: false, critical: true, issues: [{ level: 'critical', code: 'no_data', text: 'Không có dữ liệu giá' }] };

  if (indexDate && last.time < indexDate) {
    add('critical', 'stale', `Giá chỉ cập nhật tới ${last.time}, thị trường đã có phiên ${indexDate} (mã bị ngừng giao dịch hoặc nguồn dữ liệu trễ)`);
  }
  if (!last.volume) add('critical', 'no_volume', `Phiên ${last.time} chưa có khớp lệnh (giá có thể là giá tham chiếu, chưa phải giá thật)`);

  const band = (BAND[exchange] ?? BAND.HOSE) + 0.01;
  const from = Math.max(1, bars.length - lookback);
  for (let i = from; i < bars.length; i++) {
    const chg = bars[i].close / bars[i - 1].close - 1;
    if (Math.abs(chg) > band) {
      add('warn', 'jump', `Phiên ${bars[i].time} giá ${chg > 0 ? 'tăng' : 'giảm'} ${(chg * 100).toFixed(1)}%, vượt biên độ ${exchange}: có thể do chia tách/cổ tức chưa điều chỉnh, các chỉ báo gần đây có thể sai`);
      break;
    }
  }
  if (fundReportDate) {
    const age = (now - Date.parse(fundReportDate)) / 86_400_000;
    if (age > FUND_MAX_DAYS) add('warn', 'old_fund', `Số liệu cơ bản lấy từ báo cáo ${fundReportDate} (${Math.round(age)} ngày trước), có thể đã cũ`);
  }
  const critical = issues.some((x) => x.level === 'critical');
  return { ok: !issues.length, critical, issues };
}
