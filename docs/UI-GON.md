# UI gọn — người mới dùng được ngay

Yêu cầu của Minh (2026-10-22): "tối ưu làm gọn gàng lại giao diện cho đơn giản hơn, dễ dùng hơn cho tất cả mọi người", giao cho **Argon** (Antigravity) và **Codex**. Minh chọn hướng **"Người mới dùng được ngay"**:
- trên màn hình chỉ còn những gì cần ngay, thứ ít dùng cất vào menu;
- chữ hướng dẫn rõ ràng;
- các bước tạo video rõ ràng;
- người đã quen vẫn giữ phím tắt và thao tác nhanh.

Làm theo hai bước:
1. **Xem và đề xuất:** Argon kiểm thử trải nghiệm người mới (UG-01), Codex dựng mockup (UG-02).
2. **Làm:** Claude gộp hai kết quả thành một đề xuất. **Minh duyệt xong** mới chia việc làm (UG-03 trở đi).

Cơ sở mã: nhánh `p3/ui-gon` (đã gồm bản 0.6.0 và giá đọc từ canvasapp `p3/canvasapp-gia`). Quy tắc chung của dự án: `CLAUDE.md`.

## 1. Nguyên tắc

1. **Một việc chính: tạo video từ cảnh.** Đường đi phải nhìn ra ngay: thêm nhân vật / bối cảnh → viết cảnh → tạo video → xem, chọn ★, tải.
2. **Ít thứ hiển thị cùng lúc.**
   - Chỉ hiện điều khiển cần cho việc đang làm; thứ ít dùng vào "⋯" hoặc Cài đặt → Nâng cao.
   - **Chuyển chỗ, không xoá** tính năng: muốn bỏ hẳn thứ gì thì ghi vào đề xuất để Minh quyết.
3. **Chữ đời thường.**
   - Câu ngắn, tiếng Việt quen thuộc.
   - Từ chuyên môn (take, preset, token, LOD, prompt…) thì đổi sang từ dễ hiểu, hoặc giải thích một lần ở chỗ xuất hiện đầu tiên.
   - Tên model giữ tiếng Anh (Seedance 2.5, MiniMax-H3).
4. **Màn hình trống phải dẫn đường:** dự án mới, chưa chọn gì, chưa có video, chưa đăng nhập.
5. **Người dùng quen không bị chậm lại:** giữ phím tắt, menu chuột phải, chọn nhiều, thanh thao tác nổi.

**Không đổi** (đã chốt hoặc liên quan tới tiền):
- hộp xác nhận chi phí trước mỗi lần tạo video;
- các cảnh báo "không rõ đã bị trừ credit chưa", "Tạo lại là lượt mới";
- chữ đỏ giữ chỗ khi cắt ảnh;
- thẻ cảnh rộng 304 px;
- màu thiết kế D (đỏ Sano, 3 nền tối, nền sáng);
- mã trong `src/providers/**`, `src/store/runs.ts`, `electron/**`, phần cập nhật và chữ ký số.

## 2. Bảng việc

| Mã | Ai | Việc | Phạm vi file | Đầu ra | Cách kiểm | Trạng thái |
|---|---|---|---|---|---|---|
| UG-01 | Argon | Kiểm thử trải nghiệm **người mới** trên app chạy thật ở chế độ Phát triển (mục 3) | Thư mục `E:\sanovids-ag-ug01` (nhánh `ag/ug01`). Chỉ đọc mã app; chỉ ghi `docs/ui-gon/AUDIT-ARGON.md` và ảnh `docs/ui-gon/img/` | Báo cáo ≥ 25 điểm: mỗi điểm có ảnh, lý do khó và đề xuất; kèm top 10 ưu tiên | Claude đọc, mở lại từng chỗ trên app để đối chiếu | Đang chờ Argon nhận |
| UG-02 | Codex | Mockup HTML tĩnh **"SanoVids gọn cho người mới"** + bảng "nút hiện có → chỗ mới" (mục 4) | Thư mục `E:\sanovids-codex-ug02` (nhánh `cx/ug02`). Chỉ ghi `docs/ui-gon/mockup/**` | `docs/ui-gon/mockup/index.html` (mở được không cần mạng) + `docs/ui-gon/mockup/DE-XUAT.md` | Claude mở mockup ở Tối / Sáng, 1366 và 1920 px, đối chiếu bảng với mã thật | Claude đã chạy Codex |
| UG-03… | Argon / Codex / Claude | Các việc làm sau khi Minh duyệt đề xuất | (ghi sau) | | | Chờ Minh duyệt |

## 3. UG-01 — Argon kiểm thử trải nghiệm người mới

**Chuẩn bị**
- Thư mục `E:\sanovids-ag-ug01`, đã có `node_modules`.
- Chạy `npm run dev -- --port 5182` (cổng 5180 đang có máy chủ khác).
- App mở ở **chế độ Phát triển**: canvasapp giả lập trong app, video giả, credit dev, không mạng, không tốn tiền.
- Đăng nhập giả lập: ô **DEV · Đăng nhập** trên thanh trên cùng → **Đăng nhập** (không cần mật khẩu).

