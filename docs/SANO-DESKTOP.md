# SANO desktop — SanoVids làm khu “Dựng phim” trong app SANO

> **Trạng thái:** chạy từ mã nguồn (quyết định D218 của SANO: canvasapp.io.vn là nhà cung cấp video chính, Minh chọn
> làm bản desktop SANO). Bản cài **Sano Agent** (D220/D223, mục 5–6): cấu hình, icon theo nhận diện đã chọn (D232) và
> công cụ phát hành đã có, chưa phát hành bản nào.
>
> **D235 (2026-10-27): SanoVids gộp vào Sano Agent.** Từ nay chỉ phát hành **Sano Agent**; SanoVids sống tiếp thành khu
> **Canvas** bên trong. Mọi phiên bản về **1.0.0**, một nguồn duy nhất là `version` trong `package.json`. SanoVids 1.0.0
> là bản cuối qua kênh cập nhật cũ (D236): chỉ để báo "SanoVids đã gộp vào Sano Agent", có nút tải Sano Agent; sau đó
> SanoVids ngừng phát hành. Dự án đi theo vì hai app dùng chung `%APPDATA%\SanoVids` (D223). Bản 1.0 không có Google
> (D234): SANO chạy ở chế độ demo, máy chủ chạy bằng Docker trên cùng máy (D233).

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
  đầu thì cửa sổ báo "SANO tại … chuyển hướng sang …" với **Thử lại / Mở Canvas / Thoát** (từ mã nguồn: in cả lỗi ra
  console).
- Trong khung, SanoVids không có nút “Chọn thư mục tải về” (trình duyệt không cho khung khác origin mở hộp chọn thư mục).
  “Lưu video” và nút Thư mục trên canvas vẫn dùng hộp thoại của app.
- Tải tệp từ trang SANO bị chặn (chỉ cho tải `blob:app://bdp/…`).

## 5. Bản cài Sano Agent

Cùng mã với SanoVids, đóng gói bằng `sano-agent/electron-builder.cjs` (cấu hình build của SanoVids, đổi danh tính):

| | SanoVids | Sano Agent |
|---|---|---|
| appId / AppUserModelId | `com.sanovids.app` | `com.sanoagent.app` (mục gỡ cài riêng) |
| Exe / trình gỡ / thư mục cài | `SanoVids.exe` | `Sano Agent.exe`, `Uninstall Sano Agent.exe`, `%LOCALAPPDATA%\Programs\Sano Agent` |
| Bộ cài | `SanoVids-Setup/Portable-x.y.z.exe` | `SanoAgent-Setup/Portable-x.y.z.exe`, cùng số phiên bản `package.json` (1.0.0, D235) |
| Kênh cập nhật | `sanovids-releases` | `sano-agent-releases`; cache `%LOCALAPPDATA%\sano-agent-updater` |
| Chữ ký | chứng chỉ `7489AB…`, timestamp, 4 DLL, tự kiểm chữ ký | giống hệt (cùng `win`, cùng ghim `sanovids.signers`) |
| Cửa sổ | SanoVids | SANO ở `http://127.0.0.1:8080/` (nướng sẵn), Dựng phim = SanoVids |

- **Dữ liệu chung (D223):** Sano Agent mở `%APPDATA%\SanoVids` (cùng dự án, cookie canvasapp, `dev-access.json`, tuỳ chọn tự
  tải). Riêng file của trình cập nhật: `updater-sano-agent.json`, `logs\updater-sano-agent.log`. Gỡ Sano Agent không xoá
  thư mục đó.
- **Sao lưu** `%APPDATA%\SanoVids` (đóng cả hai app) trước lần mở Sano Agent đầu tiên. **Không mở cùng lúc** hai app.
- **Cùng commit, cùng Electron:** bản Sano Agent build từ commit của bản SanoVids công khai mới nhất, hoặc từ commit của
  tag SanoVids cùng số phiên bản đã push nhưng chưa đăng (Sano Agent đăng trước, SanoVids ngay sau, mục 6);
  `release:check:sano-agent` báo ✗ khi không tag nào như vậy trỏ vào HEAD, hoặc Electron trong `package-lock.json` khác
  Electron của bản SanoVids công khai mới nhất. Đổi Electron hoặc định dạng dữ liệu thì phát hành **cả hai**, theo cả hai chiều: SanoVids lên Electron
  mới thì cũng phát hành Sano Agent từ commit đó ([UPDATES.md](UPDATES.md) mục 3, bước 8).
