# SANO desktop — SanoVids làm khu “Dựng phim” trong app SANO

> **Trạng thái:** chạy từ mã nguồn (quyết định D218 của SANO: canvasapp.io.vn là nhà cung cấp video chính, Minh chọn
> làm bản desktop SANO). Bản cài **Sano Agent** (D220/D223, mục 5–6): cấu hình, icon theo nhận diện đã chọn (D232) và
> công cụ phát hành đã có, chưa phát hành bản nào.
>
> **D235 (2026-10-27): SanoVids gộp vào Sano Agent.** Từ nay chỉ phát hành **Sano Agent**; SanoVids sống tiếp thành khu
> **Canvas** bên trong. Mọi phiên bản về **1.0.0**, một nguồn duy nhất là `version` trong `package.json`. SanoVids 1.0.0
> là bản cuối qua kênh cập nhật cũ (D236): chỉ để báo "SanoVids đã gộp vào Sano Agent", có nút tải Sano Agent; sau đó
> SanoVids ngừng phát hành. Dự án đi theo vì hai app dùng chung `%APPDATA%\SanoVids` (D223). Bản 1.0 không có Google
> (D234): SANO chạy ở chế độ demo.
>
> **D240 (2026-10-27): Sano Agent tự chứa như SanoVids.** Web SANO được build sẵn và đóng gói trong app, mở ở
> `app://sano/` (phương án D của TH-43). Người dùng không cần Docker, không cần máy chủ. Bản 1.0 không có API SANO.
> Thay D233 (máy chủ Docker).

## 1. Mục đích

Mở app SANO trong cửa sổ desktop của SanoVids. Khu “Dựng phim” của SANO là chính SanoVids bản desktop, nên tạo được
**video thật** bằng tài khoản canvasapp.io.vn của từng người qua cổng canvasapp ([GATEWAY-CANVASAPP.md](GATEWAY-CANVASAPP.md)).
Máy chủ SANO không giữ phiên hay cookie canvasapp nào.

## 2. Chạy

Có hai cách, đều từ mã nguồn:

- **Giống bản cài (D240):** `npm run build:sano` (dựng web SANO vào `sano-dist/`, cần checkout SANO, xem mục 5), rồi
  `sano-desktop.bat app://sano/`. Không cần chạy SANO riêng.
- **SANO từ máy chủ** (đang sửa SANO): chạy SANO trước (repo SANO-AGENT: `npm run dev`, mặc định
  `http://127.0.0.1:5173`), rồi `sano-desktop.bat` (địa chỉ khác: `sano-desktop.bat https://sano.example.vn`).

1. Đóng SanoVids nếu đang mở: hai chế độ dùng chung thư mục dữ liệu, chỉ mở được một cửa sổ.
2. Chạy `sano-desktop.bat` như trên. File bat dựng lại SanoVids rồi mở SANO.
3. Trong SANO: **Canvas**. Take mới vẫn chạy ở *chế độ Phát triển* (giả lập, không tốn credit). Muốn tạo
   video thật: Cài đặt của SanoVids → cổng canvasapp → bật, rồi **Đăng nhập** trên trang thật canvasapp.io.vn.
4. Đăng nhập tài khoản SANO ngay trong app (D253, mục 3a): thêm `SANO_API_URL=<máy chủ tài khoản SANO>` trước khi chạy,
   ví dụ `set SANO_API_URL=http://127.0.0.1:8787`. Không đặt thì app chạy như bản 1.0 (không có màn đăng nhập).

## 3. Cách hoạt động

- `SANO_URL` chỉ có tác dụng khi chạy từ mã nguồn (bản đóng gói bỏ qua). Bản cài Sano Agent chỉ dùng địa chỉ nướng sẵn
  trong `package.json` của nó (`sanoAgent.url`, nằm trong `app.asar` có kiểm toàn vẹn); SanoVids đóng gói không có địa
  chỉ nào. Nhận đúng `app://sano/` (web SANO đóng gói trong app, D240), `https://…`, hoặc `http://` trên chính máy
  (`localhost`, `127.0.0.1`); chỉ lấy origin, tên máy chỉ gồm chữ, số, `-` và `.` (vì origin đi vào CSP). Giá trị khác:
  app không mở (`hardening-rules.sanoShell`).
