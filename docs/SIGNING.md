# Chữ ký số & chống can thiệp

> Từ **0.5.0**, mọi file `.exe` chính thức của SanoVids được ký số bởi tác giả **Nguyễn Giang Minh (Jame Steven)**,
> app chỉ nhận bản cập nhật mang đúng chữ ký đó, tự kiểm tra chữ ký của chính nó, và không chạy khi mã của app
> (`app.asar`) bị sửa. Các lớp chống can thiệp và giới hạn của chúng: mục 8.
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
| Bản sao không khoá | `Cert:\CurrentUser\CA` (*Intermediate Certification Authorities*) cũng có phần công khai của chứng chỉ, từ lúc tạo chứng chỉ (`New-SelfSignedCertificate` thường tự thêm). Không có khoá bí mật, kho CA không tạo tin cậy: để nguyên, nhưng gỡ cùng lúc khi bỏ chứng chỉ (mục 7) |
| Phần công khai | `build/signing/SanoVids-NguyenGiangMinh.cer` (= `scripts/releases-repo/SanoVids-NguyenGiangMinh.cer`, cũng được đăng kèm mỗi bản phát hành). Không chứa khoá |

- **Khoá bí mật không bao giờ rời máy**: không đưa vào repo, không lên CI, không gửi qua chat / email / ổ đám mây.
  Bản sao duy nhất là file `.pfx` có mật khẩu do `sao-luu-khoa-ky.ps1` tạo, cất offline (mục 3).
- Ai có khoá = ký được bản cập nhật mà mọi máy đã cài sẽ nhận. Mất khoá / lộ khoá: đọc mục 7.
- Danh sách dấu vân tay app tin nằm ở `package.json` → **`sanovids.signers`** (ở cấp ngoài cùng, không nằm trong
  `build`: electron-builder bỏ khoá `build` khỏi `package.json` đóng gói). Nó được đóng vào `app.asar`: sửa `app.asar` thì
  app không mở (kiểm tra toàn vẹn asar, mục 8). Nhưng mã băm để so lại nằm trong chính `SanoVids.exe`, nên ai ghi được vào
  thư mục cài vẫn thay được cả `SanoVids.exe` lẫn `app.asar`: khi đó exe mất chữ ký của tác giả (Giới thiệu báo, mục 6)
  nhưng Windows không chặn chạy. Lớp này chống sửa nhầm / sửa một phần, không chống phần mềm độc đã chạy bằng tài khoản
  của người dùng (mục 8).

## 2. Ký một bản phát hành

`npm run dist:win` → `scripts/update-notes.mjs` → `scripts/third-party-notices.mjs --check` (giấy phép thư viện cũ thì dừng) → `vite build` → **`scripts/electron-build.mjs --win nsis portable --publish never`**
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
  `elevate.exe` là công cụ phụ của electron-builder: nó mang chữ ký của tác giả nhưng vẫn giữ thông tin file gốc của người
  viết ra nó (CompanyName "Johannes Passing", "Elevate Application", không có icon) — bình thường, không phải lỗi.
- `publisherName` đặt rõ thì electron-builder ghi nó vào `resources/app-update.yml` (bắt buộc, mục 5).
  **CompanyName** / **Publisher** (Apps & features) = `Nguyễn Giang Minh (Jame Steven)`.
- `forceCodeSigning: true`: không ký được là **build dừng**, không bao giờ ra file chưa ký.
- Log build có thể hiện **`Nguy?n`** (tuỳ bảng mã của PowerShell con của electron-builder): chỉ là log, file đóng gói mang
  đúng UTF-8.

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
- Setup, Portable, `SanoVids.exe`, `elevate.exe` phải được ký bằng **đúng** chứng chỉ ký của bản này (`SIGNER_THUMBPRINT`
  trong `scripts/releaseLib.mjs`, cũng phải nằm trong `sanovids.signers`) **và có dấu thời gian**; 4 DLL ký bởi tác giả;
  2 DLL Microsoft giữ nguyên.
- **Mọi file mã khác** trong `win-unpacked` (`*.exe`, `*.dll`, `*.node`…, cả thư mục con) phải được tác giả ký hoặc mang
  chữ ký hợp lệ của hãng làm ra nó. `signExts` là danh sách cố định: bản Electron mới thêm một DLL chưa ký thì
  electron-builder để nguyên không ký, và cổng báo ✗ "Thêm … vào package.json build.win.signExts".
