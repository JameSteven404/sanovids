# SANO desktop — SanoVids làm khu “Dựng phim” trong app SANO

> **Trạng thái:** chạy từ mã nguồn (quyết định D218 của SANO: canvasapp.io.vn là nhà cung cấp video chính, Minh chọn
> làm bản desktop SANO). Bản cài **Sano Agent** (D220/D223, mục 5–6): cấu hình, icon tạm và công cụ phát hành đã có,
> chưa phát hành bản nào.

## 1. Mục đích

Mở app SANO trong cửa sổ desktop của SanoVids. Khu “Dựng phim” của SANO là chính SanoVids bản desktop, nên tạo được
**video thật** bằng tài khoản canvasapp.io.vn của từng người qua cổng canvasapp ([GATEWAY-CANVASAPP.md](GATEWAY-CANVASAPP.md)).
Máy chủ SANO không giữ phiên hay cookie canvasapp nào.

## 2. Chạy

1. Chạy SANO trước (repo SANO-AGENT: `npm run dev`, mặc định `http://127.0.0.1:5173`; hoặc docker compose ở `http://127.0.0.1:8080`).
2. Đóng SanoVids nếu đang mở: hai chế độ dùng chung thư mục dữ liệu, chỉ mở được một cửa sổ.
3. Chạy `sano-desktop.bat` (địa chỉ khác: `sano-desktop.bat https://sano.example.vn`). File bat dựng lại SanoVids rồi mở SANO.
4. Trong SANO: **SẢN XUẤT → Dựng phim**. Take mới vẫn chạy ở *chế độ Phát triển* (giả lập, không tốn credit). Muốn tạo
   video thật: Cài đặt của SanoVids → cổng canvasapp → bật, rồi **Đăng nhập** trên trang thật canvasapp.io.vn.

## 3. Cách hoạt động

- `SANO_URL` chỉ có tác dụng khi chạy từ mã nguồn (bản đóng gói bỏ qua). Bản cài Sano Agent chỉ dùng địa chỉ nướng sẵn
  trong `package.json` của nó (`sanoAgent.url`, nằm trong `app.asar` có kiểm toàn vẹn); SanoVids đóng gói không có địa
  chỉ nào. Nhận `https://…`, hoặc `http://` trên chính máy (`localhost`, `127.0.0.1`); chỉ lấy origin, tên máy chỉ gồm
  chữ, số, `-` và `.` (vì origin đi vào CSP). Giá trị khác: app không mở (`hardening-rules.sanoShell`).
- Thông báo main gửi tới trang (`devAccess:state`, `updates:state`) đi tới khung `app://bdp` (`hardening-rules.appFrames`),
  không bao giờ tới trang SANO.
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
- Địa chỉ SANO (`SANO_URL`, hoặc địa chỉ nướng sẵn của Sano Agent) phải là địa chỉ cuối: máy chủ chuyển hướng ngay lần mở
  đầu thì cửa sổ báo "SANO tại … chuyển hướng sang …" với **Thử lại / Thoát** (từ mã nguồn: in cả lỗi ra console).
- Trong khung, SanoVids không có nút “Chọn thư mục tải về” (trình duyệt không cho khung khác origin mở hộp chọn thư mục).
  “Lưu video” và nút Thư mục trên canvas vẫn dùng hộp thoại của app.
- Tải tệp từ trang SANO bị chặn (chỉ cho tải `blob:app://bdp/…`).

## 5. Bản cài Sano Agent

Cùng mã với SanoVids, đóng gói bằng `sano-agent/electron-builder.cjs` (cấu hình build của SanoVids, đổi danh tính):

| | SanoVids | Sano Agent |
|---|---|---|
| appId / AppUserModelId | `com.sanovids.app` | `com.sanoagent.app` (mục gỡ cài riêng) |
| Exe / trình gỡ / thư mục cài | `SanoVids.exe` | `Sano Agent.exe`, `Uninstall Sano Agent.exe`, `%LOCALAPPDATA%\Programs\Sano Agent` |
| Bộ cài | `SanoVids-Setup/Portable-x.y.z.exe` | `SanoAgent-Setup/Portable-x.y.z.exe`, dòng phiên bản riêng (0.1.0) |
| Kênh cập nhật | `sanovids-releases` | `sano-agent-releases`; cache `%LOCALAPPDATA%\sano-agent-updater` |
| Chữ ký | chứng chỉ `7489AB…`, timestamp, 4 DLL, tự kiểm chữ ký | giống hệt (cùng `win`, cùng ghim `sanovids.signers`) |
| Cửa sổ | SanoVids | SANO ở `http://127.0.0.1:8080/` (nướng sẵn), Dựng phim = SanoVids |

- **Dữ liệu chung (D223):** Sano Agent mở `%APPDATA%\SanoVids` (cùng dự án, cookie canvasapp, `dev-access.json`, tuỳ chọn tự
  tải). Riêng file của trình cập nhật: `updater-sano-agent.json`, `logs\updater-sano-agent.log`. Gỡ Sano Agent không xoá
  thư mục đó.