- **Bản cũ không mở dữ liệu bản mới đã mở:** hai app tự cập nhật riêng, nên app kia có thể đã lên Electron mới trước. Mỗi
  lần mở, app ghi Electron của nó vào `%APPDATA%\SanoVids\electron-version` (giữ số mới nhất; chạy từ mã nguồn cũng ghi).
  Electron *major* của app cũ hơn số đó thì app không mở, báo cài bản mới nhất ở trang tải về của nó (chưa mở thì không tự
  cập nhật được). Khác bản vá cùng major thì vẫn mở. Không đọc/ghi được file đó (bị khoá, chỉ đọc, phần mềm diệt virus) thì
  app cũng không mở. File đã có nhưng rỗng/sai định dạng thì giữ nguyên và báo liên hệ người quản lý bản cài để kiểm tra
  bản sao lưu; app không tự ghi đè số phiên bản. Chỉ file chưa tồn tại (ENOENT) mới được khởi tạo.
  **Không bao giờ xoá hoặc tự sửa `electron-version`**: app cũ bị từ chối vì major mới hơn thì cài bản mới nhất của nó.
- **Chế độ Phát triển** của bản cài bị khoá như SanoVids, chỉ mở bằng khoá của chủ (`sanovids.devUnlockKeys`). Chưa mở
  khoá thì take đi qua cổng canvasapp và **tốn credit thật**.
- **Máy chủ SANO** ở cổng 8080 phải có khung desktop (`window.sanoDesktop`): build image từ nhánh SANO
  `claude/sano-desktop-20261023` (hoặc sau khi nhánh đó vào main: `docker compose up -d --build` trong `E:\SANO AGENT`).
  Thiếu khung đó thì Dựng phim là `/sanovids/` bản web: dữ liệu riêng, không có cổng canvasapp. Đổi địa chỉ (ví dụ khi có
  HTTPS): sửa `sanoAgent.url` trong `sano-agent/electron-builder.cjs` rồi phát hành bản mới.
- Không mở được SANO (máy chủ tắt, sai cổng): cửa sổ báo "Không mở được SANO tại …" với **Thử lại / Mở Canvas / Thoát**
  (Enter là Thử lại, Esc là Thoát). **Mở Canvas** (D237) mở SanoVids chạy riêng ngay trong cửa sổ đó, như trước, không cần
  Docker. Khi đó cửa sổ chỉ ở trong `app://bdp`, không về SANO nữa: muốn quay về SANO thì mở lại app.
- **Icon**: dấu S/phát SANO trên ô đỏ `#E60000`, phương án A của bộ nhận diện TH-35 do Codex làm, Minh chọn ngày
  2026-10-27 (D232). Nguồn `sano-agent/icon-source/*.svg` là 8 SVG của SANO-AGENT `design/sano-agent/integration/icon-source/`
  (cùng tên, cùng khung với `build/icon-source`; 16/20/24 px là icon micro riêng). Đổi SVG thì chạy
  `node scripts/make-icons.mjs --src sano-agent/icon-source --out <thư mục tạm>` rồi chép `build/icon.ico`, `icon.png`,
  `installerSidebar.bmp`, `uninstallerSidebar.bmp`, `installerHeader.bmp` vào `sano-agent/brand/build/`.
- Giấy phép: một bản chung cho "Sano Agent (gồm khu Canvas — SanoVids)", giữ nguyên mọi điều khoản cũ, chỉ đổi tên.
  Ba bản giống hệt từng byte: `LICENSE.txt`, `build/license_vi.txt` (trang giấy phép của bộ cài, cả hai app) và
  `scripts/releases-repo/LICENSE.txt`. Minh duyệt lời văn trước khi phát hành.
- Không build song song hai app trong cùng một checkout: chung `dist/` và `build/release-notes.md`.

## 6. Phát hành Sano Agent

Chủ dự án làm theo đúng thứ tự (từ checkout `main` sạch, trên máy có khoá ký):

1. **Duyệt định danh vĩnh viễn:** appId `com.sanoagent.app`, tên app và tên exe `Sano Agent`, name `sano-agent`, repo
   `JameSteven404/sano-agent-releases`, địa chỉ `http://127.0.0.1:8080/`. Đổi sau bản đầu = GUID mới, mục cài mới, gãy
   kênh cập nhật.
2. ~~Ghim khoá mở khoá chế độ Phát triển~~ **Đã xong:** `sanovids.devUnlockKeys` đã ghim trên `main` từ 0.6.0
   (`release:check` của cả hai app vẫn chặn khi thiếu).
