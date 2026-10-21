// Cài đặt bot Telegram: `npm run telegram` lấy chat id; khi đã đủ cấu hình thì gửi thử bản tin.
// `npm run telegram -- open` gửi thử bản tin mở cửa, mặc định là bản tin đóng cửa.
import './src/env.js';
import { telegramConfig, recentChats, sendMessage, sendReport } from './src/telegram.js';

const { token, chatId } = telegramConfig();
if (!token) {
  console.log(`Chưa có TELEGRAM_BOT_TOKEN trong .env. Các bước:
  1. Mở Telegram, tìm @BotFather, gửi /newbot, đặt tên → nhận token dạng 123456:ABC...
  2. Thêm vào file .env:  TELEGRAM_BOT_TOKEN=<token>
  3. Mở bot vừa tạo trên Telegram, bấm Start (hoặc gửi một tin bất kỳ)
  4. Chạy lại: npm run telegram`);
  process.exit(1);
}

try {
  if (!chatId) {
    const chats = await recentChats();
    if (!chats.length) {
      console.log('Token hợp lệ nhưng bot chưa nhận tin nào. Mở bot trên Telegram, bấm Start / gửi "hi", rồi chạy lại lệnh này.');
      process.exit(1);
    }
    console.log('Thêm dòng sau vào .env (chọn đúng cuộc trò chuyện của bạn):');
    for (const c of chats) console.log(`  TELEGRAM_CHAT_ID=${c.id}    # ${c.name} (${c.type})`);
    console.log('Sau đó chạy lại: npm run telegram');
    process.exit(0);
  }
  await sendMessage('✅ Bot VN Stock Advisor đã kết nối. Đang soạn bản tin thử…');
  const kind = process.argv[2] === 'open' ? 'open' : 'close';
  const r = await sendReport(kind);
  console.log(`Đã gửi bản tin ${kind === 'open' ? 'mở cửa' : 'đóng cửa'} (${r.length} ký tự). Khởi động lại app (npm start) để bot tự gửi mỗi ngày.`);
  process.exit(0);
} catch (err) {
  console.error('Lỗi:', err.message);
  process.exit(1);
}
