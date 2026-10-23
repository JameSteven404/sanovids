# SANO desktop — SanoVids làm khu “Dựng phim” trong app SANO

> **Trạng thái:** chạy từ mã nguồn (quyết định D218 của SANO: canvasapp.io.vn là nhà cung cấp video chính, Minh chọn
> làm bản desktop SANO). Chưa có bản cài riêng cho SANO.
>
> **D226 (2026-10-23): tạm ẩn canvasapp phía SANO.** Một hằng trong `electron/main.cjs`: `CANVASAPP_IN_SANO = false`
> (đặt `true` khi Minh mở lại). Ở chế độ SANO, main báo trang `app://bdp` qua `--bdp-sano-canvasapp` →
> `window.bdpDesktop.sano = { canvasapp: false }`, trang không có cầu `canvasapp`, main từ chối mọi `canvasapp:*`
> (`sano-paused`). Trong SANO không còn lựa chọn, đăng nhập, credit hay chữ nào nhắc canvasapp; chế độ Phát triển (chạy
> từ mã nguồn) vẫn là giả lập, còn khi chế độ Phát triển khoá (bản cài) trang nói “Tạo video trong SANO đang tạm dừng”.
> Take canvasapp đã có giữ nguyên dữ liệu: hàng đợi trong SANO không gửi, theo dõi hay đánh lỗi chúng — SanoVids chạy
> riêng vẫn chạy tiếp như cũ. SanoVids chạy riêng (không `SANO_URL`) không đổi gì.

## 1. Mục đích

Mở app SANO trong cửa sổ desktop của SanoVids. Khu “Dựng phim” của SANO là chính SanoVids bản desktop, nên tạo được
**video thật** bằng tài khoản canvasapp.io.vn của từng người qua cổng canvasapp ([GATEWAY-CANVASAPP.md](GATEWAY-CANVASAPP.md)).
Máy chủ SANO không giữ phiên hay cookie canvasapp nào.

## 2. Chạy

1. Chạy SANO trước (repo SANO-AGENT: `npm run dev`, mặc định `http://127.0.0.1:5173`; hoặc docker compose ở `http://localhost:8080`).
2. Đóng SanoVids nếu đang mở: hai chế độ dùng chung thư mục dữ liệu, chỉ mở được một cửa sổ.
3. Chạy `sano-desktop.bat` (địa chỉ khác: `sano-desktop.bat https://sano.example.vn`). File bat dựng lại SanoVids rồi mở SANO.
4. Trong SANO: **SẢN XUẤT → Dựng phim**. Take mới chạy ở *chế độ Phát triển* (giả lập, không tốn credit); tạo video
   thật trong SANO đang tạm dừng (D226).

## 3. Cách hoạt động

- `SANO_URL` chỉ có tác dụng khi chạy từ mã nguồn (bản đóng gói bỏ qua). Nhận `https://…`, hoặc `http://` trên chính máy
  (`localhost`, `127.0.0.1`); chỉ lấy origin, tên máy chỉ gồm chữ, số, `-` và `.` (vì origin đi vào CSP). Giá trị khác:
  SanoVids không mở (`hardening-rules.sanoShell`).
- Cửa sổ chính mở trang SANO và chỉ ở origin đó, kể cả khi máy chủ chuyển hướng; link ngoài mở trình duyệt.
- Riêng popup `https://accounts.google.com/` (“Đăng nhập bằng Google” của SANO) mở thành cửa sổ con. Popup chỉ đi trong các
  trang đăng nhập của Google (`accounts.google.com`, `accounts.youtube.com`); link và popup con của nó mở trình duyệt. Đóng
  popup thì cookie tài khoản Google nó để lại trong thư mục dữ liệu bị xoá (SANO đã nhận token).
- Trang SANO thấy `window.sanoDesktop = { sanovidsUrl: 'app://bdp/' }` và đặt khung Dựng phim vào địa chỉ đó: bản SanoVids
  nằm trong app (`dist/`), không tải từ máy chủ SANO.
- Preload chạy ở mọi khung (`nodeIntegrationInSubFrames`), nhưng chỉ trang `app://bdp` nhận `window.bdpDesktop`. Mọi lời gọi
  cổng vẫn bị main kiểm khung gửi (`fromApp`: chỉ `app://bdp/…`). SANO và SanoVids khác origin: trang SANO không đọc hay
  điều khiển được trang SanoVids.
- SANO gỡ khung Dựng phim hoặc đưa khung sang địa chỉ khác: lượt tải video đang dở của SanoVids dừng (lúc `pagehide`, trang
  báo main `canvasapp:downloadCloseAll`). Nếu lúc đó SanoVids đang bận quá khoảng nửa giây, lời báo không tới và lượt tải
  dừng khi hết giờ chờ (10 phút). SANO giữ khung suốt phiên, nên việc này chỉ xảy ra khi khung bị gỡ.
- Dùng chung dự án với SanoVids chạy riêng (D223): cùng thư mục dữ liệu, và ở chế độ SANO main tắt tính năng tách lưu trữ
  theo trang chứa của Chromium (`ThirdPartyStoragePartitioning`), nên khung `app://bdp` mở đúng kho dự án của SanoVids.
- CSP của trang SanoVids đổi đúng một chỉ thị: `frame-ancestors <origin SANO>` thay `'none'`. Khung Dựng phim của SANO
  cho SanoVids dùng toàn màn hình và chép vào clipboard (`allow="fullscreen; clipboard-write"`).

## 4. Giới hạn

- Không mở cùng lúc SanoVids và SANO desktop (cùng thư mục dữ liệu: lần mở thứ hai chỉ đưa cửa sổ đang mở lên trước).
- Google có thể từ chối đăng nhập trong cửa sổ app. Khi đó SANO ở chế độ demo; Dựng phim với canvasapp vẫn chạy vì không cần
  đăng nhập SANO. Tài khoản Google Workspace đăng nhập qua nhà cung cấp riêng (SSO) bị chặn ở bước chuyển hướng đó.
- `SANO_URL` phải là địa chỉ cuối: máy chủ chuyển hướng ngay lần mở đầu thì SanoVids báo lỗi và thoát (exit 2).
- Trong khung, SanoVids không có nút “Chọn thư mục tải về” (trình duyệt không cho khung khác origin mở hộp chọn thư mục).
  “Lưu video” và nút Thư mục trên canvas vẫn dùng hộp thoại của app.
- Thông báo main gửi tới trang (`devAccess:state`, `updates:state`) chỉ tới khung chính, nên SanoVids trong SANO không nhận.
  Chạy từ mã nguồn không ảnh hưởng (chế độ Phát triển mở sẵn, không có cập nhật tự động); cần sửa trước khi có bản cài SANO.
- Tải tệp từ trang SANO bị chặn (chỉ cho tải `blob:app://bdp/…`).
- Chưa có bản cài: Minh đã chốt tên **Sano Agent**, ký số như SanoVids và kênh cập nhật trên GitHub (D220); đang làm.
