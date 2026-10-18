import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasDiacritics } from '../src/ai.js';

test('Nhận ra tiếng Việt không dấu để yêu cầu AI viết lại', () => {
  assert.equal(hasDiacritics('DHC co nen tang co ban xuat sac voi Q2/2026 tang truong 114%, dinh gia re voi P/E 7.15'), false);
  assert.equal(hasDiacritics('DHC có nền tảng cơ bản xuất sắc với Q2/2026 tăng trưởng 114%, định giá rẻ với P/E 7,15'), true);
  assert.equal(hasDiacritics('Ngắn'), true); // quá ngắn: không kết luận
});
