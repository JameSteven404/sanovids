# Chữ ký số & chống can thiệp

> Từ **0.5.0**, mọi file `.exe` chính thức của SanoVids được ký số bởi tác giả **Nguyễn Giang Minh (Jame Steven)**,
> app chỉ nhận bản cập nhật mang đúng chữ ký đó, tự kiểm tra chữ ký của chính nó và từ chối chạy khi bị can thiệp.
> Tài liệu này dành cho tác giả và người sửa mã. Phần cho người dùng: mục **🔐 Chữ ký số & bảo mật** trong
> [README](../README.md); trang tải về công khai: `scripts/releases-repo/README.md`. Tự cập nhật: [UPDATES.md](UPDATES.md).

## 1. Chứng chỉ

| | |
|---|---|
| Chủ sở hữu | `CN=Nguyễn Giang Minh (Jame Steven), C=VN` (chứng chỉ **tự ký**: người cấp = chủ sở hữu) |
| Khoá | RSA 3072 bit, chữ ký SHA-256, công dụng *Code Signing* (Key Usage: Digital Signature) |
| Dấu vân tay (SHA-1) | **`7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`** — đây là **ghim** (pin) mà app tin |
| Hiệu lực | 03/10/2026 → **03/10/2036** |
| Nơi giữ khoá bí mật | `Cert:\CurrentUser\My` của tài khoản Windows của tác giả trên máy build. Chỉ `signtool` dùng nó, qua dấu vân tay |
| Phần công khai | `build/signing/SanoVids-NguyenGiangMinh.cer` (= `scripts/releases-repo/SanoVids-NguyenGiangMinh.cer`, cũng được đăng kèm mỗi bản phát hành). Không chứa khoá |

- **Khoá bí mật không bao giờ rời máy**: không đưa vào repo, không lên CI, không gửi qua chat / email / ổ đám mây.
  Bản sao duy nhất là file `.pfx` có mật khẩu do `sao-luu-khoa-ky.ps1` tạo, cất offline (mục 3).
- Ai có khoá = ký được bản cập nhật mà mọi máy đã cài sẽ nhận. Mất khoá / lộ khoá: đọc mục 7.
- Danh sách dấu vân tay app tin nằm ở `package.json` → **`sanovids.signers`** (ở cấp ngoài cùng, không nằm trong
  `build`: electron-builder bỏ khoá `build` khỏi `package.json` đóng gói). Nó được đóng vào `app.asar`, được bảo vệ bởi
  kiểm tra toàn vẹn asar (mục 8), nên không sửa được trên máy người dùng.

## 2. Ký một bản phát hành

`npm run dist:win` → `scripts/update-notes.mjs` → `vite build` → **`scripts/electron-build.mjs --win nsis portable --publish never`**
→ `scripts/tidy-release.mjs`.

**`scripts/electron-build.mjs`** chạy electron-builder với `ELECTRON_BUILDER_DISABLE_BUILD_CACHE=true` (fuse không nằm
trong khoá cache của file exe, cache cũ có thể trả về exe chưa đặt fuse), và **từ chối chạy** khi:
- có biến `ELECTRON_BUILDER_OFFLINE` (electron-builder sẽ âm thầm bỏ dấu thời gian);
- thiếu cặp tham số `--publish never`.

**Cấu hình** (`package.json` → `build.win`):

```json
"forceCodeSigning": true,
"signExts": ["ffmpeg.dll", "vk_swiftshader.dll", "vulkan-1.dll", "dxcompiler.dll"],
"signtoolOptions": {
  "certificateSha1": "7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED",
  "signingHashAlgorithms": ["sha256"],
  "rfc3161TimeStampServer": "http://timestamp.digicert.com",
  "publisherName": "Nguyễn Giang Minh (Jame Steven)"
}
```

electron-builder tìm chứng chỉ theo dấu vân tay trong các kho `Cert:` rồi gọi `signtool` (bản 2.6.0 cũ có sẵn trong
cache của electron-builder) cho từng file, đại ý:

```
signtool sign /tr http://timestamp.digicert.com /sha1 7489ABFA… /s My /fd sha256 /td sha256 /d SanoVids /du <homepage> <file>
```