- Mã toàn vẹn asar trong `SanoVids.exe` (tài nguyên `INTEGRITY/ELECTRONASAR`) khớp SHA-256 của header `app.asar`. Sai hay
  thiếu = app không mở trên **mọi** máy, và tự cập nhật không cứu được (trình cập nhật nằm trong app).
- `win-unpacked` không mới hơn Setup / Portable (nó phải đúng là nội dung của bộ cài sẽ đăng, không phải một lần build
  `--dir` sau đó); `LICENSE.txt` và `THIRD-PARTY-NOTICES.txt` cạnh file exe giống hệt bản trong repo.
- CompanyName / LegalCopyright đúng; fuse đúng; không có `app.asar.unpacked`; `app-update.yml` có `publisherName` đúng
  UTF-8; `package.json` bên trong có đúng `author` và `sanovids.signers` (bản build thử có ghim thêm bị chặn); file `.cer`
  khớp ghim.
- **"Ghim trước, ký sau"**: `SIGNER_THUMBPRINT` phải nằm trong `sanovids.signers` của bản công khai mới nhất trước bản này
  (đọc bằng `git show v<bản đó>:package.json`); không thì mọi máy đang dùng bản đó sẽ từ chối bản cập nhật (mục 7).

## 3. Sao lưu và khôi phục khoá (chỉ tác giả)

Hai script tiếng Việt trong `scripts/signing/`, không cần quyền quản trị:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\signing\sao-luu-khoa-ky.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\signing\khoi-phuc-khoa-ky.ps1
```

- **`sao-luu-khoa-ky.ps1`**: xuất chứng chỉ + khoá bí mật ra một file `.pfx` mã hoá AES-256, mật khẩu gõ 2 lần (không
  hiện, không lưu). Không ghi đè file có sẵn, không lưu vào thư mục nằm trong một kho git. Giữ **2 bản ở 2 nơi offline**
  (ví dụ 2 USB), mật khẩu cất riêng (trình quản lý mật khẩu).
- **`khoi-phuc-khoa-ky.ps1`**: nhập `.pfx` vào `Cert:\CurrentUser\My` của tài khoản đang dùng, kiểm tra dấu vân tay, hỏi
  lại nếu file chứa chứng chỉ khác, sai mật khẩu được gõ lại 3 lần. Mặc định khoá được nhập ở dạng **không cho xuất ra**:
  vẫn ký bình thường, nhưng chương trình chạy bằng tài khoản đó không chép được khoá ra bằng một lệnh. File `.pfx` đang
  giữ chính là bản sao lưu (muốn thêm bản thì chép file đó). Chỉ khi thật sự cần tạo bản sao lưu mới từ máy này mới thêm
  `-ChoPhepSaoLuuLai` (khi đó `sao-luu-khoa-ky.ps1` mới xuất được).
- Sao lưu xong mà đọc lại file không đạt (sai chứng chỉ, không mở được), `sao-luu-khoa-ky.ps1` xoá ngay file vừa tạo (nó
  vẫn chứa khoá bí mật) rồi báo chạy lại.
- Kiểm tra máy có khoá: `Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED'`.

## 4. Tin cậy chứng chỉ trên máy người dùng (tuỳ chọn)

Chứng chỉ tự ký nên Windows chưa biết nó: UAC ghi **Unknown publisher**, `Get-AuthenticodeSignature` trả `UnknownError`
(chữ ký vẫn còn nguyên). SmartScreen hiện **"Windows protected your PC"** với file tải bằng trình duyệt → **More info** →
kiểm tra nhà phát hành → **Run anyway**: chứng chỉ tự ký không có uy tín với Microsoft nên cảnh báo này **không tự mất
theo thời gian**, và chạy script tin cậy cũng không làm mất nó. Bản tự cập nhật thì không bị SmartScreen hỏi (file do app
tải, không mang dấu "tải từ Internet").

