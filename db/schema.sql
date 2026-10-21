-- Database phân tích của VN Stock Advisor. App tự chạy file này khi khởi động (an toàn khi chạy lại).
-- Dữ liệu gốc vẫn nằm trong data/*.json; database giữ bản sao đầy đủ và MỌI phiên bản (file JSON chỉ giữ bản mới nhất).

-- Thị trường mỗi phiên (từ ảnh chụp cuối ngày)
CREATE TABLE IF NOT EXISTS market_daily (
  date         date PRIMARY KEY,
  close        numeric,
  change_pct   numeric,
  trend        text,
  ma50         numeric,
  ma200        numeric,
  above_ma200  boolean,
  return_20d   numeric,
  universe     int,
  raw          jsonb
);

-- Toàn bộ rổ cổ phiếu mỗi phiên: điểm xếp hạng, điểm cũ, khối ngoại, chỉ số tài chính tại thời điểm đó
CREATE TABLE IF NOT EXISTS stock_daily (
  date              date,
  symbol            text,
  close             numeric,
  value20           numeric,
  rank_score        int,
  above_ma200       boolean,
  rank_rec          text,
  tech_score        int,
  fund_score        int,
  legacy_total      int,
  legacy_rec        text,
  f_mom             numeric,
  f_high            numeric,
  f_atr             numeric,
  f_adx             numeric,
  foreign_net1      numeric,
  foreign_net5      numeric,
  foreign_net20     numeric,
  foreign_ratio20   numeric,
  pe                numeric,
  pb                numeric,
  roe               numeric,
  eps_ttm           numeric,
  profit_growth_ttm numeric,
  revenue_growth_ttm numeric,
  debt_to_equity    numeric,
  dividend_yield    numeric,
  report_date       date,
  raw               jsonb,
  PRIMARY KEY (date, symbol)
);

-- Giá ngày (OHLCV) của rổ + VNINDEX, dùng để chấm dự đoán ngay trong SQL
CREATE TABLE IF NOT EXISTS daily_bars (
  symbol  text,
  date    date,
  open    numeric,
  high    numeric,
  low     numeric,
  close   numeric,
  volume  numeric,
  PRIMARY KEY (symbol, date)
);

-- Nhật ký dự đoán (mọi nguồn: xếp hạng, hệ thống, AI, hội đồng, quyết định cuối, cổ phiếu tiềm năng)
CREATE TABLE IF NOT EXISTS predictions (
  source       text,
  symbol       text,
  date         date,
  direction    smallint,
  label        text,
  price        numeric,
  detail       text,
  recorded_at  timestamptz,
  PRIMARY KEY (source, symbol, date)
);

-- Mỗi lần AI (Gemini…) phân tích một mã: giữ tất cả phiên bản
CREATE TABLE IF NOT EXISTS ai_analyses (
  symbol          text,
  created_at      timestamptz,
  price_date      date,
  price           numeric,
  model           text,
  decision        text,
  decision_label  text,
  confidence      int,
  final_code      text,
  final_label     text,
  final_relation  text,
  forecast        jsonb,
  raw             jsonb,
  PRIMARY KEY (symbol, created_at)
);

-- Mỗi lần hội đồng đầu tư họp
CREATE TABLE IF NOT EXISTS committee_runs (
  symbol      text,
  created_at  timestamptz,
  price_date  date,
  price       numeric,
  model       text,
  decision    text,
  final_code  text,
  final_label text,
  raw         jsonb,
  PRIMARY KEY (symbol, created_at)
);

-- Kịch bản giá AI (5/10/20 phiên) và dải thống kê 5–95% lúc dự báo
CREATE TABLE IF NOT EXISTS forecasts (
  symbol       text,
  date         date,
  close        numeric,
  source       text,
  recorded_at  timestamptz,
  scenarios    jsonb,
  expected     jsonb,
  band         jsonb,
  PRIMARY KEY (symbol, date)
);

-- Phe mua / phe bán chủ động cả phiên
CREATE TABLE IF NOT EXISTS order_flow (
  symbol          text,
  date            date,
  buy             numeric,
  sell            numeric,
  auction         numeric,
  big_buy         numeric,
  big_sell        numeric,
  big_buy_count   int,
  big_sell_count  int,
  ticks           int,
  buy_ratio       numeric,
  big_buy_ratio   numeric,
  captured_at     timestamptz,
  PRIMARY KEY (symbol, date)
);

-- Mỗi lần quét cổ phiếu tiềm năng
CREATE TABLE IF NOT EXISTS screener_runs (
  created_at  timestamptz PRIMARY KEY,
  date        date,
  candidates  jsonb,
  raw         jsonb
);

-- Bản tin Telegram đã gửi
CREATE TABLE IF NOT EXISTS telegram_reports (
  id          bigserial PRIMARY KEY,
  sent_at     timestamptz DEFAULT now(),
  kind        text,
  text        text,
  unverified  text[]
);

-- Cảnh báo trong phiên
CREATE TABLE IF NOT EXISTS alerts (
  id       text PRIMARY KEY,
  time     timestamptz,
  symbol   text,
  type     text,
  message  text
);

-- Giao dịch thật trong Danh mục (bản sao đúng như file, kể cả khi xóa)
CREATE TABLE IF NOT EXISTS portfolio_transactions (
  id      text PRIMARY KEY,
  seq     int,
  type    text,
  symbol  text,
  qty     numeric,
  price   numeric,
  date    date,
  note    text
);

-- Gợi ý mua đã gửi Telegram (pick) và mã AI loại (rejected), để tự đánh giá
CREATE TABLE IF NOT EXISTS trades (
  symbol      text,
  date        date,
  status      text,
  code        text,
  entry       numeric,
  stop        numeric,
  target      numeric,
  buy_from    numeric,
  buy_to      numeric,
  recorded_at timestamptz,
  PRIMARY KEY (symbol, date)
);

-- Mỗi lần tự đánh giá
CREATE TABLE IF NOT EXISTS self_reviews (
  date    date,
  at      timestamptz PRIMARY KEY,
  raw     jsonb
);

-- Nhật ký tự chỉnh thông số
CREATE TABLE IF NOT EXISTS tuning_log (
  at        timestamptz PRIMARY KEY,
  date      date,
  name      text,
  from_val  jsonb,
  to_val    jsonb,
  reason    text,
  evidence  jsonb
);

-- Chấm dự đoán: lợi suất sau 5 / 10 / 20 phiên so với VN-Index (NULL khi chưa đủ phiên)
CREATE OR REPLACE VIEW prediction_scores AS
WITH b AS (
  SELECT symbol, date, close, row_number() OVER (PARTITION BY symbol ORDER BY date) AS n FROM daily_bars
), p AS (
  SELECT pr.*, b.n FROM predictions pr JOIN b ON b.symbol = pr.symbol AND b.date = pr.date
), i AS (
  SELECT date, close, n FROM b WHERE symbol = 'VNINDEX'
)
SELECT p.source, p.symbol, p.date, p.direction, p.label, p.price,
  h.h AS horizon,
  f.close / b0.close - 1 AS ret,
  (f.close / b0.close - 1) - (i1.close / i0.close - 1) AS excess,
  CASE WHEN p.direction = 0 THEN NULL ELSE sign(f.close - b0.close) = p.direction END AS correct
FROM p
CROSS JOIN (VALUES (5), (10), (20)) AS h(h)
JOIN b b0 ON b0.symbol = p.symbol AND b0.n = p.n
JOIN b f  ON f.symbol = p.symbol AND f.n = p.n + h.h
LEFT JOIN i i0 ON i0.date = p.date
LEFT JOIN i i1 ON i1.n = i0.n + h.h;

-- Tổng hợp độ chính xác theo nguồn và khung thời gian
CREATE OR REPLACE VIEW prediction_accuracy AS
SELECT source, horizon,
  count(*) FILTER (WHERE direction <> 0) AS evaluated,
  round(avg(CASE WHEN correct THEN 1 ELSE 0 END) FILTER (WHERE direction <> 0)::numeric, 3) AS hit_rate,
  round(avg(ret) FILTER (WHERE direction > 0)::numeric, 4) AS buy_avg_return,
  round(avg(excess) FILTER (WHERE direction > 0)::numeric, 4) AS buy_avg_excess,
  round(avg(ret) FILTER (WHERE direction < 0)::numeric, 4) AS sell_avg_return,
  -- Tín hiệu là so với thị trường: mua đúng khi hơn VN-Index, tránh/bán đúng khi kém VN-Index
  round(avg(CASE WHEN sign(excess) = direction THEN 1 ELSE 0 END) FILTER (WHERE direction <> 0 AND excess IS NOT NULL)::numeric, 3) AS beat_index_rate,
  round(avg(excess) FILTER (WHERE direction < 0)::numeric, 4) AS sell_avg_excess
FROM prediction_scores
GROUP BY source, horizon
ORDER BY source, horizon;

-- Nhãn AI lọc tin (src/newsai.js): để đối chiếu với chấm từ khóa và phản ứng giá sau tin
CREATE TABLE IF NOT EXISTS news_labels (
  symbol   text NOT NULL,
  link     text NOT NULL,
  relevant boolean,
  label    text,
  risk     boolean,
  reason   text,
  at       timestamptz,
  PRIMARY KEY (symbol, link)
);

-- Ảnh chụp trong phiên (src/intraday.js, mỗi 15 phút giờ giao dịch): toàn thị trường + toàn bộ rổ cổ phiếu
CREATE TABLE IF NOT EXISTS market_intraday (
  ts          timestamptz PRIMARY KEY,
  date        date,
  vnindex     numeric,
  change_pct  numeric,
  advancers   int,
  decliners   int,
  unchanged   int,
  value       numeric,
  foreign_net numeric
);

CREATE TABLE IF NOT EXISTS stock_intraday (
  ts          timestamptz,
  date        date,
  symbol      text,
  price       numeric,
  change_pct  numeric,
  rank_score  int,
  above_ma200 boolean,
  PRIMARY KEY (ts, symbol)
);
CREATE INDEX IF NOT EXISTS stock_intraday_sym ON stock_intraday (symbol, date);

-- Kết quả chẩn đoán dự đoán mỗi ngày (src/diagnose.js)
CREATE TABLE IF NOT EXISTS diagnostics (
  date  date PRIMARY KEY,
  at    timestamptz,
  raw   jsonb
);

ALTER TABLE news_labels ADD COLUMN IF NOT EXISTS published_at timestamptz;
