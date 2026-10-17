// Gọi AI qua nhiều nhà cung cấp, tự chuyển sang nhà cung cấp kế tiếp khi hết hạn mức, quá tải hoặc lỗi.
// Thứ tự mặc định: các key Gemini → Mistral → Groq → OpenRouter → nhà cung cấp tùy chỉnh (chuẩn OpenAI).
// Đặt AI_PROVIDERS trong .env để đổi thứ tự, ví dụ: AI_PROVIDERS=mistral,gemini,groq
// Nhà cung cấp hết hạn mức được "nghỉ" một thời gian rồi mới thử lại, nên các lần gọi sau không phí thời gian.

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (k, d = '') => (process.env[k] ?? d).trim();
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** Danh sách nhà cung cấp đã cấu hình (đọc lại .env mỗi lần để đổi key không cần sửa code). */
export function providers() {
  const out = [];
  const geminiKeys = [...new Set([env('GEMINI_API_KEY'), ...list(env('GEMINI_API_KEYS'))].filter(Boolean))];
  geminiKeys.forEach((key, i) => out.push({
    id: `gemini${i + 1}`, kind: 'gemini', group: 'gemini',
    label: geminiKeys.length > 1 ? `Gemini #${i + 1}` : 'Gemini',
    key, model: env('GEMINI_MODEL', 'gemini-flash-latest'), fallbackModel: env('GEMINI_FALLBACK_MODEL', 'gemini-flash-lite-latest'),
  }));
  if (env('MISTRAL_API_KEY')) {
    out.push({ id: 'mistral', kind: 'openai', group: 'mistral', label: 'Mistral', key: env('MISTRAL_API_KEY'),
      base: 'https://api.mistral.ai/v1', model: env('MISTRAL_MODEL', 'mistral-small-latest') });
  }
  if (env('GROQ_API_KEY')) {
    out.push({ id: 'groq', kind: 'openai', group: 'groq', label: 'Groq', key: env('GROQ_API_KEY'),
      base: 'https://api.groq.com/openai/v1', model: env('GROQ_MODEL', 'llama-3.3-70b-versatile') });
  }
  if (env('OPENROUTER_API_KEY')) {
    const models = list(env('OPENROUTER_MODEL', 'meta-llama/llama-3.3-70b-instruct:free,qwen/qwen3-235b-a22b:free,openai/gpt-oss-120b:free'));
    out.push({ id: 'openrouter', kind: 'openai', group: 'openrouter', label: 'OpenRouter', key: env('OPENROUTER_API_KEY'),
      base: 'https://openrouter.ai/api/v1', model: models[0], models,
      headers: { 'HTTP-Referer': 'http://localhost', 'X-Title': 'VN Stock Advisor' } });
  }
  if (env('CUSTOM_AI_BASE_URL') && env('CUSTOM_AI_MODEL')) {
    out.push({ id: 'custom', kind: 'openai', group: 'custom', label: env('CUSTOM_AI_NAME', 'Tùy chỉnh'), key: env('CUSTOM_AI_API_KEY'),
      base: env('CUSTOM_AI_BASE_URL').replace(/\/$/, ''), model: env('CUSTOM_AI_MODEL') });
  }
  const order = list(env('AI_PROVIDERS').toLowerCase());
  if (order.length) {
    const rank = (p) => { const k = order.indexOf(p.group); return k < 0 ? 99 : k; };
    out.sort((a, b) => rank(a) - rank(b));
    return out.filter((p) => order.includes(p.group));
  }
  return out;
}

// Trạng thái từng nhà cung cấp: nghỉ đến khi nào và lỗi gần nhất
const health = new Map();

function rest(p, ms, reason) {
  health.set(p.id, { until: Date.now() + ms, reason, at: new Date().toISOString() });
  console.warn(`[AI] ${p.label} tạm nghỉ ${Math.round(ms / MIN)} phút: ${reason}`);
}

export function providerStatus() {
  return providers().map((p) => {
    const h = health.get(p.id);
    const resting = h && h.until > Date.now();
    return {
      id: p.id, label: p.label, model: p.model,
      status: resting ? 'resting' : 'ready',
      until: resting ? new Date(h.until).toISOString() : null,
      lastError: h?.reason || null,
    };
  });
}