**`tin-cay-chung-chi.ps1`** (`scripts/signing/` = `scripts/releases-repo/`, đăng tay lên repo công khai) chứa sẵn phần
**công khai** của chứng chỉ, tự kiểm tra dấu vân tay, rồi thêm nó vào **một** kho: **Trusted Root Certification
Authorities** của tài khoản đang dùng (Windows hiện hộp xác nhận: so dấu vân tay rồi bấm Yes). Sau đó UAC ghi đúng tên tác
giả và chữ ký ở trạng thái `Valid`. Script **không** thêm vào **Trusted Publishers**: SanoVids không cần kho đó, và nó còn
cho script PowerShell (chính sách AllSigned / RemoteSigned) và macro Office ký bằng khoá này chạy mà không hỏi — lộ khoá
thì mọi máy đã tin cậy sẽ chạy chúng im lặng.
- `-TatCaNguoiDung`: cho mọi tài khoản (LocalMachine, cần "Run as administrator"); `-KiemTra`: chỉ xem; `-Go`: gỡ đúng
  chứng chỉ này khỏi Root (và khỏi Trusted Publishers nếu bản script cũ đã thêm vào); `-TepChungChi <file.cer>`: dùng file
  (phải khớp dấu vân tay); `-KhongHoi`: cài hàng loạt.
- **So dấu vân tay với một nguồn khác trang tải về**: script, README và `.cer` cùng nằm trên repo công khai, ai chiếm được
  tài khoản GitHub thay được cả ba cho khớp nhau. Nguồn độc lập: tác giả gửi trực tiếp (chat nội bộ, gặp mặt), hoặc dòng
  dấu vân tay trong **Cài đặt → Giới thiệu** của một SanoVids đã cài từ trước (lấy từ `sanovids.signers` trong `app.asar`).
  Script và cả hai README đều nhắc điều này.
- **Không bắt buộc**: SanoVids chạy, tự kiểm tra và tự cập nhật như nhau khi chưa tin cậy. Chỉ chạy trên máy nội bộ
  được tác giả cho phép: tin cậy một chứng chỉ gốc nghĩa là Windows tin mọi thứ ký bằng nó.

## 5. Ghim chữ ký khi tự cập nhật

electron-updater mặc định chỉ kiểm tra chữ ký khi `app-update.yml` có `publisherName`, chỉ chấp nhận trạng thái
`Valid` (chứng chỉ tự ký bị từ chối), so **tên** (CN) chứ không so chứng chỉ (kẻ giả trùng tên lọt qua), và bỏ qua việc
kiểm tra khi không chạy được PowerShell. SanoVids thay bằng bộ kiểm tra riêng:

- `electron/signature.cjs` (không `require('electron')`, dùng chung cho main, updater và script phát hành):
  `readSignerPins()` đọc `sanovids.signers` từ `package.json` trong `app.asar`; `checkFileSignature(file, { pins })`
  (và `checkFilesSignature` cho vài file một lần) chạy `powershell.exe` của chính thư mục Windows (không lấy theo biến
  môi trường tuỳ ý), `-NoProfile -NonInteractive -Command`, không `-EncodedCommand`, không `-ExecutionPolicy Bypass`;
  đường dẫn file chỉ đi qua biến môi trường `SANOVIDS_SIG_PATH`, tiến trình con chỉ nhận một môi trường đã lọc (không
  `PSModulePath`, không biến nạp DLL vào .NET như `COR_*` / `COMPlus_*` / `DOTNET_*`); tối đa 60 giây, **không bao giờ
  ném lỗi**.
- `electron/updater-rules.cjs` (thuần): script PowerShell (`SIGNATURE_SCRIPT`), đọc kết quả (`parseSignatureOutput`) và
  **bảng quyết định** `judgeSignature`. Không bao giờ dựa vào chữ hiển thị (bị dịch theo ngôn ngữ Windows) hay tên.

**Bảng quyết định** (`judgeSignature`, xét theo thứ tự, dừng ở dòng đầu tiên khớp). Cột cuối là mã lỗi app báo:
`signature` = file **bị từ chối** (không phải bản cập nhật của tác giả), `signature-unverified` = **chưa kiểm tra được**
(không cài, nhưng cũng không coi là giả mạo).

