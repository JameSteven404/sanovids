# Tự kiểm tra lần cuối với credit thật (canvasapp.io.vn)

Mục tiêu: chắc chắn 3 điều trước khi làm phim thật, tốn **ít credit nhất**:

1. **Đồng bộ nhân vật**: `@image_N` trong prompt luôn là đúng tấm ảnh thứ N gửi đi.
2. **Video về đúng chỗ**: theo dõi tiến độ, tải video về máy, mở lại app vẫn không mất và không bị tính tiền hai lần.
3. **Credit đúng**: số dư canvasapp giảm đúng giá. Nạp credit cộng đúng số. Credit demo không bị lẫn vào.

**Chi phí dự kiến: 8 credit** (2 video Seedance 2.5 · 5 giây · 480p, mỗi video 4 credit). Cần số dư **≥ 10 credit**.
Phần nạp credit là tuỳ chọn: lần nạp nhỏ nhất là 10.000đ = 10 credit.

> Chỉ dùng **bản cài .exe mới nhất** (cổng canvasapp và nạp credit chỉ có trong bản desktop, bản web sẽ khoá).
> Làm trong **một dự án mới** tên "Thử credit thật", đừng thử trên dự án phim đang làm.

---

## Bước 0 — Chuẩn bị (không tốn credit)

- [ ] Cài `SanoVids-Setup-x.y.z.exe` mới. Nếu Windows hỏi thì chọn *More info → Run anyway*.
- [ ] Mở app → **Dự án → Dự án mới** → đặt tên "Thử credit thật".
- [ ] Thả vào thư viện **3 ảnh rất khác nhau**, ví dụ:
  - **A** = người mặc áo đỏ
  - **B** = một con chó
  - **C** = bối cảnh (bãi biển)

  Đặt tên rõ: "Áo đỏ", "Chó", "Bãi biển". Ảnh khác nhau rõ thì nhìn video là biết ngay có đúng nhân vật không.
- [ ] Mở **Cài đặt › Cổng canvasapp.io.vn**:
  1. Bấm **Đăng nhập canvasapp**. Một cửa sổ trang thật của canvasapp mở ra, bạn tự đăng nhập ở đó (SanoVids không thấy mật khẩu).
  2. Cửa sổ tự đóng.
  3. Thấy "Đã đăng nhập" và **số credit giống hệt trên canvasapp.io.vn**. Ghi số dư lại: **S0 = ____ credit**.
- [ ] Chọn **canvasapp.io.vn** ở "Nhà cung cấp video cho take mới".
- [ ] Ô credit trên thanh trên cùng đổi từ "DEMO" (viền đứt) sang **"canvasapp · S0 credit"** (màu xanh, có nút **+**).

## Bước 1 — Kiểm tra chặn lỗi (không tốn credit)

1. Tạo cảnh S01, chọn **Seedance 2.5 · 5 s · 480p**.
2. Chọn A và B trên canvas, bấm **Nối (C)** vào S01. Chỉ 2 dây được nối, đúng 2 ảnh bạn chọn.
3. Viết prompt: `@image_1 chơi đùa với @image_2 trong @image_3`.
   - [ ] `@image_3` bị **tô đỏ** vì cảnh mới có 2 ảnh. Phần **Prompt cuối** có cảnh báo.
   - [ ] Bấm **Chạy**: app **không gửi**, báo lý do "Prompt nhắc @image_3 nhưng không có ảnh đó…". Credit **không đổi**.
4. Nối thêm C vào S01. `@image_3` hết đỏ. Đây là kiểu "viết trước, nối sau": số được giữ nguyên.

## Bước 2 — Video thật #1: đúng nhân vật (4 credit)

1. Rê chuột lên từng `@image_N` trong **Prompt cuối**, kiểm tra:
   - [ ] `@image_1` = Áo đỏ
   - [ ] `@image_2` = Chó
   - [ ] `@image_3` = Bãi biển
2. Bấm **Chạy**. Hộp xác nhận phải ghi **"4 credit"** và trừ vào **credit canvasapp**, không phải credit demo. Bấm xác nhận.
3. Trong lúc chờ (thường vài phút, tiến độ cập nhật khoảng 20 giây/lần):
   - [ ] Trên canvasapp.io.vn (trình duyệt), mở phiên **"SanoVids bridge"**: có đúng 1 job mới, ảnh tham chiếu theo thứ tự Áo đỏ → Chó → Bãi biển.
   - [ ] **Đóng hẳn SanoVids rồi mở lại**: take vẫn "đang tạo" rồi xong. Trên canvasapp **không** có job thứ hai.