- **Một chữ ký SHA-256** (không ký kép SHA-1), **dấu thời gian RFC 3161** của DigiCert: chữ ký vẫn hợp lệ sau khi chứng
  chỉ hết hạn. Dấu thời gian là yêu cầu cứng của `release:check`.
- **File được ký**: `SanoVids.exe`, `resources\elevate.exe`, 4 DLL Electron giao ra chưa ký (`ffmpeg.dll`,
  `vk_swiftshader.dll`, `vulkan-1.dll`, `dxcompiler.dll`, ghi rõ tên trong `signExts`), `Uninstall SanoVids.exe`,
  `SanoVids-Setup-x.y.z.exe`, `SanoVids-Portable-x.y.z.exe`. `d3dcompiler_47.dll` và `dxil.dll` giữ chữ ký Microsoft.
- `publisherName` đặt rõ thì electron-builder ghi nó vào `resources/app-update.yml` (bắt buộc, mục 5).
  **CompanyName** / **Publisher** (Apps & features) = `Nguyễn Giang Minh (Jame Steven)`.
- `forceCodeSigning: true`: không ký được là **build dừng**, không bao giờ ra file chưa ký.
- Log build hiện **`Nguy?n`** (PowerShell con của electron-builder in sai dấu): chỉ là log, file đóng gói mang đúng UTF-8.

**Đừng bao giờ thêm** vào cấu hình: `certificateSubjectName` (không khớp được vì "Nguy?n"), `signtoolOptions.sign`
(nuốt lỗi tìm chứng chỉ), `win.verifyUpdateCodeSignature` (làm mất `publisherName`), `toolsets.winCodeSign`,
`certificateFile` / mật khẩu, `asar: false`, `asarUnpack`, `disableAsarIntegrity`.

**Bẫy tên tác giả**: electron-builder chuẩn hoá `author` `"Nguyễn Giang Minh (Jame Steven)"` thành tên
`Nguyễn Giang Minh` + url `Jame Steven`. Vì vậy `package.json` có thêm `build.extraMetadata.author.name` (gán sau bước
chuẩn hoá): đừng xoá dòng này. `src/lib/__tests__/buildConfig.test.ts` canh cả hai điều.

**Lỗi khi build**

| Lỗi | Nghĩa là | Làm gì |
|---|---|---|
| `Cannot find certificate 7489ABFA…` | Máy / tài khoản Windows này không có khoá ký | Khôi phục khoá (mục 3), hoặc build trên máy của tác giả |
| `The specified timestamp server either could not be reached` | Máy chủ dấu thời gian không trả lời. electron-builder thử lại 2 lần (sau 15 s rồi 25 s, khoảng 40 s) rồi dừng | Kiểm tra mạng, build lại sau. **Không** đặt `ELECTRON_BUILDER_OFFLINE` |
| `electron-build.mjs` từ chối | Có `ELECTRON_BUILDER_OFFLINE` hoặc thiếu `--publish never` | Bỏ biến môi trường / dùng `npm run dist:win` |

**Cổng phát hành** (`npm run release:check`, nhóm **(j) Chữ ký số**, `scripts/buildInspect.mjs`) đọc lại bản build:
Setup, Portable, `SanoVids.exe`, `elevate.exe` phải được ký bởi một dấu vân tay trong `sanovids.signers` **và có dấu thời
gian**; 4 DLL ký bởi tác giả, 2 DLL Microsoft giữ nguyên; CompanyName / LegalCopyright đúng; fuse đúng; không có
`app.asar.unpacked`; `app-update.yml` có `publisherName` đúng UTF-8; `package.json` bên trong có đúng `author` và
`sanovids.signers` (bản build thử có ghim thêm bị chặn); file `.cer` khớp ghim.

## 3. Sao lưu và khôi phục khoá (chỉ tác giả)

