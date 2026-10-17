import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateJson, parseJson, toJsonSchema, providers, providerStatus } from '../src/llm.js';

const schema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' }, list: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['ok'], propertyOrdering: ['ok'] };
const KEYS = ['GEMINI_API_KEY', 'GEMINI_API_KEYS', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'CUSTOM_AI_BASE_URL', 'CUSTOM_AI_MODEL', 'AI_PROVIDERS'];
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const geminiOk = (text) => reply(200, { candidates: [{ content: { parts: [{ text }] } }], modelVersion: 'gemini-test' });
const openaiOk = (text) => reply(200, { choices: [{ message: { content: text } }], model: 'mistral-test', usage: { total_tokens: 42 } });

let n = 0;
beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  n++;
});

test('parseJson chấp nhận khối ```json và chữ thừa', () => {
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJson('Đây là kết quả: {"a":2} xong'), { a: 2 });
  assert.throws(() => parseJson('không có json'));
});

test('toJsonSchema đổi kiểu Gemini sang JSON Schema', () => {
  const s = toJsonSchema(schema);
  assert.equal(s.type, 'object');
  assert.equal(s.properties.list.items.type, 'string');
  assert.equal(s.propertyOrdering, undefined);
});

test('Thứ tự nhà cung cấp và AI_PROVIDERS', () => {
  process.env.GEMINI_API_KEY = 'g1';
  process.env.GEMINI_API_KEYS = 'g2, g1';
  process.env.MISTRAL_API_KEY = 'm';
  process.env.GROQ_API_KEY = 'q';
  assert.deepEqual(providers().map((p) => p.id), ['gemini1', 'gemini2', 'mistral', 'groq']);
  process.env.AI_PROVIDERS = 'groq,gemini';
  assert.deepEqual(providers().map((p) => p.id), ['groq', 'gemini1', 'gemini2']);
});

test('Gemini hết hạn mức → thử model nhẹ → chuyển sang Mistral, rồi lần sau bỏ qua Gemini đang nghỉ', async () => {
  process.env.GEMINI_API_KEY = `key-${n}`;
  process.env.MISTRAL_API_KEY = 'm';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('generativelanguage')) return reply(429, { error: { message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 250 PerDay' } });
    assert.equal(JSON.parse(init.body).response_format.type, 'json_object');
    return openaiOk('{"ok": true}');
  };
  const r = await generateJson('xin chào', { system: 's', schema });
  assert.deepEqual(r.json, { ok: true });
  assert.equal(r.provider, 'Mistral');
  assert.equal(calls.filter((u) => u.includes('generativelanguage')).length, 2); // model chính + model nhẹ
  assert.equal(providerStatus().find((p) => p.id === 'gemini1').status, 'resting');

  calls.length = 0;
  await generateJson('lần 2', { system: 's', schema });
  assert.equal(calls.some((u) => u.includes('generativelanguage')), false);
});

test('Key sai bị bỏ qua, lỗi tổng hợp khi mọi nhà cung cấp đều hết hạn mức', async () => {
  process.env.GROQ_API_KEY = 'q';
  process.env.OPENROUTER_API_KEY = 'o';
  process.env.AI_PROVIDERS = 'groq,openrouter';
  globalThis.fetch = async (url) => (String(url).includes('groq')
    ? reply(401, { error: { message: 'Invalid API Key' } })
    : reply(200, { choices: [{ message: { content: '```json\n{"ok": false}\n```' } }] }));
  const r = await generateJson('x', { system: 's', schema });
  assert.equal(r.provider, 'OpenRouter');
  assert.deepEqual(r.json, { ok: false });
});

test('Gemini trả JSON bình thường', async () => {
  process.env.GEMINI_API_KEY = `fresh-${n}`;
  process.env.AI_PROVIDERS = 'gemini';
  globalThis.fetch = async () => geminiOk('{"ok": true, "list": ["a"]}');
  const r = await generateJson('x', { system: 's', schema });
  assert.match(r.model, /^Gemini · gemini-test/);
});
