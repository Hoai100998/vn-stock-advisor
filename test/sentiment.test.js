import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSentiment } from '../src/sentiment.js';

const label = (t) => analyzeSentiment(t).label;

test('tin tích cực rõ ràng', () => {
  assert.equal(label('HPG báo lãi kỷ lục, vượt kế hoạch năm'), 'tich_cuc');
  assert.equal(label('Khối ngoại mua ròng mạnh cổ phiếu VCB'), 'tich_cuc');
});

test('tin tiêu cực rõ ràng', () => {
  assert.equal(label('Cổ phiếu FPT tiếp đà lao dốc, vốn hóa bốc hơi'), 'tieu_cuc');
  assert.equal(label('Khởi tố lãnh đạo doanh nghiệp, cổ phiếu giảm sàn'), 'tieu_cuc');
});

test('cụm dài được ưu tiên hơn từ con', () => {
  // "giảm lỗ" là tích cực, không bị tính thành "giảm" + "lỗ"
  assert.equal(label('Doanh nghiệp giảm lỗ trong quý 3'), 'tich_cuc');
  assert.equal(label('Lợi nhuận giảm so với cùng kỳ'), 'tieu_cuc');
});

test('không khớp nhầm trong từ khác', () => {
  // "lỗi" không phải "lỗ"; "lãi suất" không phải "lãi"
  assert.equal(analyzeSentiment('Sửa lỗi hệ thống giao dịch').hits.length, 0);
  assert.equal(analyzeSentiment('Ngân hàng công bố lãi suất huy động').hits.length, 0);
});

test('xử lý phủ định', () => {
  assert.equal(label('3 tuần không thấy màu xanh'), 'tieu_cuc');
  assert.equal(label('Cổ phiếu ngắt chuỗi giảm điểm'), 'tich_cuc');
  // Phủ định không lan qua dấu phẩy
  assert.equal(label('Không có gì bất ngờ, lãi tăng mạnh'), 'tich_cuc');
});

test('tin trung lập', () => {
  assert.equal(label('FPT khởi công tòa nhà công nghệ ở Hà Nội'), 'trung_lap');
  assert.equal(analyzeSentiment('').score, 0);
});