Hai script tiếng Việt trong `scripts/signing/`, không cần quyền quản trị:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\signing\sao-luu-khoa-ky.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\signing\khoi-phuc-khoa-ky.ps1
```

- **`sao-luu-khoa-ky.ps1`**: xuất chứng chỉ + khoá bí mật ra một file `.pfx` mã hoá AES-256, mật khẩu gõ 2 lần (không
  hiện, không lưu). Không ghi đè file có sẵn, không lưu vào thư mục nằm trong một kho git. Giữ **2 bản ở 2 nơi offline**
  (ví dụ 2 USB), mật khẩu cất riêng (trình quản lý mật khẩu).
- **`khoi-phuc-khoa-ky.ps1`**: nhập `.pfx` vào `Cert:\CurrentUser\My` của tài khoản đang dùng (cho phép sao lưu lại
  sau này), kiểm tra dấu vân tay, hỏi lại nếu file chứa chứng chỉ khác, sai mật khẩu được gõ lại 3 lần.
- Kiểm tra máy có khoá: `Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'`.

## 4. Tin cậy chứng chỉ trên máy người dùng (tuỳ chọn)

Chứng chỉ tự ký nên Windows chưa biết nó: UAC ghi **Unknown publisher**, `Get-AuthenticodeSignature` trả `UnknownError`
(chữ ký vẫn còn nguyên), SmartScreen có thể hiện **"Windows protected your PC"** (bản mới còn ít lượt tải) → **More info**
→ kiểm tra nhà phát hành → **Run anyway**.

**`tin-cay-chung-chi.ps1`** (`scripts/signing/` = `scripts/releases-repo/`, đăng tay lên repo công khai) chứa sẵn phần
**công khai** của chứng chỉ, tự kiểm tra dấu vân tay, rồi thêm nó vào kho **Trusted Root Certification Authorities** và
**Trusted Publishers** của tài khoản đang dùng (Windows hiện hộp xác nhận cho kho Root: so dấu vân tay rồi bấm Yes).
Sau đó Windows ghi đúng tên tác giả và chữ ký ở trạng thái `Valid`.
- `-TatCaNguoiDung`: cho mọi tài khoản (LocalMachine, cần "Run as administrator"); `-KiemTra`: chỉ xem; `-Go`: gỡ đúng
  chứng chỉ này; `-TepChungChi <file.cer>`: dùng file (phải khớp dấu vân tay); `-KhongHoi`: cài hàng loạt.
- **Không bắt buộc**: SanoVids chạy, tự kiểm tra và tự cập nhật như nhau khi chưa tin cậy. Chỉ chạy trên máy nội bộ
  được tác giả cho phép: tin cậy một chứng chỉ gốc nghĩa là Windows tin mọi thứ ký bằng nó.

## 5. Ghim chữ ký khi tự cập nhật

electron-updater mặc định chỉ kiểm tra chữ ký khi `app-update.yml` có `publisherName`, chỉ chấp nhận trạng thái
`Valid` (chứng chỉ tự ký bị từ chối), so **tên** (CN) chứ không so chứng chỉ (kẻ giả trùng tên lọt qua), và bỏ qua việc
kiểm tra khi không chạy được PowerShell. SanoVids thay bằng bộ kiểm tra riêng:

- `electron/signature.cjs` (không `require('electron')`, dùng chung cho main, updater và script phát hành):
  `readSignerPins()` đọc `sanovids.signers` từ `package.json` trong `app.asar`; `checkFileSignature(file, { pins })`
  chạy `powershell.exe` (đường dẫn tuyệt đối trong `System32`, `-NoProfile -NonInteractive -Command`, không
  `-EncodedCommand`, không `-ExecutionPolicy Bypass`; đường dẫn file chỉ đi qua biến môi trường `SANOVIDS_SIG_PATH`),
  tối đa 60 giây, **không bao giờ ném lỗi**.
- `electron/updater-rules.cjs` (thuần): script PowerShell (`SIGNATURE_SCRIPT`), đọc kết quả (`parseSignatureOutput`) và
  **bảng quyết định** `judgeSignature`. Không bao giờ dựa vào chữ hiển thị (bị dịch theo ngôn ngữ Windows) hay tên.

**Bảng quyết định** (xét theo thứ tự, dừng ở dòng đầu tiên khớp):

