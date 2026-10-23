# SANO desktop — SanoVids làm khu “Dựng phim” trong app SANO

> **Trạng thái:** chạy từ mã nguồn (quyết định D218 của SANO: canvasapp.io.vn là nhà cung cấp video chính, Minh chọn
> làm bản desktop SANO). Chưa có bản cài riêng cho SANO.

## 1. Mục đích

Mở app SANO trong cửa sổ desktop của SanoVids. Khu “Dựng phim” của SANO là chính SanoVids bản desktop, nên tạo được
**video thật** bằng tài khoản canvasapp.io.vn của từng người qua cổng canvasapp ([GATEWAY-CANVASAPP.md](GATEWAY-CANVASAPP.md)).
Máy chủ SANO không giữ phiên hay cookie canvasapp nào.

## 2. Chạy

1. Chạy SANO trước (repo SANO-AGENT: `npm run dev`, mặc định `http://127.0.0.1:5173`; hoặc docker compose ở `http://localhost:8080`).
2. Đóng SanoVids nếu đang mở: hai chế độ dùng chung thư mục dữ liệu, chỉ mở được một cửa sổ.
3. Chạy `sano-desktop.bat` (địa chỉ khác: `sano-desktop.bat https://sano.example.vn`). File bat dựng lại SanoVids rồi mở SANO.
4. Trong SANO: **SẢN XUẤT → Dựng phim**. Take mới vẫn chạy ở *chế độ Phát triển* (giả lập, không tốn credit). Muốn tạo
   video thật: Cài đặt của SanoVids → cổng canvasapp → bật, rồi **Đăng nhập** trên trang thật canvasapp.io.vn.

## 3. Cách hoạt động

- `SANO_URL` chỉ có tác dụng khi chạy từ mã nguồn (bản đóng gói bỏ qua). Nhận `https://…`, hoặc `http://` trên chính máy
  (`localhost`, `127.0.0.1`); chỉ lấy origin, tên máy chỉ gồm chữ, số, `-` và `.` (vì origin đi vào CSP). Giá trị khác:
  SanoVids không mở (`hardening-rules.sanoShell`).
- Cửa sổ chính mở trang SANO và chỉ ở origin đó, kể cả khi máy chủ chuyển hướng; link ngoài mở trình duyệt.
- Trang SANO thấy `window.sanoDesktop = { sanovidsUrl: 'app://bdp/', google: { signIn, token, signOut } }` và đặt khung
  Dựng phim vào `sanovidsUrl`: bản SanoVids nằm trong app (`dist/`), không tải từ máy chủ SANO. Chỉ khung chính của trang
  SANO nhận `sanoDesktop` (preload kiểm `process.isMainFrame`); main kiểm lại khung gửi của mọi lời gọi Google (`fromSano`:
  khung chính của cửa sổ chính, đúng origin SANO). Kiểm hai cổng này trong Electron thật (không chạy trong CI, không đăng
  nhập): `npx electron scripts/sano-desktop-probe.cjs`.
- **Đăng nhập bằng Google** (TH-36) chạy trong trình duyệt mặc định, không trong cửa sổ app (Google chặn trình duyệt nhúng):
  - `google.signIn()`: main lấy client ID từ `googleDesktopClientId` của `/api/assistant/status` trên máy chủ SANO (trang
    không đưa được client ID hay địa chỉ nào vào), mở trang đăng nhập Google (địa chỉ cố định trong
    `electron/google-signin-rules.cjs`) bằng trình duyệt và chờ Google chuyển về `http://127.0.0.1:<cổng ngẫu nhiên>/`, có
    PKCE S256 và `state`. Request sai đường trả 404; thiếu hoặc sai `state` trả 400 và vẫn chờ; 5 phút không xong thì hết giờ;
    bấm lại thì lượt cũ bị hủy. Đổi code xong, trình duyệt hiện trang tĩnh (không chứa token) và cửa sổ app được gọi lên.
    Kết quả: `{ ok: true, idToken }` hoặc `{ ok: false, code, message }` (`cancelled`, `timeout`, `superseded`,
    `not-configured`, `failed`, `not-allowed`).
  - `google.token()`: ID token đang giữ; còn dưới 5 phút thì main gia hạn bằng refresh token (nhiều lời gọi dùng chung một
    lần). Google từ chối (4xx trừ 408/429: `invalid_grant`, `invalid_client`, `unauthorized_client`…) hoặc không trả ID
    token: `null`, trang hiện lại nút đăng nhập. Google không trả lời (mất mạng, lỗi máy chủ, 408, 429, quá 15 giây):
    giữ token cũ khi còn hạn; hết hạn thì lời gọi báo lỗi (không phải `null`, vẫn đăng nhập), trang chỉ hỏng request đó.
    Lần gọi sau thử lại.
  - `google.signOut()`: xoá token trong bộ nhớ, không thu hồi ở Google (Google thu hồi theo cả project). Lượt đăng nhập
    đang chờ trình duyệt kết thúc với `cancelled`, kết quả về muộn bị bỏ.
  - Lấy client ID từ máy chủ SANO cũng dừng sau 15 giây (coi như chưa bật: `not-configured`).
  - Refresh token chỉ nằm trong bộ nhớ của main, không xuống đĩa và không qua cầu sang trang. Token có scope ngoài đăng nhập
    (`openid`, `email`, `profile`) bị bỏ.
  - `SANO_GOOGLE_DESKTOP_CLIENT_SECRET` (tuỳ chọn): chỉ đặt trên máy chạy SANO desktop nếu Google bắt client Desktop gửi secret
    (bài test T1 của TH-36).
- Link `accounts.google.com` trên trang SANO mở trình duyệt như mọi link ngoài. Cookie tài khoản Google mà popup đăng nhập
  trong app của các bản cũ để lại vẫn được xoá mỗi lần khởi động.
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
- Đăng nhập Google cần máy chủ SANO có `SANO_GOOGLE_DESKTOP_CLIENT_ID` và trang SANO bản gọi `sanoDesktop.google` (TH-36:
  web và máy chủ cập nhật trước, desktop sau). Thiếu thì SANO ở chế độ demo; Dựng phim với canvasapp vẫn chạy vì không cần
  đăng nhập SANO.
- Token chỉ ở bộ nhớ: mỗi lần mở app phải bấm đăng nhập một lần (trình duyệt thường đã nhớ tài khoản, chỉ cần chọn).
- Trên Windows, sau khi đăng nhập cửa sổ app có thể chỉ nhấp nháy ở taskbar; trang trong trình duyệt nhắc quay lại app.
- `SANO_URL` phải là địa chỉ cuối: máy chủ chuyển hướng ngay lần mở đầu thì SanoVids báo lỗi và thoát (exit 2).
- Trong khung, SanoVids không có nút “Chọn thư mục tải về” (trình duyệt không cho khung khác origin mở hộp chọn thư mục).
  “Lưu video” và nút Thư mục trên canvas vẫn dùng hộp thoại của app.
- Thông báo main gửi tới trang (`devAccess:state`, `updates:state`) chỉ tới khung chính, nên SanoVids trong SANO không nhận.
  Chạy từ mã nguồn không ảnh hưởng (chế độ Phát triển mở sẵn, không có cập nhật tự động); cần sửa trước khi có bản cài SANO.
- Tải tệp từ trang SANO bị chặn (chỉ cho tải `blob:app://bdp/…`).
- Chưa có bản cài: Minh đã chốt tên **Sano Agent**, ký số như SanoVids và kênh cập nhật trên GitHub (D220); đang làm.
