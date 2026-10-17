// Tiện ích gọi HTTP: timeout, thử lại, cache trong bộ nhớ.

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  // VNDirect trả 406 nếu chỉ gửi "application/json"
  Accept: '*/*',
  'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
};

export async function fetchText(url, { timeout = 15000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status} khi gọi ${new URL(url).host}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

const store = new Map();

export function uncache(key) {
  store.delete(key);
}

// Ghi nhớ kết quả của fn() theo key trong ttlMs. Lưu cả promise đang chạy để
// nhiều request đồng thời không gọi API trùng lặp.
export function cached(key, ttlMs, fn) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = Promise.resolve().then(fn);
  store.set(key, { value, expires: Date.now() + ttlMs });
  value.catch(() => store.delete(key));
  return value;
}
