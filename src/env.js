// Nạp biến môi trường từ file .env ở thư mục gốc (nếu có). Biến đã đặt sẵn trong hệ thống được ưu tiên.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(file)) process.loadEnvFile(file);
