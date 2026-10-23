# SANO desktop — SanoVids làm khu “Dựng phim” trong app SANO

> **Trạng thái:** chạy từ mã nguồn (quyết định D218 của SANO: canvasapp.io.vn là nhà cung cấp video chính, Minh chọn
> làm bản desktop SANO). Chưa có bản cài riêng cho SANO.

## 1. Mục đích

Mở app SANO trong cửa sổ desktop của SanoVids. Khu “Dựng phim” của SANO là chính SanoVids bản desktop, nên tạo được
**video thật** bằng tài khoản canvasapp.io.vn của từng người qua cổng canvasapp ([GATEWAY-CANVASAPP.md](GATEWAY-CANVASAPP.md)).
Máy chủ SANO chỉ giữ phiên của tài khoản team khi QTV kết nối (TH-38), mã hoá trên máy chủ (§5).

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
- Riêng popup `https://accounts.google.com/` (“Đăng nhập bằng Google” của SANO) mở thành cửa sổ con. Popup chỉ đi trong các
  trang đăng nhập của Google (`accounts.google.com`, `accounts.youtube.com`); link và popup con của nó mở trình duyệt. Đóng
  popup thì cookie tài khoản Google nó để lại trong thư mục dữ liệu bị xoá (SANO đã nhận token).
- Trang SANO thấy `window.sanoDesktop = { sanovidsUrl: 'app://bdp/', connectCanvasappTeam }` và đặt khung Dựng phim vào
  `sanovidsUrl`: bản SanoVids nằm trong app (`dist/`), không tải từ máy chủ SANO. `connectCanvasappTeam` ở §5.
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

## 5. Kết nối canvasapp cho team (QTV)

TH-38 (D224–D225): máy chủ SANO tạo video cho SanoVids bản web trong SANO bằng phiên đăng nhập canvasapp của **một tài
khoản team**. Khung Dựng phim của app (`app://bdp`) vẫn dùng đăng nhập riêng của từng người, không đổi.

1. QTV mở SANO trong app (chế độ SANO desktop), vào **Kết nối công cụ** → **Kết nối tài khoản team**.
2. App mở cửa sổ “Đăng nhập tài khoản canvasapp của team — Sano Agent” trên trang thật `https://canvasapp.io.vn/`. QTV tự
   đăng nhập tài khoản team ở đó (kể cả “Đăng nhập bằng Google”); app không thấy mật khẩu.
3. Khi canvasapp xác nhận đã đăng nhập (`GET /api/auth/state` → `authenticated: true`, kiểm lúc trang chuyển và mỗi 5 giây),
   app gửi cookie của phiên lên máy chủ SANO rồi đóng cửa sổ và xoá sạch phiên trên máy. Không đăng xuất canvasapp: làm vậy
   sẽ kết thúc đúng phiên vừa giao cho máy chủ.

Yêu cầu gửi lên SANO (main gửi bằng `fetch` của Node, thẳng tới origin của `SANO_URL`, không theo chuyển hướng, 60 giây):

```
POST <origin SANO>/api/video/admin/canvasapp-session
Authorization: Bearer <token Google của QTV trên SANO>
Content-Type: application/json
{ "v": 1, "cookies": [ { "name", "value", "hostOnly", "path", "secure", "httpOnly", "sameSite", "expirationDate"? } ] }
```

- Chỉ cookie của chính `canvasapp.io.vn` (`hostOnly: true`) hoặc `.canvasapp.io.vn`, theo luật của “Giữ đăng nhập”
  (`keeplogin-rules.keptCookieEntry`): không cookie Cloudflare, Google hay trang khác; cookie phiên và cookie có hạn chưa
  hết hạn (giữ `expirationDate`, tính bằng giây); bỏ giá trị có `;` hay ký tự điều khiển; 1–30 cookie, phải có `canvas_csrf`.
- Máy chủ SANO tự quyết ai là QTV, kiểm lại dữ liệu và thử phiên với canvasapp trước khi lưu (mã hoá bằng `SANO_SECRET_KEY`).
  Câu từ chối của máy chủ hiện nguyên văn trên bảng Kết nối công cụ.
- Token SANO phải còn hạn ít nhất 20 phút (cửa sổ đăng nhập chờ tối đa 15 phút); sắp hết hạn thì app không mở cửa sổ.
- Mỗi lúc chỉ một lần kết nối. Đóng cửa sổ, quá 15 phút, thiếu `canvas_csrf`, lỗi mạng hay máy chủ từ chối: không lưu gì
  trên máy, phiên vẫn bị xoá.

Cách giữ an toàn (`electron/sano-team-rules.cjs`, `main.cjs registerSanoTeamConnect`):

- Chỉ có ở chế độ SANO desktop. Lệnh `sano:connectCanvasappTeam` chỉ nhận từ khung chính của trang SANO (`fromSanoPage`):
  khung con, trang SanoVids hay cửa sổ khác đều bị từ chối.
- Cửa sổ dùng phân vùng riêng trong bộ nhớ `canvasapp-team` (không ghi đĩa, không phải `persist:canvasapp` của người dùng),
  sandbox, không preload, không tải tệp, quyền web như cửa sổ đăng nhập canvasapp, popup chỉ https.
- Cookie không tới trang nào, không nằm trong câu trả lời IPC hay dòng log nào.