| # | Khi | Kết quả | Lý do (`updater.log`) | Mã lỗi |
|---|---|---|---|---|
| 1 | App không có dấu vân tay nào được ghim | không nhận | `no-pins` | `signature-unverified` |
| 2 | PowerShell chạy ở chế độ hạn chế (ConstrainedLanguage: AppLocker / WDAC) | không nhận | `policy` | `signature-unverified` |
| 3 | PowerShell không chạy được, quá 60 s, kết quả không đọc được hay báo lỗi | không nhận | `verify-failed` | `signature-unverified` |
| 4 | File không có chữ ký (`NotSigned`) | từ chối | `not-signed` | `signature` |
| 5 | Nội dung bị sửa sau khi ký (`HashMismatch`). Xét **trước** người ký vì file bị sửa vẫn báo đúng người ký cũ | từ chối | `hash-mismatch` | `signature` |
| 6 | Không phải chữ ký Authenticode / không đọc được dấu vân tay | không nhận | `verify-failed` | `signature-unverified` |
| 7 | Dấu vân tay người ký không nằm trong danh sách ghim — **kể cả khi tên giống hệt** "Nguyễn Giang Minh (Jame Steven)" | từ chối | `other-signer` | `signature` |
| 8a | Đúng ghim, Windows báo `Valid` (máy đã chạy script tin cậy), chuỗi chứng chỉ chỉ có cờ `UntrustedRoot` (hoặc không cờ nào) | **nhận** | `ok` | — |
| 8b | Đúng ghim, `UnknownError` với mã `0x800B0109` (gốc chưa được tin cậy), chuỗi đúng 1 chứng chỉ, có cờ `UntrustedRoot` — trường hợp chứng chỉ tự ký thật | **nhận** | `ok` | — |
| 9 | Mọi trường hợp khác (mã lỗi khác, chuỗi dài hơn, cờ lạ…) | không nhận | `bad-chain` | `signature-unverified` |

Ở 8a / 8b, chữ ký **có dấu thời gian** thì cờ `NotTimeValid` cũng được bỏ qua: Windows đã xét hiệu lực của chứng chỉ tại
thời điểm ký (RFC 3161), nên đồng hồ máy sai hay chứng chỉ hết hạn sau đó không làm hỏng một bản ký thật. Không có dấu
thời gian thì `NotTimeValid` → dòng 9. Updater và tự kiểm tra không **đòi** dấu thời gian; cổng phát hành thì đòi.

**Đúng ghim vẫn chưa đủ**: bộ cài còn phải đúng là bản cập nhật được báo (`installerIdentityProblem`, đọc từ VersionInfo
nằm trong phần đã ký): ProductName là SanoVids, ProductVersion đúng phiên bản trong `latest.yml` và **mới hơn** bản đang
chạy, kích thước cỡ một bộ cài. Sai → từ chối (`wrong-product` / `wrong-version` / `not-newer` / `not-installer`, mã
`signature`). Vì vậy không ai đẩy lại được một bản cũ hơn nhưng ký thật, hay chạy một file khác mà tác giả từng ký (trình
gỡ cài đặt, `elevate.exe`) như thể là bộ cài.

**Khi nào kiểm tra** (`electron/updater.cjs`):
1. Ngay sau khi tải xong, trong electron-updater: bộ kiểm tra được gắn **cả** vào `autoUpdater.verifyUpdateCodeSignature`
   **lẫn** ghi đè `verifySignature` của chính đối tượng updater, nên `app-update.yml` thiếu hay bị sửa `publisherName`
   cũng không bỏ qua được. Gắn không được hoặc không có ghim → không bao giờ tải.
2. Lại một lần ở sự kiện `update-downloaded` (bộ cài đã tải từ lần mở trước không đi qua bước 1), trước khi báo **sẵn
   sàng**. File đã xác minh được gắn với nội dung của nó (SHA-512, phải là mã `latest.yml` đã báo).
3. Lại một lần **trước mỗi lần cài**: ngay trước khi chạy bộ cài (nút **Khởi động lại để cập nhật**) và trong sự kiện
   tắt app trước khi cài im lặng, file được băm lại; khác file đã xác minh → không cài (`changed`).

Bị từ chối (`signature`): file bị **xoá**, không cài, `autoInstallOnAppQuit` tắt; SanoVids nhớ file đó theo SHA-512 trong
`updater.json` (`rejected`, tối đa 5 mục) và **không bao giờ tự tải lại nó** (bấm **Thử lại** vẫn được). Chưa kiểm tra
được (`signature-unverified`): không cài, tự thử lại sau (một ngày một lần), **Thử lại** kiểm tra lại ngay. Câu hiển thị
của hai mã lỗi: bảng ở [UPDATES.md](UPDATES.md) mục 5. Với `signature`, app **không** khuyên tải lại ở trang tải về (chính
trang đó có thể đã đưa ra file giả): hộp cập nhật hướng dẫn so dấu vân tay chứng chỉ với **Cài đặt → Giới thiệu** trước
khi tự cài bộ cài nào.

