// Kiểm tra từng API key AI trong file .env:  npm run ai-check
import './src/env.js';
import { providers, testProviders } from './src/llm.js';

const list = providers();
if (!list.length) {
  console.log('Chưa có API key AI nào trong file .env (GEMINI_API_KEY, GEMINI_API_KEYS, MISTRAL_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY…).');
  process.exit(1);
}
console.log(`Thứ tự dự phòng: ${list.map((p) => `${p.label} (${p.model})`).join(' → ')}\nĐang thử từng nhà cung cấp…\n`);
for (const r of await testProviders()) {
  console.log(r.ok ? `  ✓ ${r.provider.padEnd(12)} hoạt động · ${r.model} · ${(r.ms / 1000).toFixed(1)}s` : `  ✗ ${r.provider.padEnd(12)} ${r.error}`);
}