**Đóng vai người lần đầu dùng SanoVids**, chưa đọc hướng dẫn, và đi hết các luồng:
1. Mở app lần đầu: thấy gì, có biết bắt đầu từ đâu không.
2. Tạo dự án mới trống (**Dự án → Dự án mới**).
3. Thêm 2 nhân vật và 1 bối cảnh: ảnh bất kỳ (JPG / PNG), tự tạo nếu cần.
4. Tạo 3 cảnh, viết nội dung có nhắc nhân vật (`@image_1`…), nối ảnh vào cảnh.
5. Tạo video cho 1 cảnh, rồi cho cả 3 cảnh. Xem video, chọn ★, tải về, **Phát liền**.
6. Sửa một cảnh: đổi thời lượng / độ phân giải, đổi ảnh, cắt một dây ảnh (chữ đỏ hiện ra).
7. **Nhập nhiều prompt**, **Sắp xếp**, menu chuột phải, nút **+**.
8. **Cài đặt**: tìm cách đổi giao diện Sáng / Tối, phím tắt.

Làm ở hai cỡ cửa sổ 1366×768 và 1920×1080, giao diện Tối và Sáng.

**Ghi vào `docs/ui-gon/AUDIT-ARGON.md`**
- Bảng: mã điểm, màn hình / khu vực, vấn đề, vì sao khó với người mới, đề xuất, mức độ (1 = chặn việc, 2 = chậm / dễ nhầm, 3 = rườm rà), tên ảnh.
- Ví dụ loại vấn đề: nhiều nút cùng lúc, chữ khó hiểu, không biết bước tiếp theo, chữ quá nhỏ, nút trùng chức năng, chỗ trống không hướng dẫn.
- Cuối báo cáo: **top 10** nên làm trước.
- Ảnh chụp ở `docs/ui-gon/img/`.

**Quy tắc**
- Không sửa mã app.
- Commit được trên nhánh `ag/ug01` trong thư mục của mình; không push, không merge, không đổi nhánh khác.
- Không mở trang canvasapp.io.vn thật, không đăng nhập tài khoản thật.
- Không đụng `%APPDATA%\SanoVids`. Không tắt tiến trình không do mình mở.
- Xong thì báo lên nhóm Zalo, tag Claude, ghi rõ phần nào chưa kiểm.

## 4. UG-02 — Codex dựng mockup "SanoVids gọn cho người mới"

**Đọc mã thật trước** để liệt kê mọi điều khiển đang có:
- thanh trên cùng: `src/components/topbar/`;
- thư viện / video đã tạo / preset: `src/components/sidebar/`;
- bảng bên phải: `src/components/inspector/`;
- thẻ cảnh / video / ảnh, thanh công cụ, thanh thao tác nổi, bảng **+**: `src/components/canvas/`;
- hàng đợi, hộp xác nhận chạy: `src/components/runs/`;
- Cài đặt: `src/components/dialogs/SettingsDialog.tsx` và các file `Settings*.tsx`.

**Mockup tĩnh** trong `docs/ui-gon/mockup/index.html`:
- một file, không cần mạng;
- màu lấy từ token của `src/styles/base.css`;
- có nút đổi Tối / Sáng.

Mockup gồm các màn hình:
1. **Lần đầu mở / dự án trống:** hướng dẫn "Bắt đầu 3 bước" ngay trên canvas hoặc ở bảng bên phải, mỗi bước một nút làm luôn.
2. **Đang làm việc** (chọn một cảnh):
   - thanh trên cùng gọn: tối đa khoảng 6 thứ nhìn thấy, phần còn lại vào "⋯";
   - thư viện gọn;
   - bảng bên phải chỉ giữ thứ cần: nội dung cảnh, ảnh tham chiếu, thông số tóm tắt, nút **Tạo video · … credit**; phần nâng cao gập lại.
3. **Chưa chọn gì:** thay danh sách "Cách nối" + "Phím tắt" dài bằng gợi ý ngắn theo tình huống.
4. **Hộp xác nhận tạo video:** dễ đọc hơn nhưng giữ đủ thông tin chi phí và cảnh báo.
5. Thẻ cảnh / video ở mức zoom thường: chữ đọc được, ít biểu tượng nhỏ.

**`docs/ui-gon/mockup/DE-XUAT.md`**
- Bảng **"nút hiện có → chỗ mới"**: liệt kê từng điều khiển hiện có (tên, file:dòng) và chỗ của nó trong bản mới (giữ / vào "⋯" / vào Cài đặt Nâng cao / đề xuất bỏ, kèm lý do). Không tính năng nào được mất mà không ghi.
- Danh sách chữ đổi cho dễ hiểu (cũ → mới).
- Chia đề xuất thành việc nhỏ UG-03, UG-04…, mỗi việc ghi file app sẽ sửa và cách kiểm.

**Quy tắc**
- Chỉ ghi trong `docs/ui-gon/mockup/`.
- Không chạy Electron, trình duyệt hay chương trình có giao diện. Claude sẽ tự mở mockup để xem.
- Không commit, không push.
- Không gọi mạng tới canvasapp.

## 5. Nhật ký

- 2026-10-22: Claude tạo bảng, chuẩn bị hai thư mục làm việc, báo nhóm Zalo; chạy Codex cho UG-02.