class AiError extends Error {
  constructor(message, { status = 0, kind = 'other' } = {}) {
    super(message);
    this.status = status;
    this.kind = kind; // quota | auth | model | size | transient | parse | other
  }
}

// Hết hạn mức theo ngày thì nghỉ lâu, theo phút thì nghỉ ngắn
function quotaRest(msg) {
  return /day|daily|ngày|PerDay|per_day/i.test(msg) ? 3 * 60 * MIN : 2 * MIN;
}

function classify(status, msg) {
  if (status === 429 || /quota|rate.?limit|exceeded|exhausted/i.test(msg)) return 'quota';
  if (status === 401 || status === 403 || /api key|unauthorized|invalid.*key/i.test(msg)) return 'auth';
  if (status === 404 || /not found|does not exist|no endpoints/i.test(msg)) return 'model';
  if (status === 413 || /context|too long|too large|maximum.*tokens|reduce the length/i.test(msg)) return 'size';
  if (status >= 500 || status === 408) return 'transient';
  return 'other';
}

// ---------- Gemini ----------

async function callGemini(p, model, prompt, { system, schema, timeout }) {
  let res;
  try {
    res = await fetch(`${GEMINI_API}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: schema },
      }),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new AiError(err.name === 'TimeoutError' ? 'phản hồi quá lâu' : err.message, { kind: 'transient' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    throw new AiError(msg, { status: res.status, kind: res.status === 400 && /API key/i.test(msg) ? 'auth' : classify(res.status, msg) });
  }
  const cand = data.candidates?.[0];
  const text = cand?.content?.parts?.filter((x) => !x.thought).map((x) => x.text || '').join('');
  if (!text) throw new AiError(`không trả kết quả (${cand?.finishReason || data.promptFeedback?.blockReason || 'không rõ'})`, { kind: 'transient' });
  return { json: parseJson(text), usage: data.usageMetadata, model: data.modelVersion || model };
}

// ---------- Chuẩn OpenAI (Mistral, Groq, OpenRouter, tùy chỉnh) ----------

/** Đổi schema kiểu Gemini (OBJECT, STRING…) sang JSON Schema thường để mô tả trong prompt. */
export function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'propertyOrdering') continue;
    if (k === 'type') out.type = String(v).toLowerCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    else if (k === 'items') out.items = toJsonSchema(v);
    else out[k] = v;
  }
  return out;
}

/** Đọc JSON từ câu trả lời, chấp nhận khối ```json … ``` hoặc chữ thừa trước/sau. */
export function parseJson(text) {
  const t = String(text).replace(/^﻿/, '').trim();
  try { return JSON.parse(t); } catch { /* thử cách khác */ }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* tiếp */ } }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* tiếp */ } }
  throw new AiError('câu trả lời không phải JSON hợp lệ', { kind: 'parse' });
}

async function callOpenAI(p, prompt, { system, schema, timeout }) {
  const schemaText = JSON.stringify(toJsonSchema(schema));
  const sys = `${system}\n\nĐỊNH DẠNG TRẢ LỜI: chỉ trả về MỘT đối tượng JSON hợp lệ (json), không kèm chữ nào khác, `
    + `đủ mọi trường trong "required", giá trị "enum" phải đúng chính tả. JSON Schema:\n${schemaText}`;
  const body = {
    model: p.model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  };
  if (p.models?.length > 1) body.models = p.models; // OpenRouter tự thử model kế tiếp
  let res;
  try {
    res = await fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}), ...(p.headers || {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new AiError(err.name === 'TimeoutError' ? 'phản hồi quá lâu' : err.message, { kind: 'transient' });
  }
  const data = await res.json().catch(() => ({}));
  const errMsg = data.error?.message || data.message || data.detail || '';
  if (!res.ok || data.error) {
    const msg = typeof errMsg === 'string' && errMsg ? errMsg : `HTTP ${res.status}`;
    throw new AiError(msg, { status: res.status, kind: classify(res.status, msg) });
  }
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new AiError(`không trả kết quả (${data.choices?.[0]?.finish_reason || 'không rõ'})`, { kind: 'transient' });
  return {
    json: parseJson(text),
    usage: data.usage ? { totalTokenCount: data.usage.total_tokens } : null,
    model: data.model || p.model,
  };
}

// ---------- Chuỗi dự phòng ----------

async function tryProvider(p, prompt, opts) {
  if (p.kind === 'gemini') {
    // Model chính: thử lại khi quá tải; hết hạn mức thì chuyển sang model nhẹ (hạn mức riêng) cùng key
    let lastErr;
    for (const delay of [0, 3000]) {
      if (delay) await sleep(delay);
      try { return await callGemini(p, p.model, prompt, opts); } catch (err) {
        lastErr = err;
        if (err.kind !== 'transient' || /quá lâu/.test(err.message)) break;
      }
    }
    if (p.fallbackModel && p.fallbackModel !== p.model && ['quota', 'transient', 'model'].includes(lastErr.kind)) {
      return await callGemini(p, p.fallbackModel, prompt, opts);
    }
    throw lastErr;
  }
  try {
    return await callOpenAI(p, prompt, opts);
  } catch (err) {
    if (err.kind !== 'transient' && err.kind !== 'parse') throw err;
    await sleep(2000);
    return await callOpenAI(p, prompt, opts);
  }
}

const ERR_TEXT = {
  quota: 'hết hạn mức', auth: 'API key không hợp lệ', model: 'không có model', size: 'dữ liệu quá dài với model này',
  transient: 'quá tải/lỗi tạm thời', parse: 'trả sai định dạng', other: 'lỗi',
};

/**
 * Gửi prompt và nhận JSON theo schema. Thử lần lượt từng nhà cung cấp còn sẵn sàng.
 * @returns {Promise<{ json: object, usage: object|null, model: string, provider: string }>}
 */
export async function generateJson(prompt, { system, schema, timeout = 180_000 } = {}) {
  const all = providers();
  if (!all.length) throw new Error('Chưa cấu hình API key AI nào (GEMINI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY…). Xem hướng dẫn trong README.md');
  const ready = all.filter((p) => !(health.get(p.id)?.until > Date.now()));
  // Tất cả đang nghỉ: vẫn thử nhà cung cấp sắp hết thời gian nghỉ nhất
  const queue = ready.length ? ready : [...all].sort((a, b) => health.get(a.id).until - health.get(b.id).until).slice(0, 1);
  const errors = [];
  for (const p of queue) {
    try {
      const r = await tryProvider(p, prompt, { system, schema, timeout });
      health.delete(p.id);
      return { ...r, provider: p.label, model: `${p.label} · ${r.model}` };
    } catch (err) {
      const kind = err.kind || 'other';
      errors.push(`${p.label}: ${ERR_TEXT[kind]}${kind === 'other' || kind === 'model' ? ` (${String(err.message).slice(0, 120)})` : ''}`);
      if (kind === 'quota') rest(p, quotaRest(err.message), err.message.slice(0, 160));
      else if (kind === 'auth' || kind === 'model') rest(p, 60 * MIN, err.message.slice(0, 160));
      else if (kind === 'transient') rest(p, 3 * MIN, err.message.slice(0, 160));
      // 'size' / 'parse': không cho nghỉ, prompt khác có thể vẫn chạy được
    }
  }
  const allQuota = errors.every((e) => /hết hạn mức/.test(e));
  throw new Error(`${allQuota ? 'Tất cả nhà cung cấp AI đã hết hạn mức' : 'Không nhà cung cấp AI nào trả lời được'}: ${errors.join('; ')}`);
}

/** Gửi một yêu cầu nhỏ tới từng nhà cung cấp để kiểm tra key (không đổi trạng thái nghỉ). */
export async function testProviders() {
  const schema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' }, msg: { type: 'STRING' } }, required: ['ok', 'msg'] };
  const opts = { system: 'Bạn là trợ lý kiểm tra kết nối.', schema, timeout: 60_000 };
  return Promise.all(providers().map(async (p) => {
    const started = Date.now();
    try {
      const r = p.kind === 'gemini'
        ? await callGemini(p, p.model, 'Trả về {"ok": true, "msg": "xin chào"}', opts)
        : await callOpenAI(p, 'Trả về {"ok": true, "msg": "xin chào"}', opts);
      return { provider: p.label, model: r.model, ok: true, ms: Date.now() - started };
    } catch (err) {
      return { provider: p.label, model: p.model, ok: false, error: `${ERR_TEXT[err.kind] || 'lỗi'}: ${String(err.message).slice(0, 200)}` };
    }
  }));
}
