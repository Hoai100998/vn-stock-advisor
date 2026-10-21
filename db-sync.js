// Đồng bộ dữ liệu sang PostgreSQL ngay và in số dòng từng bảng: `npm run db-sync`
import './src/env.js';
import { syncAll, query, dbConfig } from './src/db.js';

if (!dbConfig().enabled) {
  console.log('Chưa cấu hình database: chạy `docker compose up -d` và đặt DB_PASSWORD trong .env');
  process.exit(1);
}
try {
  const t0 = Date.now();
  console.log('Kết quả đồng bộ:', await syncAll(), `(${Math.round((Date.now() - t0) / 1000)} giây)`);
  const tables = await query(`SELECT table_name AS bang FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
  const rows = [];
  for (const { bang } of tables.rows) rows.push({ bang, so_dong: Number((await query(`SELECT count(*) AS n FROM ${bang}`)).rows[0].n) });
  console.table(rows);
  process.exit(0);
} catch (err) {
  console.error('Lỗi:', err.message);
  process.exit(1);
}