- **Sao lưu** `%APPDATA%\SanoVids` (đóng cả hai app) trước lần mở Sano Agent đầu tiên. **Không mở cùng lúc** hai app.
- **Cùng commit, cùng Electron:** bản Sano Agent build từ commit của bản SanoVids công khai mới nhất;
  `release:check:sano-agent` báo ✗ khi tag SanoVids đó không trỏ vào HEAD hoặc Electron trong `package-lock.json` khác
  Electron của tag đó. Đổi Electron hoặc định dạng dữ liệu thì phát hành **cả hai**, theo cả hai chiều: SanoVids lên Electron
  mới thì cũng phát hành Sano Agent từ commit đó ([UPDATES.md](UPDATES.md) mục 3, bước 8).
- **Bản cũ không mở dữ liệu bản mới đã mở:** hai app tự cập nhật riêng, nên app kia có thể đã lên Electron mới trước. Mỗi
  lần mở, app ghi Electron của nó vào `%APPDATA%\SanoVids\electron-version` (giữ số mới nhất; chạy từ mã nguồn cũng ghi).
  Electron *major* của app cũ hơn số đó thì app không mở, báo cài bản mới nhất ở trang tải về của nó (chưa mở thì không tự
  cập nhật được). Khác bản vá cùng major thì vẫn mở.
- **Chế độ Phát triển** của bản cài bị khoá như SanoVids, chỉ mở bằng khoá của chủ (`sanovids.devUnlockKeys`). Chưa mở
  khoá thì take đi qua cổng canvasapp và **tốn credit thật**.
- **Máy chủ SANO** ở cổng 8080 phải có khung desktop (`window.sanoDesktop`): build image từ nhánh SANO
  `claude/sano-desktop-20261023` (hoặc sau khi nhánh đó vào main: `docker compose up -d --build` trong `E:\SANO AGENT`).
  Thiếu khung đó thì Dựng phim là `/sanovids/` bản web: dữ liệu riêng, không có cổng canvasapp. Đổi địa chỉ (ví dụ khi có
  HTTPS): sửa `sanoAgent.url` trong `sano-agent/electron-builder.cjs` rồi phát hành bản mới.
- Không mở được SANO (máy chủ tắt, sai cổng): cửa sổ báo "Không mở được SANO tại …" với **Thử lại / Thoát**.
- **Icon tạm** (xám xanh `#475569`): nguồn `sano-agent/icon-source/*.svg` (8 file cùng tên, cùng khung với
  `build/icon-source`). Bộ nhận diện thật do Codex làm; có SVG mới thì chạy
  `node scripts/make-icons.mjs --src sano-agent/icon-source --out <thư mục tạm>` rồi chép `build/icon.ico`, `icon.png`,
  `installerSidebar.bmp`, `uninstallerSidebar.bmp`, `installerHeader.bmp` vào `sano-agent/brand/build/`.
- Giấy phép trong bộ cài tạm là `build/license_vi.txt` của SanoVids; Minh duyệt bản riêng.
- Không build song song hai app trong cùng một checkout: chung `dist/` và `build/release-notes.md`.

## 6. Phát hành Sano Agent

Chủ dự án làm theo đúng thứ tự (từ checkout `main` sạch, trên máy có khoá ký):

1. **Duyệt định danh vĩnh viễn:** appId `com.sanoagent.app`, tên app và tên exe `Sano Agent`, name `sano-agent`, repo
   `JameSteven404/sano-agent-releases`, địa chỉ `http://127.0.0.1:8080/`. Đổi sau bản đầu = GUID mới, mục cài mới, gãy
   kênh cập nhật.
2. **Ghim khoá mở khoá chế độ Phát triển** nếu `package.json` chưa có `sanovids.devUnlockKeys`: chạy
   `scripts\owner\Tao khoa mo khoa.bat`, gửi dòng ghim và mã kiểm tra để thêm vào `package.json`
   (`release:check` của cả hai app chặn khi thiếu).
3. **Merge** nhánh này vào `main` (trước đó sửa ngày ở mục `## [x.y.z] — yyyy-mm-dd — …` của
   `sano-agent/CHANGELOG.md` nếu cần; bản sau: tăng `version` trong `sano-agent/electron-builder.cjs` và thêm mục mới).
   Nếu bản SanoVids công khai mới nhất không build từ commit này, phát hành SanoVids (tăng version) từ chính commit này
   trước; commit đó mang cả hai lần tăng version và cả hai mục CHANGELOG.
4. **Đặt tag nguồn** trên đúng commit đó của `main`: `git tag -a sano-agent-v0.1.0 -m "Sano Agent 0.1.0"` rồi
   `git push origin sano-agent-v0.1.0`.
5. **Tạo repo công khai** `JameSteven404/sano-agent-releases` có nhánh `main` với `README.md` (chép từ
   `sano-agent/releases-repo/README.md`), `LICENSE.txt`, `SanoVids-NguyenGiangMinh.cer`, `tin-cay-chung-chi.ps1` (chép từ
   `scripts/releases-repo/`).
6. **Build:** `npm ci`, `npm test`, rồi `npm run dist:sano-agent` (ra `release\sano-agent\`).
7. **Kiểm tra:** `npm run release:check:sano-agent`: mọi dòng ✓ (chữ ký, app-update.yml trỏ `sano-agent-releases` với
   `updaterCacheDirName: sano-agent-updater`, cùng commit và Electron với SanoVids). Thử cài trên máy đã sao lưu dữ liệu (mục 5).
8. **Đăng:** `npm run release:publish:sano-agent` (chỉ repo công khai; repo nguồn chỉ có tag `sano-agent-v…`, không có
   release). Repo công khai dùng tag `v0.1.0`, như electron-updater cần.
