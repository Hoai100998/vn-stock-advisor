// Thông số tool tự điều chỉnh sau khi đối chiếu dự đoán với kết quả thực tế (xem selfreview.js).
// Lưu ở data/tuning.json kèm nhật ký: mỗi thay đổi ghi giá trị cũ/mới, lý do và số liệu làm căn cứ.
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tuning.json');

export const DEFAULTS = {
  widen: 1.12,       // hệ số nới dải giá thống kê (forecast.js)
  minStopAtr: 0,     // cắt lỗ cách giá tối thiểu bấy nhiêu ATR (0 = theo hỗ trợ như cũ)
  aiVeto: true,      // AI không đồng ý thì bỏ mã khỏi danh sách mua
  caution: false,    // gợi ý gần đây thua VN-Index: bớt số mã, thêm cảnh báo
};
// Giới hạn: tự chỉnh không bao giờ vượt ra ngoài khoảng này
export const BOUNDS = { widen: [1, 1.4], minStopAtr: [0, 2] };

let store;
try { store = JSON.parse(readFileSync(FILE, 'utf8')); } catch { store = {}; }
store.params = { ...DEFAULTS, ...(store.params || {}) };
store.log ??= [];

export function getTuning() {
  return store.params;
}

export function tuningLog() {
  return store.log;
}

/** Đổi một thông số (đã kẹp trong BOUNDS) và ghi nhật ký. Trả về bản ghi thay đổi, null nếu không đổi. */
export async function setParam(name, value, reason, evidence = null, date = null) {
  if (!(name in DEFAULTS)) throw new Error(`Thông số không tồn tại: ${name}`);
  if (BOUNDS[name]) value = Math.round(Math.min(BOUNDS[name][1], Math.max(BOUNDS[name][0], value)) * 1000) / 1000;
  const from = store.params[name];
  if (from === value) return null;
  store.params[name] = value;
  const entry = { at: new Date().toISOString(), date, name, from, to: value, reason, evidence };
  store.log.push(entry);
  if (store.log.length > 500) store.log.splice(0, store.log.length - 500);
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store, null, 2), 'utf8');
  return entry;
}
