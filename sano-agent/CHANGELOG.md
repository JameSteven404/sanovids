# 📜 Lịch sử phiên bản — Sano Agent

Mọi thay đổi đáng chú ý của Sano Agent, app SANO trên máy tính. Bản cài của từng phiên bản có ở trang tải về [sano-agent-releases](https://github.com/JameSteven404/sano-agent-releases/releases). Khu Canvas là SanoVids: thay đổi của nó trước bản 1.0.0 ghi trong [CHANGELOG của SanoVids](../CHANGELOG.md).

Ký hiệu: ✨ thêm mới · 🛠️ thay đổi · 🐞 sửa lỗi · ⚠️ lưu ý

---

## [1.0.0] — 2026-10-27 — Bản đầu: SANO và Canvas trong một app

Từ bản này, Sano Agent là app duy nhất được phát hành. SanoVids gộp vào đây thành khu **Canvas**.

✨ **SANO trong cửa sổ riêng**
- Mở app SANO ở `http://127.0.0.1:8080` (máy chủ SANO chạy bằng Docker trên chính máy này).
- Không mở được SANO (máy chủ chưa chạy, hoặc chuyển hướng sang địa chỉ khác) thì app báo rõ, với ba nút **Thử lại**, **Mở Canvas** và **Thoát**.
- SANO chạy ở chế độ demo, chưa có đăng nhập Google.

✨ **Canvas: SanoVids toàn màn hình**
- **Canvas** là SanoVids bản desktop, mở toàn màn hình trong SANO: tạo video thật bằng tài khoản canvasapp.io.vn của bạn.
- Nút **Trợ lý** ở góc phải trên cùng mở trợ lý dự án của SANO.
- **Mở Canvas** khi chưa mở được SANO: Canvas chạy riêng như SanoVids trước đây, không cần Docker.

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