| # | Khi | Kết quả | Lý do (`updater.log`) |
|---|---|---|---|
| 1 | App không có dấu vân tay nào được ghim | từ chối | `no-pins` |
| 2 | PowerShell không chạy được, quá 60 s, kết quả không đọc được hay báo lỗi | từ chối | `verify-failed` |
| 3 | File không có chữ ký (`NotSigned`) | từ chối | `not-signed` |
| 4 | Nội dung bị sửa sau khi ký (`HashMismatch`). Xét **trước** người ký vì file bị sửa vẫn báo đúng người ký cũ | từ chối | `hash-mismatch` |
| 5 | Không phải chữ ký Authenticode / không đọc được dấu vân tay | từ chối | `verify-failed` |
| 6 | Dấu vân tay người ký không nằm trong danh sách ghim — **kể cả khi tên giống hệt** "Nguyễn Giang Minh (Jame Steven)" | từ chối | `other-signer` |
| 7a | Đúng ghim, Windows báo `Valid` (máy đã chạy script tin cậy), chuỗi chứng chỉ chỉ có cờ `UntrustedRoot` hoặc không cờ nào | **nhận** | `ok` |
| 7b | Đúng ghim, `UnknownError` với mã `0x800B0109` (gốc chưa được tin cậy), chuỗi đúng 1 chứng chỉ, cờ duy nhất `UntrustedRoot` — trường hợp chứng chỉ tự ký thật | **nhận** | `ok` |
| 8 | Mọi trường hợp khác (mã lỗi khác, chứng chỉ hết hạn / sai thời gian, chuỗi dài hơn…) | từ chối | `bad-chain` |

Updater và tự kiểm tra **không** đòi dấu thời gian; cổng phát hành thì đòi.

**Khi nào kiểm tra** (`electron/updater.cjs`):
1. Ngay sau khi tải xong, trong electron-updater: bộ kiểm tra được gắn **cả** vào `autoUpdater.verifyUpdateCodeSignature`
   **lẫn** ghi đè `verifySignature` của chính đối tượng updater, nên `app-update.yml` thiếu hay bị sửa `publisherName`
   cũng không bỏ qua được. Gắn không được hoặc không có ghim → không bao giờ tải.
2. Lại một lần ở sự kiện `update-downloaded`, trước khi báo **sẵn sàng**. Ghi nhớ file đã xác minh (đường dẫn, kích
   thước, `mtime`).
3. Lại một lần **trước mỗi lần cài** (nút **Khởi động lại để cập nhật**). Khi tắt app, chỉ cài nếu bộ cài vẫn đúng là
   file đã xác minh; khác → bỏ qua lần cài khi tắt.

Bị từ chối: file bị **xoá**, không cài, `autoInstallOnAppQuit` tắt, trạng thái lỗi `signature` với câu
"Không xác minh được chữ ký số của tác giả trên bản cập nhật nên SanoVids đã bỏ file đó, không cài. Hãy tải bộ cài ở trang
tải về rồi cài đè lên bản đang dùng." Hộp cập nhật có nút **Mở trang tải về** và **Thử lại**. Trong lần chạy đó, SanoVids
nhớ phiên bản đã bị từ chối và không tự tải lại nó (bấm **Thử lại** vẫn được).

## 6. App tự kiểm tra chữ ký

Main kiểm tra `process.execPath` **một lần**, 3 giây sau khi cửa sổ hiện, rồi nhớ kết quả. Renderer đọc qua
`window.bdpDesktop.app.signature()` (IPC `app:signature`, chỉ nhận từ `app://bdp/`). **Cài đặt → Cơ bản → Giới thiệu**
hiện kết quả (chữ trong `src/lib/aboutModel.ts`):

| Trạng thái | App hiện | Khi nào |
|---|---|---|
| `signed` | **Đã ký số bởi Nguyễn Giang Minh (Jame Steven) ✓** — "Bản gốc" | Bảng quyết định nhận (7a / 7b) |
| `other-signer` | ⚠ **Không phải bản gốc** (tên người ký) | Dòng 6 |
| `tampered` | ⚠ **File của SanoVids đã bị thay đổi** | Dòng 4 |
| `unsigned` (bản đóng gói) | ⚠ **Bản này không có chữ ký số** | Dòng 3 |
| `unsigned` (chạy từ mã nguồn) | **Bản phát triển (chưa ký số)** | `npm run desktop`, không gọi PowerShell |
| `unknown` | **Chưa kiểm tra được chữ ký số** | Dòng 1 / 2 / 5 / 8, PowerShell bị chặn hoặc quá lâu |