## 6. App tự kiểm tra chữ ký

Main kiểm tra **một lần**, 3 giây sau khi cửa sổ hiện, rồi nhớ kết quả: `SanoVids.exe` (`process.execPath`) và 6 DLL của
Electron nằm cạnh nó (`hardening-rules.SELF_CHECK_FILES`: 4 DLL tác giả ký, `d3dcompiler_47.dll` / `dxil.dll` phải giữ
chữ ký Microsoft), trong một lần gọi PowerShell. Renderer đọc qua `window.bdpDesktop.app.signature()` (IPC `app:signature`,
chỉ nhận từ `app://bdp/`). **Cài đặt → Cơ bản → Giới thiệu** hiện kết quả (chữ trong `src/lib/aboutModel.ts`):

| Trạng thái | App hiện | Khi nào |
|---|---|---|
| `signed` | **Đã ký số bởi Nguyễn Giang Minh (Jame Steven) ✓** | exe được bảng quyết định nhận (8a / 8b) và cả 6 DLL đúng chữ ký |
| `other-signer` | ⚠ **Không phải bản gốc** (tên người ký) | exe: dòng 7 |
| `tampered` | ⚠ **File của SanoVids đã bị thay đổi** | exe: dòng 5; hoặc exe đúng nhưng một DLL bị sửa / bị thay / mất chữ ký đúng |
| `unsigned` (bản đóng gói) | ⚠ **Bản này không có chữ ký số** | exe: dòng 4 |
| `unsigned` (chạy từ mã nguồn) | **Bản phát triển (chưa ký số)** | `npm run desktop`, không gọi PowerShell |
| `unknown` | **Chưa kiểm tra được chữ ký số** | Dòng 1 / 2 / 3 / 6 / 9, hoặc một DLL thiếu / không đọc được |

Tự kiểm tra **chỉ để hiển thị**, không chặn app. Nó không xét các file khác trong thư mục cài (`*.pak`, `locales\…`,
`v8_context_snapshot.bin`, một DLL lạ đặt thêm cạnh exe): xem giới hạn ở mục 8. Việc chặn `app.asar` bị sửa là của fuse
toàn vẹn asar (mục 8). Khối Giới thiệu còn hiện dấu vân tay chứng chỉ (của file đang chạy, hoặc dấu vân tay chính thức
`sanovids.signers[0]`). Chạy
`npm run dev`: Bảng phát triển → **Cập nhật** → **Chữ ký số (Giới thiệu)** giả lập mọi trạng thái, và nút **Lỗi chữ ký
số** giả lập lỗi cập nhật `signature`.

## 7. Đổi chứng chỉ (rotation)

Máy đã cài chỉ nhận bản cập nhật ký bằng một dấu vân tay **mà bản đang chạy đã ghim**. Vì vậy phải ghim chứng chỉ mới
**trước** khi dùng nó:

1. Tạo chứng chỉ mới (RSA 3072, SHA-256, *Code Signing*) trong `Cert:\CurrentUser\My`, sao lưu ngay (mục 3, sửa dấu
   vân tay ghim trong hai script). `New-SelfSignedCertificate` thường thêm một bản công khai vào `Cert:\CurrentUser\CA`.
2. **Bản N, vẫn ký bằng chứng chỉ CŨ**: `sanovids.signers` = `[CŨ, MỚI]`. Phát hành, đợi đủ lâu để phần lớn máy đã
   cập nhật lên bản N.
3. **Bản N+1, ký bằng chứng chỉ MỚI**: đổi `build.win.signtoolOptions.certificateSha1`; `sanovids.signers` = `[MỚI, CŨ]`
   (khối Giới thiệu hiện phần tử đầu là dấu vân tay chính thức); thay file `.cer` (`build/signing/` và
   `scripts/releases-repo/`), dấu vân tay trong `LICENSE.txt` (3 bản giống hệt nhau), `tin-cay-chung-chi.ps1` (chứng chỉ
   gắn sẵn + dấu vân tay), `SIGNER_THUMBPRINT` trong `scripts/releaseLib.mjs` (ghi chú phát hành, dòng ký số của
   `DOC-TOI.txt`; kiểm tra (h) chặn nếu nó khác `certificateSha1`), README, tài liệu này, README của trang tải về và các
   test đang ghim dấu vân tay cũ. Máy nội bộ đã tin cậy chứng chỉ cũ chạy script mới.
   **Đừng gộp bước 2 và 3**: `release:check` (nhóm (j), kiểm tra "ghim trước, ký sau") chặn bản N+1 nếu bản công khai
   mới nhất chưa ghim chứng chỉ MỚI, và cũng chặn nếu file nào trong bản build không ký bằng đúng `SIGNER_THUMBPRINT`.
