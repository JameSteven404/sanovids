# 📜 Lịch sử phiên bản — Sano Agent

Mọi thay đổi đáng chú ý của Sano Agent, app SANO trên máy tính. Bản cài của từng phiên bản có ở trang tải về [sano-agent-releases](https://github.com/JameSteven404/sano-agent-releases/releases). Khu Canvas là SanoVids: thay đổi của nó trước bản 1.0.0 ghi trong [CHANGELOG của SanoVids](../CHANGELOG.md).

Ký hiệu: ✨ thêm mới · 🛠️ thay đổi · 🐞 sửa lỗi · ⚠️ lưu ý

---

## [1.1.0-beta.3] — 2026-10-31 — Bản thử nội bộ: sửa trước đợt thử

Bản thử cho đợt thử nội bộ M1, thay cho beta.2: chỉ đưa thẳng cho người thử, không đăng lên trang tải về. Gồm mọi thứ của beta.2, cộng các thay đổi dưới đây.

🐞 **Sửa lỗi so với beta.2**
- Bấm X giờ luôn đóng được app. Khi Chat kiến thức còn chữ chưa gửi, hoặc một hộp thoại còn trường chưa lưu, app hỏi **Ở lại** / **Vẫn rời đi**; trước đây bấm X không có tác dụng gì.
- Đăng nhập dùng thêm kho chứng chỉ của Windows. Trên máy có antivirus quét HTTPS, app không còn báo "Không kết nối được máy chủ tài khoản" trong khi trình duyệt vẫn mở được trang. Bản sửa này không xử lý proxy công ty.

🛠️ **Dễ báo lỗi hơn**
- Lỗi khi gọi máy chủ tài khoản được ghi vào `%APPDATA%\SanoVids\logs\sano-account.log`, kèm mã nguyên nhân (chứng chỉ, tên miền, mạng). Tệp chỉ có tên lệnh gọi và mã lỗi, không có mật khẩu hay mã phiên.

⚠️ **Lưu ý**
- Máy chủ tắt: ai đang đăng nhập vẫn dùng được Canvas. Ai chưa đăng nhập hoặc đã đăng xuất thì phải chờ máy chủ chạy lại mới vào được Canvas.

---

## [1.1.0-beta.2] — 2026-10-30 — Bản thử nội bộ: tài khoản SANO và máy chủ chung

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

🐞 **Sửa lỗi so với beta.1**
- Đăng xuất trên máy không còn báo thành công khi tệp phiên chưa xoá được; huỷ đăng nhập Google không làm phiên vừa huỷ thành phiên đang dùng (#95).
- Kết nối Google Workspace: phản hồi của lần kết nối cũ không còn ghi đè hoặc xoá kết nối mới (#59).

⚠️ **Lưu ý**
- Máy chủ của đợt thử chạy trên máy của Minh. Máy chủ tắt thì không đăng nhập được; chỉ ai đang đăng nhập mới vẫn dùng được Canvas (sửa lời ghi ngày 31/10).

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