- `app://sano/` (D240): main phục vụ thư mục `sano-dist/` trong app, như `app://bdp/` phục vụ `dist/`. Chỉ ở chế độ này
  host `sano` mới có; SanoVids thường và SANO từ máy chủ vẫn trả 404 cho mọi host khác `bdp`. `app://sano/api/…` luôn trả
  404 dạng JSON (không có máy chủ), nên tab Máy chủ của SANO ghi "Chưa kết nối được API". Thiếu `sano-dist/index.html`
  thì app báo lỗi rồi thoát. Trang SANO có CSP riêng (`hardening-rules.SANO_PAGE_CSP`): chỉ file của nó, không script
  inline, khung duy nhất là `app://bdp`.
- Thông báo main gửi tới trang (`devAccess:state`, `updates:state`) đi tới khung `app://bdp` (`hardening-rules.appFrames`),
  không bao giờ tới trang SANO.
- Cửa sổ chính mở trang SANO và chỉ ở origin đó, kể cả khi máy chủ chuyển hướng; link ngoài mở trình duyệt.
- Trang SANO thấy `window.sanoDesktop = { sanovidsUrl: 'app://bdp/', google: { signIn, token, signOut }, account }`
  (`account`: mục 3a) và đặt khung
  Dựng phim vào `sanovidsUrl`: bản SanoVids nằm trong app (`dist/`), không tải từ máy chủ SANO. Chỉ khung chính của trang
  SANO nhận `sanoDesktop` (preload kiểm `process.isMainFrame`); main kiểm lại khung gửi của mọi lời gọi Google (`fromSano`:
  khung chính của cửa sổ chính, đúng origin SANO). Kiểm hai cổng này trong Electron thật (không chạy trong CI, không đăng
  nhập): `npx electron scripts/sano-desktop-probe.cjs`.