4. Một bản sau nữa: bỏ dấu vân tay CŨ khỏi `sanovids.signers`. Khi không còn cần ký bằng chứng chỉ CŨ nữa (giữ file
   `.pfx` cũ cất offline nếu muốn), gỡ nó khỏi máy build — cả bản có khoá trong `My` lẫn bản công khai trong `CA`:
   `Get-ChildItem Cert:\CurrentUser\My, Cert:\CurrentUser\CA | Where-Object Thumbprint -eq '<CŨ>' | Remove-Item`.

Máy còn ở bản cũ hơn N sẽ từ chối bản N+1 (lỗi `signature`) → người dùng tải bộ cài ở trang tải về, cài đè.

**Đổi xong trước 03/10/2036**, nên làm từ khoảng 2035: sau ngày hết hạn không ký được bản mới (bản đã ký có dấu thời gian
thì vẫn được nhận, mục 5). Một chữ ký **không** có dấu thời gian của chứng chỉ đã hết hạn rơi vào dòng 9 (`bad-chain`:
cập nhật không được cài, Giới thiệu báo "Chưa kiểm tra được").

**Lộ khoá**: đổi chứng chỉ ngay như trên nhưng bỏ dấu vân tay CŨ khỏi `sanovids.signers` sớm nhất có thể, gỡ chứng chỉ cũ
khỏi máy build (`My` và `CA`, lệnh ở bước 4), gỡ tin cậy chứng chỉ cũ trên các máy nội bộ (`tin-cay-chung-chi.ps1 -Go`),
báo người dùng tự cài bản mới. Lưu ý: cho tới khi bản bỏ ghim CŨ tới được một máy, ai giữ khoá cũ vẫn ký được bản cập nhật
mà máy đó sẽ nhận (bộ cài phải ghi phiên bản mới hơn, mục 5, nhưng người có khoá tự đặt được phiên bản). Giữ chặt tài khoản
GitHub (2FA) là một phần của việc xử lý: muốn đẩy bản độc cần cả khoá lẫn nguồn cập nhật.

## 8. Chống can thiệp

**Fuse của Electron** (`build.electronFuses`, ghi thẳng vào `SanoVids.exe` lúc build, rồi exe mới được ký):

| Fuse | Đặt | Tác dụng |
|---|---|---|
| RunAsNode | tắt | `ELECTRON_RUN_AS_NODE` không biến app thành Node chạy mã tuỳ ý |
| EnableNodeOptionsEnvironmentVariable | tắt | Bỏ qua `NODE_OPTIONS` |
| EnableNodeCliInspectArguments | tắt | Bỏ qua `--inspect…` ở tầng Node |
| EnableEmbeddedAsarIntegrityValidation | bật | `app.asar` bị sửa (một byte cũng vậy) → app **không mở**, hoặc **tự tắt** khi đọc tới phần bị sửa (xem dưới) |
| OnlyLoadAppFromAsar | bật | Không chạy mã từ thư mục `resources\app\` thay cho `app.asar` |
| GrantFileProtocolExtraPrivileges | tắt | `file://` không có quyền đặc biệt |
| EnableCookieEncryption | **tắt, có chủ ý** | Bật = mã hoá lại kho cookie (phiên đăng nhập canvasapp) một chiều; bật rồi tắt sẽ mất cookie. Không bao giờ bật rồi tắt |

LoadBrowserProcessSpecificV8Snapshot để mặc định; fuse 8 (WasmTrapHandlers) không đụng tới.

**Toàn vẹn asar kiểm tra lúc nào**: header của `app.asar` (danh sách file) được so lúc mở app; nội dung **từng file** được so
khi file đó được đọc lần đầu. File đọc lúc mở (`index.html`, mã main…) bị sửa → app không mở. File đọc muộn (đoạn mã của
một màn hình mở sau: Cài đặt, xem take, hộp cập nhật…) bị sửa → app mở bình thường rồi **tự tắt** khi người dùng mở tới
màn hình đó, mất những gì chưa kịp tự lưu.