Tự kiểm tra **chỉ để hiển thị**, không chặn app (việc chặn file bị sửa là của fuse toàn vẹn asar, mục 8). Khối Giới
thiệu còn hiện dấu vân tay chứng chỉ (của file đang chạy, hoặc dấu vân tay chính thức `sanovids.signers[0]`). Chạy
`npm run dev`: Bảng phát triển → **Cập nhật** → **Chữ ký số (Giới thiệu)** giả lập mọi trạng thái, và nút **Lỗi chữ ký
số** giả lập lỗi cập nhật `signature`.

## 7. Đổi chứng chỉ (rotation)

Máy đã cài chỉ nhận bản cập nhật ký bằng một dấu vân tay **mà bản đang chạy đã ghim**. Vì vậy phải ghim chứng chỉ mới
**trước** khi dùng nó:

1. Tạo chứng chỉ mới (RSA 3072, SHA-256, *Code Signing*) trong `Cert:\CurrentUser\My`, sao lưu ngay (mục 3, sửa dấu
   vân tay ghim trong hai script).
2. **Bản N, vẫn ký bằng chứng chỉ CŨ**: `sanovids.signers` = `[CŨ, MỚI]`. Phát hành, đợi đủ lâu để phần lớn máy đã
   cập nhật lên bản N.
3. **Bản N+1, ký bằng chứng chỉ MỚI**: đổi `build.win.signtoolOptions.certificateSha1`; `sanovids.signers` = `[MỚI, CŨ]`
   (khối Giới thiệu hiện phần tử đầu là dấu vân tay chính thức); thay file `.cer` (`build/signing/` và
   `scripts/releases-repo/`), dấu vân tay trong `LICENSE.txt` (3 bản giống hệt nhau), `tin-cay-chung-chi.ps1` (chứng chỉ
   gắn sẵn + dấu vân tay), `SIGNER_THUMBPRINT` trong `scripts/releaseLib.mjs` (ghi chú phát hành, dòng ký số của
   `DOC-TOI.txt`; kiểm tra (h) chặn nếu nó khác `certificateSha1`), README, tài liệu này, README của trang tải về và các test đang ghim dấu vân tay cũ. Máy nội bộ đã tin cậy chứng chỉ
   cũ chạy script mới.
4. Một bản sau nữa: bỏ dấu vân tay CŨ khỏi `sanovids.signers`.

Máy còn ở bản cũ hơn N sẽ từ chối bản N+1 (lỗi `signature`) → người dùng tải bộ cài ở trang tải về, cài đè.

**Đổi xong trước 03/10/2036**, nên làm từ khoảng 2035: sau ngày hết hạn không ký được bản mới, và bộ kiểm tra của app
dựng chuỗi chứng chỉ theo giờ hiện tại nên coi chữ ký của chứng chỉ đã hết hạn là `bad-chain` (cập nhật bị từ chối,
Giới thiệu báo "Chưa kiểm tra được").

**Lộ khoá**: đổi chứng chỉ ngay như trên nhưng bỏ dấu vân tay CŨ khỏi `sanovids.signers` sớm nhất có thể, gỡ tin cậy
chứng chỉ cũ trên các máy nội bộ (`tin-cay-chung-chi.ps1 -Go`), báo người dùng tự cài bản mới.

## 8. Chống can thiệp

**Fuse của Electron** (`build.electronFuses`, ghi thẳng vào `SanoVids.exe` lúc build, rồi exe mới được ký):

| Fuse | Đặt | Tác dụng |
|---|---|---|
| RunAsNode | tắt | `ELECTRON_RUN_AS_NODE` không biến app thành Node chạy mã tuỳ ý |
| EnableNodeOptionsEnvironmentVariable | tắt | Bỏ qua `NODE_OPTIONS` |
| EnableNodeCliInspectArguments | tắt | Bỏ qua `--inspect…` ở tầng Node |
| EnableEmbeddedAsarIntegrityValidation | bật | `app.asar` bị sửa (một byte cũng vậy) → app **không mở** |
| OnlyLoadAppFromAsar | bật | Không chạy mã từ thư mục `resources\app\` thay cho `app.asar` |
| GrantFileProtocolExtraPrivileges | tắt | `file://` không có quyền đặc biệt |
| EnableCookieEncryption | **tắt, có chủ ý** | Bật = mã hoá lại kho cookie (phiên đăng nhập canvasapp) một chiều; bật rồi tắt sẽ mất cookie. Không bao giờ bật rồi tắt |