- **Đăng nhập bằng Google** (TH-36) chạy trong trình duyệt mặc định, không trong cửa sổ app (Google chặn trình duyệt nhúng):
  - `google.signIn()`: main lấy client ID từ `googleDesktopClientId` của `/api/assistant/status` trên máy chủ tài khoản
    (`SANO_API_URL`, mục 3a; không có thì trên origin SANO, nên `app://sano/` không có API thì là `not-configured`) (trang
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

## 3a. Tài khoản SANO trong app (D253)

Form đăng nhập (email hoặc tên người dùng + mật khẩu), **Tạo tài khoản** và **Quên mật khẩu** nằm ngay trong cửa sổ
Sano Agent (trang SANO vẽ form). Chỉ **Tiếp tục với Google** mở trình duyệt hệ thống (RFC 8252, như TH-36). Máy chủ là
API tài khoản của SANO (TH-44: `/api/auth/*`). Mã: `electron/sano-account-rules.cjs` (logic, mọi thứ được tiêm vào để
test), `main.cjs` `registerAccount`, `preload.cjs`.

- **Máy chủ:** từ mã nguồn `SANO_API_URL`; bản đóng gói chỉ đọc `sanoAgent.apiUrl` trong `package.json` của nó, do
  `sano-agent/electron-builder.cjs` nướng từ `SANO_API_URL` lúc build (`npm run dist:sano-agent`). Chỉ nhận
  `https://host[:port]`, hoặc `http://127.0.0.1|localhost|[::1]:<cổng>`; không đường dẫn, query, `#` hay user:pass.
  Không đặt thì bản cài không có `apiUrl`: `configured: false`, app y như 1.0. Đặt sai: từ mã nguồn thì in một dòng lỗi
  và tắt đăng nhập; lúc build thì build dừng. `release:check:sano-agent` so `sanoAgent` của bản build với cấu hình, nên
  chạy nó với cùng `SANO_API_URL` đã dùng khi build. Bản phát hành chỉ nhận `apiUrl` `https://` (release check từ
  chối bản nướng loopback): `http://127.0.0.1…` chỉ để thử trên máy, nên xoá `SANO_API_URL` (`set SANO_API_URL=`)
  trước khi `dist:sano-agent` trong shell đã dùng để chạy từ mã nguồn.
- **Đường đi:** trang SANO có CSP `connect-src 'self'`, không gọi được máy chủ. Mọi lời gọi đi trang → preload
  (`window.sanoDesktop.account`) → main → máy chủ, bằng `fetch` của Node (không gửi `Origin`, không cookie). Main kiểm
  khung gửi ở **mọi** lời gọi (`fromSano`: khung chính của cửa sổ chính, đúng origin SANO); nơi khác nhận
  `not-allowed`. Mỗi request: JSON, 20 giây, không theo chuyển hướng (`redirect: 'manual'` → lỗi).
- **Đăng nhập mật khẩu:** mỗi lần một `code_verifier` (32 byte ngẫu nhiên, base64url) và `state` mới; `POST login` với
  `client: 'desktop'`, `redirect_uri`, `code_challenge` (S256), `state`; lấy `code` trong `redirect` máy chủ trả (kiểm
  đúng `state` và đúng địa chỉ), rồi `POST token`. `redirect_uri` cố định `http://127.0.0.1:9/callback` và **không bao
  giờ được mở**: `authorizeField` của SANO chỉ cần loopback có cổng, bước đổi mã phải gửi lại đúng giá trị đó, còn thứ
  gắn mã vào app là `code_verifier` chỉ main giữ.
- **Google:** một lượt đăng nhập Google riêng (cùng `google-signin-rules.cjs`) lấy ID token trong trình duyệt, rồi
  `POST google { credential, …tham số authorize }` → mã → phiên như trên. Token Google (cả refresh token) bị bỏ ngay sau
  đó; `google` của TH-36 vẫn chạy riêng như cũ. Hết 5 phút thì hết giờ; `cancelGoogle()` huỷ lượt đang chờ, kể cả khi
  trình duyệt đã trả về và main đang đổi mã với máy chủ (phiên vừa cấp bị bỏ và kết thúc trên máy chủ).
- **Phiên:** `{ token: 'sano_…', expiresAt, user }` (30 ngày) mã hoá bằng `safeStorage.encryptString` ở
  `<thư mục dữ liệu>/sano-account.bin` (theo `SANOVIDS_PROFILE_DIR` nếu có). Máy không mã hoá được (cả Linux không có keyring,
  backend `basic_text`) thì chỉ giữ trong bộ nhớ (`persistent: false`, mở lại app phải đăng nhập lại); ghi file lỗi
  (ví dụ antivirus khoá) cũng vậy, và không để lại `sano-account.bin.tmp`. `status()` hỏi `GET /api/auth/me`: 401 hoặc 403 thì xoá
  phiên; mất mạng / máy chủ lỗi thì vẫn đăng nhập với người dùng đã lưu (`offline: true`); quá `expiresAt` thì coi như
  đã đăng xuất, không hỏi máy chủ. `signOut()` xoá bộ nhớ rồi xoá file, gửi `POST logout` nhưng không chờ. Không xoá được
  file (Windows khoá, `EPERM`) thì ghi đè file thành rỗng; không ghi đè được thì chờ `POST logout` (20 giây): máy chủ
  thu hồi (2xx hoặc 401) thì vẫn là đã đăng xuất (token vẫn nằm trong file: lần mở sau mà mất mạng thì app hiện lại
  người dùng cũ ở chế độ ngoại tuyến cho đến khi `/me` trả 401), còn không thì phiên được giữ lại (lần mở sau cũng thấy)
  và `signOut()` báo lỗi `sign-out-failed` "Phiên vẫn còn trên máy này. Kiểm tra mạng rồi thử lại, hoặc đóng hẳn Sano
  Agent rồi mở lại.", không bao giờ giả vờ đã đăng xuất. Trong lúc chờ máy chủ, `status()` và lần bấm đăng xuất thứ hai
  vẫn thấy người dùng đang đăng nhập. Phiên đăng xuất giữa lúc đang ghi file (đăng nhập, cập nhật hồ sơ) thì file vừa
  ghi bị xoá ngay, token không nằm lại trên đĩa.
- **Cầu nối** (khớp SANO web, TH-44 bước 3):
  ```ts
  type AccountUser = { id: string; name: string; email: string; username: string | null; admin: boolean }
  type AccountStatus = { configured: boolean; signedIn: boolean; user: AccountUser | null; persistent: boolean; offline?: boolean }
  window.sanoDesktop.account: {
    status(): Promise<AccountStatus>
    login({ identifier, password }): Promise<AccountStatus>
    register({ email, username, name, password }): Promise<{ ok: true }>
    forgot({ identifier }): Promise<{ ok: true }>
    google(): Promise<AccountStatus> // lỗi "Đã huỷ đăng nhập Google." khi huỷ
    cancelGoogle(): Promise<void>
    signOut(): Promise<AccountStatus>
  }
  ```
  Lỗi là `Error` có `message` tiếng Việt (của máy chủ, hoặc "Không kết nối được máy chủ tài khoản. Kiểm tra mạng rồi
  thử lại.", "Bản Sano Agent này chưa nối máy chủ tài khoản.") và `code` khi có (`not-configured`, `offline`,
  `bad-input`, `state-mismatch`, `cancelled`, `timeout`, `not-allowed`, `sign-out-failed`…). Error ném trong preload qua `contextBridge`
  chỉ còn `message`, nên preload dựng object `account` trong world của trang (`contextBridge.executeInMainWorld`) và
  Error được tạo ở đó. Preload cắt mỗi trường ở giới hạn + 1 ký tự; main kiểm lại (chỉ chuỗi; `identifier`/`email` ≤ 254,
  `password` ≤ 128, `name` ≤ 100, `username` ≤ 32).
- Không bao giờ ghi log mật khẩu, token hay mã. Kiểm thử: `src/lib/__tests__/sanoAccountRules.test.ts` (máy chủ, safeStorage,
  Google giả) và `npx electron scripts/sano-desktop-probe.cjs` (cầu nối trong Electron thật, không máy chủ).

## 4. Giới hạn

- Không mở cùng lúc SanoVids và SANO desktop (cùng thư mục dữ liệu: lần mở thứ hai chỉ đưa cửa sổ đang mở lên trước).
- Đăng nhập Google cần máy chủ SANO có `SANO_GOOGLE_DESKTOP_CLIENT_ID` và trang SANO bản gọi `sanoDesktop.google` (TH-36:
  web và máy chủ cập nhật trước, desktop sau). Thiếu thì SANO ở chế độ demo; Dựng phim với canvasapp vẫn chạy vì không cần
  đăng nhập SANO.
- Token Google của `sanoDesktop.google` (TH-36) chỉ ở bộ nhớ: mỗi lần mở app phải bấm đăng nhập Google một lần (trình duyệt thường đã nhớ tài khoản, chỉ cần chọn). Phiên tài khoản SANO thì được lưu (mục 3a).
- Trên Windows, sau khi đăng nhập cửa sổ app có thể chỉ nhấp nháy ở taskbar; trang trong trình duyệt nhắc quay lại app.
- Địa chỉ SANO (`SANO_URL`, hoặc địa chỉ nướng sẵn của Sano Agent) phải là địa chỉ cuối: máy chủ chuyển hướng ngay lần mở
  đầu thì cửa sổ báo "SANO tại … chuyển hướng sang …" với **Thử lại / Mở Canvas / Thoát** (từ mã nguồn: in cả lỗi ra
  console).
- Trong khung, SanoVids không có nút “Chọn thư mục tải về” (trình duyệt không cho khung khác origin mở hộp chọn thư mục).
  “Lưu video” và nút Thư mục trên canvas vẫn dùng hộp thoại của app.
- Tải tệp từ trang SANO bị chặn (chỉ cho tải `blob:app://bdp/…`).
- `app://sano/` (bản cài 1.0): dữ liệu SANO (bảng sản xuất, chat mẫu, nháp, giao diện) nằm trong bộ nhớ trang của
  `app://sano`, trong thư mục dữ liệu chung. SANO chưa có chức năng xuất dữ liệu. Đổi địa chỉ này sau khi phát hành thì
  mất dữ liệu đó, trừ khi có mã chuyển dữ liệu (TH-43 mục 5).

## 5. Bản cài Sano Agent

Cùng mã với SanoVids, đóng gói bằng `sano-agent/electron-builder.cjs` (cấu hình build của SanoVids, đổi danh tính):

| | SanoVids | Sano Agent |
|---|---|---|
| appId / AppUserModelId | `com.sanovids.app` | `com.sanoagent.app` (mục gỡ cài riêng) |
| Exe / trình gỡ / thư mục cài | `SanoVids.exe` | `Sano Agent.exe`, `Uninstall Sano Agent.exe`, `%LOCALAPPDATA%\Programs\Sano Agent` |
| Bộ cài | `SanoVids-Setup/Portable-x.y.z.exe` | `SanoAgent-Setup/Portable-x.y.z.exe`, cùng số phiên bản `package.json` (1.0.0, D235) |
| Kênh cập nhật | `sanovids-releases` | `sano-agent-releases`; cache `%LOCALAPPDATA%\sano-agent-updater` |
| Chữ ký | chứng chỉ `7489AB…`, timestamp, 4 DLL, tự kiểm chữ ký | giống hệt (cùng `win`, cùng ghim `sanovids.signers`) |
| Cửa sổ | SanoVids | SANO đóng gói sẵn ở `app://sano/` (D240), Canvas = SanoVids |
| Trong `app.asar` | `dist/`, `electron/` | thêm `sano-dist/` (web SANO và `BUILD.json`) |
| `THIRD-PARTY-NOTICES.txt` | `build/license-third-party.txt` | `build/license-third-party-sano-agent.txt`: thêm các gói của web SANO |

- **Dữ liệu chung (D223):** Sano Agent mở `%APPDATA%\SanoVids` (cùng dự án, cookie canvasapp, `dev-access.json`, tuỳ chọn tự
  tải). Riêng file của trình cập nhật: `updater-sano-agent.json`, `logs\updater-sano-agent.log`. Gỡ Sano Agent không xoá
  thư mục đó.
- **Sao lưu** `%APPDATA%\SanoVids` (đóng cả hai app) trước lần mở Sano Agent đầu tiên. **Không mở cùng lúc** hai app.
- **Cùng commit, cùng Electron:** bản Sano Agent build từ commit của bản SanoVids công khai mới nhất, hoặc từ commit của
  tag SanoVids cùng số phiên bản đã push nhưng chưa đăng (Sano Agent đăng trước, SanoVids sau, mục 6 bước 10);
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
- **Web SANO trong app (D240):** người dùng không cần Docker hay máy chủ. `npm run dist:sano-agent` chạy
  `scripts/build-sano.mjs` trước electron-builder:
  - Lấy đúng commit ghim trong `sano-agent/sano.json` (`{ repo, commit }`) từ một checkout SANO trên máy: biến môi
    trường `SANO_REPO`, mặc định `E:/SANO-AGENT-wt-docker` (một worktree của repo SANO; worktree nào cũng đọc được commit
    ghim). Hiện TẠM ghim b62623d, đầu nhánh SANO `claude/dang-nhap-trong-app-20261028` chưa merge (nối sau PR SANO #80, D253: trang đăng nhập trong app); trước khi merge PR này phải ghim lại commit SANO đã lên main (trước đó ghim 03089b2, đầu #70). Sau khi Minh merge các
    PR SANO bằng "Create a merge commit", giữ nguyên ghim nếu
    `git -C "$SANO_REPO" merge-base --is-ancestor <commit trong sano.json> origin/main` trả 0; chỉ đổi ghim (rồi dựng
    và thử lại) khi #70 không vào main nguyên vẹn (squash, rebase). Có thể trỏ `SANO_REPO` vào checkout `main`.
  - `git archive` chỉ lấy file cần để build web (`package.json`, lockfile, `tsconfig.json`, `vite.config.ts`,
    `index.html`, `login.html` (trang đăng nhập web TH-44, từ PR SANO #80), `public/`, `web/`, `shared/`). Không lấy
    `knowledge/`, `context/`, máy chủ.
  - Build trong thư mục tạm bằng lockfile của SANO (`npm ci --ignore-scripts`, `npm run build`), vì SANO dùng Vite 7 và
    lucide-react 0.577. Có source map thì dừng (repo SANO là private).
  - Chép kết quả ra `sano-dist/` (không đưa vào Git) kèm `BUILD.json` `{ commit, version }`. Không bao giờ ghi vào `dist/`.
  - Ghi `build/license-third-party-sano-agent.txt`: giấy phép của SanoVids cộng các gói web SANO (react, react-dom,
    lucide-react 0.577…). Bộ cài Sano Agent chép file này thành `THIRD-PARTY-NOTICES.txt`.
  - Cần git, npm và mạng. Chạy riêng: `npm run build:sano`.
- Mã SANO đã biên dịch nằm trong bộ cài: ai tải bộ cài cũng giải nén đọc được (không có source map, không có khoá; có
  giao diện nội bộ, D242 cho phép). Dữ liệu mẫu là dữ liệu trung tính từ commit ghim (dữ liệu mẫu trung tính từ SANO #70, D249); mỗi lần đổi
  ghim, commit mới cũng phải giữ dữ liệu mẫu trung tính (D242). Mỗi lần sửa SANO là một bản Sano Agent ký số mới.
- **Từ mã nguồn hoặc máy chủ team:** `SANO_URL` vẫn nhận `https://…` và `http://localhost`. Không mở được SANO ở địa chỉ
  đó (máy chủ tắt, sai cổng): cửa sổ báo "Không mở được SANO tại …" với **Thử lại / Mở Canvas / Thoát** (Enter là Thử lại,
  Esc là Thoát). **Mở Canvas** (D237) mở SanoVids chạy riêng ngay trong cửa sổ đó. Khi đó cửa sổ chỉ ở trong
  `app://bdp`, không về SANO nữa: muốn quay về SANO thì mở lại app. Với `app://sano/` hộp thoại này thực tế không hiện
  (trang nằm trong app). Đổi địa chỉ nướng sẵn (ví dụ khi có máy chủ team HTTPS): sửa `sanoAgent.url` trong
  `sano-agent/electron-builder.cjs` rồi phát hành bản mới.
- **Icon**: dấu S/phát SANO trên ô đỏ `#E60000`, phương án A của bộ nhận diện TH-35 do Codex làm, Minh chọn ngày
  2026-10-27 (D232). Nguồn `sano-agent/icon-source/*.svg` là 8 SVG của SANO-AGENT `design/sano-agent/integration/icon-source/`
  (cùng tên, cùng khung với `build/icon-source`; 16/20/24 px là icon micro riêng). Đổi SVG thì chạy
  `node scripts/make-icons.mjs --src sano-agent/icon-source --out <thư mục tạm>` rồi chép `build/icon.ico`, `icon.png`,
  `installerSidebar.bmp`, `uninstallerSidebar.bmp`, `installerHeader.bmp` vào `sano-agent/brand/build/`.
- Giấy phép: một bản chung cho "Sano Agent (gồm khu Canvas — SanoVids)", giữ nguyên mọi điều khoản cũ, chỉ đổi tên.
  Ba bản giống hệt từng byte: `LICENSE.txt`, `build/license_vi.txt` (trang giấy phép của bộ cài, cả hai app) và
  `scripts/releases-repo/LICENSE.txt`. Minh đã duyệt lời văn ngày 2026-10-27 (D238).
- Không build song song hai app trong cùng một checkout: chung `dist/` và `build/release-notes.md`.

## 6. Phát hành Sano Agent

Chủ dự án làm theo đúng thứ tự (từ checkout `main` sạch, trên máy có khoá ký):

1. ~~Duyệt định danh vĩnh viễn~~ **Đã duyệt 2026-10-27 (D243):** appId `com.sanoagent.app`, tên app và tên exe
   `Sano Agent`, name `sano-agent`, repo `JameSteven404/sano-agent-releases`, địa chỉ `app://sano/`. Không đổi nữa: đổi
   sau bản đầu = GUID mới, mục cài mới, gãy kênh cập nhật; đổi địa chỉ SANO = mất dữ liệu SANO của người dùng (bộ nhớ
   trang gắn với địa chỉ). **Điều kiện:**
   - Trước bước 3 (merge): commit SANO ghim trong `sano-agent/sano.json` có dữ liệu mẫu trung tính (D242, D249: SANO
     #70) và nằm trên SANO main: `git -C "$SANO_REPO" fetch origin`, rồi
     `git -C "$SANO_REPO" merge-base --is-ancestor <commit trong sano.json> origin/main` phải trả 0. SANO #68 và #70
     merge bằng "Create a merge commit" (squash hay rebase làm commit ghim không lên main). Chưa có công cụ nào tự kiểm
     điều này: `release:check:sano-agent` chỉ so `BUILD.json` với `sano.json`.
   - Trước bước 9 (đăng): SANO đã xác nhận vector gốc và quyền dùng dấu S/phát (D244); có bản sao lưu ngoại tuyến của `.pfx` ngoài máy
     chính (D245). Nếu D244 không xác nhận được và Minh chọn icon tạm (cần D mới thay D232) thì đó là một commit mới: quay lại bước 3; nếu đã
     qua bước 6 thì tag đã push trỏ sai commit: dời tag hoặc tăng số phiên bản.
2. ~~Ghim khoá mở khoá chế độ Phát triển~~ **Đã xong:** `sanovids.devUnlockKeys` đã ghim trên `main` từ 0.6.0
   (`release:check` của cả hai app vẫn chặn khi thiếu).
3. **Merge** nhánh này vào `main` (trước đó sửa ngày ở mục `## [1.0.0] — yyyy-mm-dd — …` của `CHANGELOG.md` và
   `sano-agent/CHANGELOG.md` nếu cần). Số phiên bản chỉ có một nguồn: `version` trong `package.json` (D235); bản sau
   tăng số đó và thêm mục mới vào `sano-agent/CHANGELOG.md`. Bản 1.0.0: **Sano Agent đăng trước, SanoVids 1.0.0**
   (bản cuối, D236) **đăng sau cùng**, cả hai từ chính commit này. Nút "Tải Sano Agent" của bản cuối SanoVids mở trang
   tải về của Sano Agent, nên trang đó phải có bản cài trước.
4. **Build cả hai**, lần lượt: `npm ci`, `npm test`, `npm run dist:sano-agent` (ra `release\sano-agent\`), rồi
   `npm run dist:win` (ra `release\`). Có mạng (dấu thời gian của chữ ký, `npm ci` của SANO). Chưa cần tag: build chỉ cần
   đúng commit. `dist:sano-agent` cần checkout SANO có commit ghim trong `sano-agent/sano.json` (`SANO_REPO`, mục 5).
5. **Thử bản cài Sano Agent** theo mục 7. Có lỗi: sửa trên nhánh, merge, quay lại bước 4. Lúc này chưa có tag, chưa đăng
   gì, nên không mất bản SanoVids nào.
6. **Đặt tag nguồn** cả hai trên đúng commit đó của `main`: `git tag -a sano-agent-v1.0.0 -m "Sano Agent 1.0.0"`,
   `git tag -a v1.0.0 -m "SanoVids 1.0.0"`, rồi `git push origin sano-agent-v1.0.0 v1.0.0`.
7. **Tạo repo công khai** `JameSteven404/sano-agent-releases` có nhánh `main` với `README.md` (chép từ
   `sano-agent/releases-repo/README.md`), `LICENSE.txt`, `SanoVids-NguyenGiangMinh.cer`, `tin-cay-chung-chi.ps1` (chép từ
   `scripts/releases-repo/`).
8. **Kiểm tra cả hai:** `npm run release:check:sano-agent` và `npm run release:check`: mọi dòng ✓.
   `release:check:sano-agent` kiểm chữ ký, app-update.yml trỏ `sano-agent-releases` với
   `updaterCacheDirName: sano-agent-updater`, tag `v1.0.0` của SanoVids trỏ vào HEAD (cả trên GitHub), Electron giống
   bản SanoVids công khai mới nhất, `app.asar` có `sano-dist/index.html` và `sano-dist/BUILD.json` với đúng commit ghim,
   và `THIRD-PARTY-NOTICES.txt` giống `build/license-third-party-sano-agent.txt`.
9. **Đăng Sano Agent:** `npm run release:publish:sano-agent` (chỉ repo công khai; repo nguồn chỉ có tag `sano-agent-v…`,
   không có release). Repo công khai dùng tag `v1.0.0`, như electron-updater cần. Mở
   `https://github.com/JameSteven404/sano-agent-releases/releases/latest`: phải thấy bộ cài 1.0.0.
10. **Đăng SanoVids 1.0.0 khi Minh và 1–2 người trong team đã dùng Sano Agent ổn định** (ước lượng 1–2 ngày sau bước
    9, D247; bản này đẩy người dùng SanoVids sang Sano Agent). Nếu trong khoảng chờ đã phát hành bản vá Sano Agent, xem
    mục 8 bước 4 trước: bản SanoVids cuối có thể là 1.0.1. Nếu `main` đã có commit mới từ bước 6: `git checkout v1.0.0`
    (cảnh báo "không phải main" là bình thường) và dùng bộ cài SanoVids đã build ở bước 4 trong `release\`. Rồi `npm run release:publish` ([UPDATES.md](UPDATES.md) mục 3, bước 6–7). Đẩy tay
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
9. **SANO mở được, không cần Docker:** mở app (không bật Docker, không chạy máy chủ nào). SANO hiện ngay ở cửa sổ riêng,
   không có hộp thoại lỗi. Tab **Máy chủ** ghi "Chưa kết nối được API": đúng, bản 1.0 không có API. Dữ liệu mẫu là dữ
   liệu trung tính, không có WUFOTV, SANO Lab hay liên kết nội bộ (D242). Chỉ kiểm được trên hồ sơ chưa từng mở `app://sano`: lần sửa
   đầu tiên trong SANO lưu toàn bộ dữ liệu mẫu vào máy, các bản sau đọc bản đã lưu.
10. **Canvas và Trợ lý:** vào Canvas: SanoVids hiện toàn màn hình, gọn; nút **Trợ lý** ở góc phải trên mở trợ lý dự án.
11. **Dữ liệu SANO còn sau khi mở lại:** trong SANO sửa một mục của bảng sản xuất và đổi giao diện sáng/tối. Thoát app,
    mở lại: thay đổi vẫn còn. Trên một máy không cài Docker, mở app: SANO và Canvas vẫn chạy như bước 9–10.
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
   **Trong khoảng chờ của D247** (Sano Agent 1.0.0 đã đăng, SanoVids 1.0.0 chưa đăng): bản công khai mới nhất của
   SanoVids vẫn là 0.6.x, nên bản vá Sano Agent 1.0.1 chỉ qua `release:check:sano-agent` khi tag SanoVids `v1.0.1` nằm
   trên HEAD (cả GitHub). Khi đó bản SanoVids cuối nên là 1.0.1 từ commit vá (thêm mục `[1.0.1]` vào `CHANGELOG.md`),
   không phải 1.0.0 cũ. Minh chọn lúc đó.

**Web SANO (D240):** nằm trong bộ cài, nên rút lui đúng như app ở trên: bản vá 1.0.1 ghim commit SANO tốt cuối cùng
trong `sano-agent/sano.json`. Người dùng không có Docker hay máy chủ SANO nào để quay về. Giữ nguyên địa chỉ `app://sano/`
để không mất dữ liệu SANO trên máy.