**Giới hạn** (nói đúng với người dùng, đừng hứa hơn):
- Chỉ `app.asar` được kiểm tra toàn vẹn **trước khi chạy**. `SanoVids.exe` và các DLL được ký số nhưng Windows **không
  chặn** chạy exe / nạp DLL đã bị sửa hay bị thay: app vẫn mở; **Cài đặt → Giới thiệu** báo "File của SanoVids đã bị thay
  đổi" / "Không phải bản gốc" khi exe hoặc một trong 6 DLL của Electron sai chữ ký (mục 6) — tức là sau khi mã đó đã chạy.
- Các file khác trong thư mục cài (`*.pak`, `locales\`, `v8_context_snapshot.bin`…) không được kiểm tra, và một DLL lạ đặt
  thêm cạnh exe (Windows tìm DLL trong thư mục của exe trước) chạy bên trong SanoVids trong khi Giới thiệu vẫn báo đã ký.
- Mã băm của `app.asar` nằm trong `SanoVids.exe`, nên ai ghi được vào thư mục cài có thể thay cả hai. Bản cài mặc định
  là "Only for me" (`%LOCALAPPDATA%\Programs\…`), thư mục mà mọi chương trình chạy bằng tài khoản đó đều ghi được.
- Tóm lại: các lớp này chống **sửa nhầm / hỏng file / sửa một phần** và giúp người dùng nhận ra bản không chính thức;
  chúng không thay được phần mềm diệt virus trước một chương trình độc đã chạy trên máy. Cài "Anyone who uses this
  computer" (`Program Files`, cần quyền quản trị để ghi) chặn được việc sửa thư mục cài bằng quyền người dùng thường.

**Trong `electron/main.cjs`** (quy tắc thuần trong `electron/hardening-rules.cjs`, test `hardeningRules.test.ts`):
- **Bản đóng gói** được nhận ra bằng `isPackagedApp`: `app.isPackaged` **hoặc** app chạy từ một `app.asar` (Electron chỉ
  xét tên file exe, nên một bản `SanoVids.exe` đổi tên thành `electron.exe` không tắt được các lớp dưới đây).
- **Từ chối tham số gỡ lỗi / tắt bảo mật** (bản đóng gói, danh sách `ALWAYS_REFUSED`): trình gỡ lỗi và cờ V8
  (`--inspect…`, `--debug…`, `--js-flags`), tham số tắt bảo mật của Chromium (`--ignore-certificate-errors…`,
  `--no-sandbox`, `--disable-web-security`, `--disable-site-isolation-trials`, `--disable-features`,
  `--disable-gpu-sandbox`, `--single-process`, `--in-process-gpu`…), tham số khiến exe đã ký chạy một chương trình khác
  làm tiến trình con (`--gpu-launcher`, `--renderer-cmd-prefix`, `--utility-cmd-prefix`, `--browser-subprocess-path`) và
  tham số ghi khoá TLS / nhật ký mạng ra đĩa (`--ssl-key-log-file`, `--log-net-log`) → hộp báo lỗi rồi thoát mã **3**,
  trước khi đụng tới dữ liệu. Biến môi trường `SSLKEYLOGFILE` bị xoá khỏi tiến trình. `--remote-debugging-*` /
  `--remote-allow-origins` chỉ được phép trong **bản build thử** (có `sanovidsTestProfileDir` nướng sẵn, thứ cổng phát
  hành chặn) chạy với profile thử — không bao giờ trong bản chính thức, kể cả khi có `SANOVIDS_PROFILE_DIR`.
- **DevTools** chỉ có khi chạy từ mã nguồn, hoặc bản build thử với profile thử (cửa sổ chính, cửa sổ đăng nhập canvasapp và
  cửa sổ popup của nó, cửa sổ thanh toán).
- `app.enableSandbox()`: mọi trang chạy trong sandbox (cùng `contextIsolation`, không `nodeIntegration`, IPC chỉ nhận
  từ `app://bdp/` như trước).
- **Tải về**: chỉ nhận `blob:app://bdp/…` với đuôi `mp4 webm mov m4v jpg jpeg png webp svg txt zip json`; còn lại huỷ
  (log chỉ ghi đuôi file, không ghi tên).
- **Quyền** của phiên mặc định: chỉ `clipboard-sanitized-write`, `fileSystem`, `fullscreen`, `persistent-storage`; thiết bị
  (USB / HID / serial) luôn từ chối. Không `<webview>`, không chọn thiết bị Bluetooth.
- Cửa sổ đăng nhập canvasapp và mọi popup con của nó chỉ mở `https:`, cùng cấu hình bảo mật.
- **CSP** trên mọi trang HTML của `app://bdp/`: `script-src 'self'` + mã băm SHA-256 của đoạn script chọn giao diện
  trong `index.html` (tính từ chính file đó), không `eval`, `object-src 'none'`, không khung, không form.

## 9. Xử lý sự cố

| Triệu chứng | Nguyên nhân | Làm gì |
|---|---|---|
| Bấm SanoVids không thấy gì mở (không cửa sổ, không báo lỗi) | `app.asar` trong thư mục cài bị sửa / hỏng (diệt virus "sửa" file, chép đè, ổ đĩa lỗi…): kiểm tra toàn vẹn asar chặn | Tải bộ cài ở trang tải về, cài đè. Dữ liệu ở `%APPDATA%\SanoVids` giữ nguyên |
| SanoVids tự tắt đột ngột khi mở một màn hình (Cài đặt, xem take…), lần nào cũng ở đúng màn hình đó | Một file bên trong `app.asar` bị hỏng: Electron chỉ kiểm tra nó khi đọc tới, rồi thoát | Như trên: cài đè từ trang tải về |
| Hộp "SanoVids không mở khi có tham số gỡ lỗi…" | Lối tắt / lệnh mở có thêm tham số | Mở bằng biểu tượng bình thường, xoá tham số trong lối tắt |
| Lỗi cập nhật `signature` ("Bản cập nhật này không mang chữ ký số đúng của tác giả…") | Bộ cài trên nguồn cập nhật không ký, ký bởi chứng chỉ khác (kể cả trùng tên), bị sửa, hoặc không đúng phiên bản được báo | Người dùng: đừng tự tải bản đó về cài; chỉ cài bộ cài có dấu vân tay trùng **Cài đặt → Giới thiệu**, hoặc hỏi tác giả. Tác giả: xem dòng `signature <lý do>` trong `updater.log`, chạy `release:check`, đăng bản mới hơn ký đúng |
| Lỗi cập nhật `signature-unverified` ("Chưa kiểm tra được chữ ký số của bản cập nhật…") | PowerShell bị chính sách (AppLocker / WDAC) / diệt virus chặn, quá 60 s, hoặc chuỗi chứng chỉ lạ | Bấm **Thử lại**; app tự thử lại mỗi ngày. Tác giả: lý do ở dòng `signature <lý do>` |
| Giới thiệu: "Chưa kiểm tra được chữ ký số" | PowerShell bị chính sách / diệt virus chặn, quá 60 s, hoặc thiếu một DLL | Không ảnh hưởng việc dùng app; kiểm tra tay bằng Properties |
| Giới thiệu: "Không phải bản gốc" / "File… đã bị thay đổi" | Bản cài không chính thức, hoặc `SanoVids.exe` / một DLL của Electron bị sửa hay bị thay | Gỡ, tải bản chính thức (so dấu vân tay), cài lại |
| Build: `Cannot find certificate …` | Máy không có khoá | Mục 3 |
| `release:check`: "… không được ký bởi tác giả … Thêm "x.dll" vào package.json build.win.signExts" | Bản Electron mới có thêm file mã chưa ký | Thêm đúng tên file vào `build.win.signExts`, build lại |
| `release:check`: "… được ký bằng chứng chỉ …, không phải chứng chỉ ký của bản này" | `certificateSha1` / `SIGNER_THUMBPRINT` lệch nhau, hoặc bản build cũ | Sửa cho khớp (mục 7), build lại |
| `release:check`: "… mọi máy đang dùng v… sẽ TỪ CHỐI bản cập nhật này" | Đổi chứng chỉ ký mà bản công khai trước chưa ghim nó | Làm đúng bước 2 rồi 3 của mục 7 |
| `release:check`: "Mã SHA-256 trong file exe … khác header app.asar" / "không có tài nguyên INTEGRITY" | `app.asar` bị đổi sau khi electron-builder tính mã (hook sau đóng gói, công cụ khác…) | Không đăng: build lại sạch bằng `npm run dist:win` |

Bài thử đầu-cuối của chữ ký số (chứng chỉ thử chỉ là file, không đụng kho chứng chỉ của Windows): [UPDATES.md](UPDATES.md)
mục 4.
