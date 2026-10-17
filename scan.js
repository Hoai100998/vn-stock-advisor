// Phân tích nhanh từ dòng lệnh, không cần mở web.
//   node scan.js FPT HPG VCB     -> phân tích các mã chỉ định
//   node scan.js                 -> phân tích danh mục theo dõi
//   node scan.js FPT --ai        -> thêm phân tích bằng Gemini
//   node scan.js FPT --bt        -> thêm backtest 3 năm (mặc định chiến lược điểm hệ thống)
//   node scan.js FPT --bt=breakout  (score | ma_cross | rsi_reversion | macd | breakout)
import './src/env.js';
import { analyzeSymbol } from './src/analyze.js';
import { getWatchlist, runAi } from './src/tracker.js';
import { runBacktest, backtestBrief } from './src/backtest.js';

const args = process.argv.slice(2);
const useAi = args.includes('--ai');
const btArg = args.find((s) => s === '--bt' || s.startsWith('--bt='));
const btStrategy = btArg ? (btArg.split('=')[1] || 'score') : null;
const symbols = args.filter((s) => !s.startsWith('--')).map((s) => s.toUpperCase());
const list = symbols.length ? symbols : (await getWatchlist()).map((w) => w.symbol);

for (const sym of list) {
  try {
    const a = await analyzeSymbol(sym, { withChart: false });
    const { scores: s, price: p } = a;
    console.log(`\n=== ${a.symbol} · ${a.info.name} (${a.info.exchange}) ===`);
    console.log(`Giá: ${p.close} (${p.changePct >= 0 ? '+' : ''}${p.changePct}%) ngày ${p.date}`);
    if (a.ranking) {
      console.log(`=> ${a.recommendation.label}  | Điểm xếp hạng ${a.ranking.score}/100 (hạng ${a.ranking.position}/${a.ranking.universe}, ${a.ranking.aboveMa200 === false ? 'dưới' : 'trên'} MA200)`);
      console.log(`   ${a.recommendation.desc}`);
    }
    if (a.brief) {
      const b = a.brief, l = b.levels;
      console.log(`   → ${b.action}`);
      if (b.plays) {
        console.log(`   Nếu CHƯA có:${b.holding ? '' : '  ← bạn'}`);
        for (const x of b.plays.newBuyer) console.log(`     - ${x}`);
        console.log(`   Nếu ĐANG nắm giữ:${b.holding ? '  ← bạn' : ''}${b.plays.position ? ` (${b.plays.position})` : ''}`);
        for (const x of b.plays.holder) console.log(`     - ${x}`);
      }
      for (const r of b.reasons) console.log(`   ${{ up: '▲', down: '▼', ref: '•' }[r.tone]} ${r.text}`);
      if (l) console.log(`   Vùng mua ${l.buyFrom}–${l.buyTo} · cắt lỗ ${l.stop} · mục tiêu ${l.target}${l.weight != null ? ` · tỷ trọng tối đa ${Math.round(l.weight * 100)}%` : ''}`);
      if (b.risks.length) console.log(`   ⚠ ${b.risks.join(' · ')}`);
      console.log('   --- chi tiết ---');
    }
    console.log(`   Điểm kiểu cũ (tham khảo): ${a.legacy?.label ?? a.recommendation.label} | Tổng điểm ${a.total} | Kỹ thuật ${s.technical ?? '-'} · Cơ bản ${s.fundamental ?? '-'} · Tin tức ${s.news ?? '-'} | Độ đồng thuận ${a.recommendation.confidence}%`);
    for (const sig of [...a.technical.signals, ...a.fundamental.signals, ...a.news.signals]) {
      console.log(`   ${sig.points > 0 ? '+' : sig.points < 0 ? '-' : '·'} ${sig.text}`);
    }
    if (a.plan) console.log(`   Hỗ trợ ${a.plan.support} · Kháng cự ${a.plan.resistance} · Cắt lỗ ${a.plan.stopLoss} · Mục tiêu ${a.plan.target}`);
    for (const w of a.warnings) console.log(`   ⚠ ${w}`);

    if (btStrategy && !a.isIndex) {
      try {
        console.log(`   🧪 ${backtestBrief(await runBacktest(sym, { strategy: btStrategy, years: 3 }))}`);
      } catch (err) {
        console.log(`   Backtest lỗi: ${err.message}`);
      }
    }

    if (useAi && !a.isIndex) {
      process.stdout.write('   Gemini đang phân tích…\r');
      try {
        const r = await runAi(sym, { force: true, analysis: a });
        console.log(`\n   --- Gemini (${r.model}): ${r.decisionLabel} · tin cậy ${r.confidence}% · ${r.horizon}`);
        console.log(`   ${r.summary}`);
        console.log(`   Chưa có cổ phiếu: ${r.forNewBuyers}`);
        console.log(`   Đang nắm giữ:     ${r.forHolders}`);
        const lv = [r.entryZone && `Vùng mua ${r.entryZone.from}-${r.entryZone.to}`, r.stopLoss && `Cắt lỗ ${r.stopLoss}`,
          r.targets.length && `Mục tiêu ${r.targets.join(' / ')}`].filter(Boolean).join(' · ');
        if (lv) console.log(`   ${lv}`);
        for (const x of r.bullCase) console.log(`   + ${x}`);
        for (const x of r.bearCase) console.log(`   - ${x}`);
        for (const x of r.watchItems) console.log(`   👁 ${x}`);
      } catch (err) {
        console.log(`\n   Gemini lỗi: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`\n=== ${sym}: lỗi - ${err.message}`);
  }
}
console.log('\nLưu ý: kết quả chỉ mang tính tham khảo, không phải lời khuyên đầu tư.');