3. **Merge** nhánh này vào `main` (trước đó sửa ngày ở mục `## [1.0.0] — yyyy-mm-dd — …` của `CHANGELOG.md` và
   `sano-agent/CHANGELOG.md` nếu cần). Số phiên bản chỉ có một nguồn: `version` trong `package.json` (D235); bản sau
   tăng số đó và thêm mục mới vào `sano-agent/CHANGELOG.md`. Bản 1.0.0: **Sano Agent đăng trước, SanoVids 1.0.0**
   (bản cuối, D236) **đăng sau cùng**, cả hai từ chính commit này. Nút "Tải Sano Agent" của bản cuối SanoVids mở trang
   tải về của Sano Agent, nên trang đó phải có bản cài trước.
4. **Build cả hai**, lần lượt: `npm ci`, `npm test`, `npm run dist:sano-agent` (ra `release\sano-agent\`), rồi
   `npm run dist:win` (ra `release\`). Có mạng (dấu thời gian của chữ ký). Chưa cần tag: build chỉ cần đúng commit.
5. **Thử bản cài Sano Agent** theo mục 7. Có lỗi: sửa trên nhánh, merge, quay lại bước 4. Lúc này chưa có tag, chưa đăng
   gì, nên không mất bản SanoVids nào.
6. **Đặt tag nguồn** cả hai trên đúng commit đó của `main`: `git tag -a sano-agent-v1.0.0 -m "Sano Agent 1.0.0"`,
   `git tag -a v1.0.0 -m "SanoVids 1.0.0"`, rồi `git push origin sano-agent-v1.0.0 v1.0.0`.
7. **Tạo repo công khai** `JameSteven404/sano-agent-releases` có nhánh `main` với `README.md` (chép từ
   `sano-agent/releases-repo/README.md`), `LICENSE.txt`, `SanoVids-NguyenGiangMinh.cer`, `tin-cay-chung-chi.ps1` (chép từ
   `scripts/releases-repo/`).
8. **Kiểm tra cả hai:** `npm run release:check:sano-agent` và `npm run release:check`: mọi dòng ✓.
   `release:check:sano-agent` kiểm chữ ký, app-update.yml trỏ `sano-agent-releases` với
   `updaterCacheDirName: sano-agent-updater`, tag `v1.0.0` của SanoVids trỏ vào HEAD (cả trên GitHub), và Electron giống
   bản SanoVids công khai mới nhất.
9. **Đăng Sano Agent:** `npm run release:publish:sano-agent` (chỉ repo công khai; repo nguồn chỉ có tag `sano-agent-v…`,
   không có release). Repo công khai dùng tag `v1.0.0`, như electron-updater cần. Mở
   `https://github.com/JameSteven404/sano-agent-releases/releases/latest`: phải thấy bộ cài 1.0.0.
10. **Đăng SanoVids 1.0.0 ngay sau đó:** `npm run release:publish` ([UPDATES.md](UPDATES.md) mục 3, bước 6–7). Đẩy tay
    `scripts/releases-repo/README.md` mới (báo đã gộp, có liên kết tải Sano Agent) lên `main` của `sanovids-releases`.

## 7. Kiểm thử bản cài 1.0

Minh tự làm trên máy của mình. Agent không chạy bộ cài hay bản đóng gói, không mở thư mục `%APPDATA%\SanoVids` thật.

1. **Chuẩn bị:** đóng cả SanoVids và Sano Agent. Chép thư mục `%APPDATA%\SanoVids` ra chỗ khác để sao lưu.
2. **Chữ ký:** chuột phải `SanoAgent-Setup-1.0.0.exe` → Properties → Digital Signatures: người ký
   **Nguyễn Giang Minh (Jame Steven)**, dấu vân tay `7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`, có dấu thời gian.
3. **Cài:** chạy bộ cài. SmartScreen (nếu hiện): **Thông tin khác** → Nhà phát hành là tên tác giả → **Vẫn chạy**.
4. **Trang giấy phép:** bộ cài hiện "SANO AGENT — GIẤY PHÉP SỬ DỤNG", đúng bản Minh đã duyệt.
5. **Thư mục cài:** để mặc định `%LOCALAPPDATA%\Programs\Sano Agent`, không chọn thư mục của SanoVids.
6. **Lối tắt:** Start menu và Desktop có **Sano Agent** với icon dấu S/phát trên ô đỏ.
7. **Icon:** thanh tác vụ và khay hệ thống hiện đúng icon đó khi app chạy.
8. **Phiên bản:** Cài đặt → Giới thiệu hiện **1.0.0**, chữ ký số hợp lệ, đúng dấu vân tay ở bước 2.
9. **SANO mở được:** bật máy chủ SANO bằng Docker rồi mở app: SANO hiện ở cửa sổ riêng. Trước khi các PR SANO
   (#50 → #53 → #65 → #67 → #68) vào main, `main` chưa có Canvas: dựng từ checkout của nhánh #68
   (`docker compose up -d --build` trong `E:\SANO-AGENT-wt-docker`). Sau khi merge: `docker compose up -d --build` trong
   `E:\SANO AGENT`.
10. **Canvas và Trợ lý:** vào Canvas: SanoVids hiện toàn màn hình, gọn; nút **Trợ lý** ở góc phải trên mở trợ lý dự án.
11. **Không có SANO:** tắt Docker (`docker compose stop`), mở lại app: hộp thoại "Không mở được SANO tại …" có
    **Thử lại / Mở Canvas / Thoát**. Bật lại Docker rồi bấm **Thử lại**: vào được SANO. Tắt Docker lần nữa, mở lại app,
    bấm **Mở Canvas**: SanoVids mở riêng, tạo và mở dự án được.
12. **Một take thật, rẻ nhất:** trong Canvas, một cảnh **Seedance 2.5, 480p**, thời lượng ngắn nhất, qua cổng canvasapp.
    Đúng: credit trừ đúng giá hộp xác nhận báo, video tải về được. Chỉ một take.
13. **Dự án cũ:** các dự án làm trong SanoVids có đủ trong Canvas (cảnh, ảnh, video đã tải).
14. **Gỡ cài:** gỡ Sano Agent (Cài đặt Windows → Ứng dụng). Thư mục `%APPDATA%\SanoVids` vẫn còn đủ dự án.

Lỗi ở bước nào: ghi số bước, ảnh chụp hộp thoại và `%APPDATA%\SanoVids\logs\updater-sano-agent.log` (nếu có). Không gửi
cookie, mật khẩu hay khoá.

## 8. Rút lui

Khi bản mới hỏng. Không bao giờ xoá release (máy đã cài cần nó để so chữ ký và tải bản vá).

**App (Sano Agent, hoặc bản cuối SanoVids):**
1. Trên repo công khai, sửa release hỏng → đánh dấu **pre-release**. App bỏ qua pre-release, nên máy chưa tải sẽ không
   nhận bản đó. Máy đã tải về rồi vẫn có thể cài nó khi tắt app; bản vá ở bước 2 thay nó.
2. Phát hành **1.0.1** từ commit tốt cuối cùng (nhánh mới từ commit đó, tăng `version`, thêm mục CHANGELOG). App chỉ cài
   bản **mới hơn** bản đang chạy, nên không quay về số cũ được: luôn đi tiếp số mới.
3. **Không bao giờ hạ Electron major.** App ghi Electron của nó vào `%APPDATA%\SanoVids\electron-version`; app có major
   cũ hơn số đó thì không mở. Bản vá phải giữ Electron major của bản hỏng (hoặc mới hơn).
4. Lưu ý công cụ: `release:check:sano-agent` hiện đòi bản SanoVids công khai mới nhất (hoặc tag SanoVids cùng phiên bản)
   build từ cùng commit, và cùng Electron. SanoVids đã ngừng sau 1.0.0, nên trước khi phát hành 1.0.1 phải sửa luật này (mục 5 "Cùng commit, cùng
   Electron").

**Máy chủ SANO (Docker trên cùng máy, D233):**
- Trước khi lên 1.0, giữ bản cũ: `docker tag sano-api:local sano-api:pre-1.0`, `docker tag sano-web:local sano-web:pre-1.0`,
  `docker compose stop`, rồi sao lưu volume:
  `docker run --rm -v sano_sano-data:/data -v E:\sano-backup:/backup alpine tar cf /backup/sano-data-pre-1.0.tar -C /data .`
- Quay về: `docker compose down` (không thêm `-v`), `docker tag sano-api:pre-1.0 sano-api:local`,
  `docker tag sano-web:pre-1.0 sano-web:local`, khôi phục volume:
  `docker run --rm -v sano_sano-data:/data -v E:\sano-backup:/backup alpine sh -c "find /data -mindepth 1 -delete && tar xf /backup/sano-data-pre-1.0.tar -C /data"`,
  rồi `docker compose up -d` **không** `--build` (`--build` dựng lại image từ mã mới).