LoadBrowserProcessSpecificV8Snapshot để mặc định; fuse 8 (WasmTrapHandlers) không đụng tới.

**Trong `electron/main.cjs`** (quy tắc thuần trong `electron/hardening-rules.cjs`, test `hardeningRules.test.ts`):
- **Từ chối tham số gỡ lỗi / tắt bảo mật** (bản đóng gói): `--inspect…`, `--debug…`, `--js-flags`,
  `--ignore-certificate-errors…`, `--no-sandbox`, `--disable-web-security`, `--disable-site-isolation-trials`,
  `--allow-running-insecure-content`, `--unsafely-treat-insecure-origin-as-secure` → hộp báo lỗi rồi thoát mã **3**,
  trước khi đụng tới dữ liệu. `--remote-debugging-*` / `--remote-allow-origins` chỉ được phép khi dùng profile thử
  (`SANOVIDS_PROFILE_DIR` hoặc profile nướng sẵn trong bản build thử).
- **DevTools** chỉ có khi chạy từ mã nguồn hoặc với profile thử (cửa sổ chính, cửa sổ đăng nhập canvasapp và cửa sổ
  popup của nó, cửa sổ thanh toán).
- `app.enableSandbox()`: mọi trang chạy trong sandbox (cùng `contextIsolation`, không `nodeIntegration`, IPC chỉ nhận
  từ `app://bdp/` như trước).
- **Tải về**: chỉ nhận `blob:app://bdp/…` với đuôi `mp4 webm mov m4v jpg jpeg png webp svg txt zip json`; còn lại huỷ.
- **Quyền** của phiên mặc định: chỉ `clipboard-sanitized-write`, `fileSystem`, `fullscreen`; thiết bị (USB / HID /
  serial) luôn từ chối. Không `<webview>`, không chọn thiết bị Bluetooth.
- Cửa sổ đăng nhập canvasapp và mọi popup con của nó chỉ mở `https:`, cùng cấu hình bảo mật.
- **CSP** trên mọi trang HTML của `app://bdp/`: `script-src 'self'` + mã băm SHA-256 của đoạn script chọn giao diện
  trong `index.html` (tính từ chính file đó), không `eval`, `object-src 'none'`, không khung, không form.

## 9. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Làm gì |
|---|---|---|
| Bấm SanoVids không thấy gì mở (không cửa sổ, không báo lỗi) | File trong thư mục cài bị sửa (diệt virus "sửa" file, chép đè…): kiểm tra toàn vẹn asar chặn | Tải bộ cài ở trang tải về, cài đè. Dữ liệu ở `%APPDATA%\SanoVids` giữ nguyên |
| Hộp "SanoVids không mở khi có tham số gỡ lỗi…" | Lối tắt / lệnh mở có thêm tham số | Mở bằng biểu tượng bình thường, xoá tham số trong lối tắt |
| Lỗi cập nhật "Không xác minh được chữ ký số…" | Bản trên trang tải về không mang chữ ký đúng, file tải về bị sửa, hoặc PowerShell bị chặn | Tải Setup ở trang tải về, kiểm tra chữ ký (Properties → Digital Signatures), cài đè. Tác giả: xem dòng `signature <lý do>` trong `updater.log`, chạy `release:check` |
| Giới thiệu: "Chưa kiểm tra được chữ ký số" | PowerShell bị chính sách / diệt virus chặn, hoặc quá 60 s | Không ảnh hưởng việc dùng app; kiểm tra tay bằng Properties |
| Giới thiệu: "Không phải bản gốc" / "File… đã bị thay đổi" | Bản cài không chính thức hoặc exe bị sửa | Gỡ, tải bản chính thức, cài lại |
| Build: `Cannot find certificate …` | Máy không có khoá | Mục 3 |

Bài thử đầu-cuối của chữ ký số (5 danh tính thử, chứng chỉ thử chỉ là file, không đụng kho chứng chỉ của Windows):
[UPDATES.md](UPDATES.md) mục 4.
