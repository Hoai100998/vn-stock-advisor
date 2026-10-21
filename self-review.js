// Chạy tự đánh giá ngay và in kết quả: `npm run self-review` (chỉ xem), `npm run self-review -- apply` (áp dụng thay đổi)
import './src/env.js';
import { runSelfReview, formatReview } from './src/selfreview.js';

try {
  const apply = process.argv[2] === 'apply';
  const rv = await runSelfReview({ apply });
  console.log(formatReview(rv).replace(/<\/?[bi]>/g, ''));
  console.log('\nChi tiết:', JSON.stringify({ trades: rv.trades, picks: rv.picks, picks10: rv.picks10, rejected10: rv.rejected10, band: rv.band, tuning: rv.tuning }, null, 2));
  if (!apply && rv.changes.length) console.log('\n(Chế độ xem: chưa áp dụng thay đổi. Thêm "-- apply" để áp dụng.)');
  process.exit(0);
} catch (err) {
  console.error('Lỗi:', err.message);
  process.exit(1);
}