4. Khi xong:
   - [ ] Node video hiện ra bên phải cảnh và phát được. Trong video là người áo đỏ chơi với con chó ở bãi biển.
   - [ ] Bấm nút to **Tải video** để lưu file `.mp4` vào thư mục Tải về, rồi mở thử bằng trình phát video.
   - [ ] Bấm vào ô credit (hoặc chờ vài giây): số dư = **S0 − 4**.
   - [ ] Mở take (bấm đúp node video): mục tham chiếu ghi đúng `@image_1 Áo đỏ`, `@image_2 Chó`, `@image_3 Bãi biển`, kèm nhãn "Khớp với prompt hiện tại".

## Bước 3 — Video thật #2: đổi thứ tự, số phải đi theo ảnh (4 credit)

1. Ở inspector của S01, **kéo Chó lên đầu** danh sách ảnh tham chiếu.
   - [ ] Prompt tự đổi thành `@image_2 chơi đùa với @image_1 trong @image_3`, nghĩa là mỗi số vẫn trỏ đúng tấm cũ.
   - [ ] Rê chuột kiểm tra lại: `@image_1` = Chó, `@image_2` = Áo đỏ.
2. Thêm ảnh thứ 2 cho nhân vật Áo đỏ (mở thẻ Áo đỏ → thêm ảnh). Kiểm tra lại Prompt cuối: các số vẫn đúng người.
3. Bấm **Chạy**. Ngay sau khi bấm, **sửa thử** thứ tự ảnh hoặc prompt. Take đã gửi phải giữ nguyên cái lúc bạn bấm Chạy.
4. Khi xong:
   - [ ] Video vẫn đúng 2 nhân vật.
   - [ ] Số dư = **S0 − 8**.
   - [ ] Trên canvasapp, ảnh của Áo đỏ và Chó **không bị tải lên lại** (dùng lại bản đã tải lần trước), chỉ ảnh mới thêm được tải lên.

## Bước 4 — Nạp credit (tuỳ chọn, 10.000đ)

1. Bấm nút **+** cạnh ô credit (hoặc **Cài đặt › Cổng canvasapp › Nạp credit**).
2. Nhập **10.000** → thấy "= 10 credit" → **Mở thanh toán QR**. Cửa sổ "Thanh toán nạp credit" mở trang **SePay** (SanoVids chỉ cho mở trang thuộc sepay.vn).
3. **Bạn tự quét QR** bằng app ngân hàng. SanoVids không bao giờ nhập hay thấy thông tin ngân hàng.
4. Sau khi chuyển:
   - [ ] Hộp nạp chuyển sang "Đã nhận tiền ✓" chỉ khi canvasapp xác nhận. Trang SePay báo thành công chưa đủ.
   - [ ] Số dư tăng **+10 credit**.
   - [ ] Tab **Lịch sử credit** có dòng nạp.
5. Nếu đóng cửa sổ thanh toán giữa chừng: hộp nạp báo "Cửa sổ thanh toán đã đóng", không bị trừ gì. Đơn chưa trả tự hết hạn sau 10 phút.

## Bước 5 — Dọn dẹp

- [ ] Muốn quay về chế độ miễn phí: chọn **Demo giả lập** (hoặc **Đăng xuất**).
- [ ] Xoá dự án "Thử credit thật" nếu không cần.

---

## Nếu có gì sai — gửi cho mình

1. **Ảnh chụp màn hình** lúc lỗi, kèm dòng thông báo (toast) hiện ở giữa phía trên màn hình, ngay dưới thanh trên cùng.
2. Bước nào trong danh sách này, và bạn đã bấm gì ngay trước đó.
3. Nếu sai nhân vật, gửi thêm:
   - ảnh chụp **Prompt cuối** (rê chuột lên số bị sai)
   - ảnh chụp **mục tham chiếu** trong cửa sổ xem take
   - ảnh chụp job đó trên canvasapp.io.vn
4. Nếu credit lệch: số dư trước/sau, và tab **Lịch sử credit** (nút + → Lịch sử).

**Dừng ngay, đừng bấm Chạy tiếp** nếu thấy một trong các dấu hiệu sau:

- video ra sai nhân vật
- credit bị trừ hai lần cho một video
- trên canvasapp có job trùng
