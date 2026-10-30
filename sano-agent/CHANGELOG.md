# 📜 Lịch sử phiên bản — Sano Agent

Mọi thay đổi đáng chú ý của Sano Agent, app SANO trên máy tính. Bản cài của từng phiên bản có ở trang tải về [sano-agent-releases](https://github.com/JameSteven404/sano-agent-releases/releases). Khu Canvas là SanoVids: thay đổi của nó trước bản 1.0.0 ghi trong [CHANGELOG của SanoVids](../CHANGELOG.md).

Ký hiệu: ✨ thêm mới · 🛠️ thay đổi · 🐞 sửa lỗi · ⚠️ lưu ý

---

## [1.1.0-beta.1] — 2026-10-30 — Bản thử nội bộ: tài khoản SANO và máy chủ chung

Bản thử cho đợt thử nội bộ M1: chỉ đưa thẳng cho người thử, không đăng lên trang tải về.

✨ **Tài khoản SANO và máy chủ chung**
- Đăng nhập ngay trong app bằng tên đăng nhập và mật khẩu, trên máy chủ `https://sa.sanogroup.tv`.
- Ba cách có tài khoản: tự đăng ký rồi chờ QTV duyệt; QTV tạo sẵn với mật khẩu tạm (lần đầu phải đổi); hoặc Tiếp tục với Google khi máy chủ đã bật Google.
- QTV có màn **Thành viên & vai trò** để duyệt, tạo, đặt lại mật khẩu và gán team.

✨ **Chỉ còn các màn chạy thật**
- Khi đăng nhập bằng tài khoản thật, menu chỉ còn Chat kiến thức, Tài liệu, Canvas, và Thành viên & vai trò cho QTV.
- **Chat kiến thức** tra cứu các nguồn đã duyệt. Đợt này chưa có AI trả lời.
- **Tài liệu** liệt kê và mở Google Docs/Sheets khi đăng nhập bằng Google.

🛠️ **Giao diện gọn hơn**
- Thanh tiêu đề Windows gộp vào thanh trên của app, cùng màu.
- Giữ đăng nhập lâu hơn: phiên trên máy trượt theo lần dùng, tối đa 90 ngày.

⚠️ **Lưu ý**
- Máy chủ của đợt thử chạy trên máy của Minh. Máy chủ tắt thì không đăng nhập được, nhưng Canvas vẫn dùng được với tài khoản canvasapp.

---

## [1.0.0] — 2026-10-27 — Bản đầu: SANO và Canvas trong một app

Từ bản này, Sano Agent là app duy nhất được phát hành. SanoVids gộp vào đây thành khu **Canvas**.

✨ **SANO có sẵn trong app**
- Cài xong là mở được SANO. Không cần Docker, không cần máy chủ: trang SANO nằm ngay trong bộ cài.
- SANO chạy ở chế độ demo, chưa có đăng nhập Google. Tab **Máy chủ** ghi "Chưa kết nối được API" vì bản này chưa có máy chủ.
- Dữ liệu SANO (bảng sản xuất, nháp, giao diện) lưu trên máy này.

✨ **Canvas: SanoVids toàn màn hình**
- **Canvas** là SanoVids bản desktop, mở toàn màn hình trong SANO: tạo video thật bằng tài khoản canvasapp.io.vn của bạn.
- Nút **Trợ lý** ở góc phải trên cùng mở trợ lý dự án của SANO.

✨ **Dùng chung dự án với SanoVids**
- Cùng thư mục dữ liệu với SanoVids (`%APPDATA%\SanoVids`): dự án, video và đăng nhập canvasapp làm trong SanoVids có sẵn trong Canvas.
- Gỡ Sano Agent không xoá thư mục đó.

✨ **Nhận diện Sano Agent**
- Biểu tượng dấu S/phát của SANO trên ô đỏ (phương án A), cho app, thanh tác vụ, khay và trình cài.

✨ **Ký số và tự cập nhật**
- Bộ cài được ký số bằng chứng chỉ của tác giả, cùng chứng chỉ với SanoVids.
- Bản Setup tự cập nhật từ trang tải về của Sano Agent, và kiểm chữ ký số trước khi cài.

⚠️ **Lưu ý**
- Đóng SanoVids và sao lưu `%APPDATA%\SanoVids` trước lần mở đầu. Không mở cùng lúc hai app.
- Cài vào thư mục mặc định, không chọn thư mục cài của SanoVids.
- Bản này chỉ có Windows.

[1.0.0]: https://github.com/JameSteven404/sano-agent-releases/releases/tag/v1.0.0
