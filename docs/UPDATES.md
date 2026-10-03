# Tự cập nhật & phát hành bản mới

> Từ **0.5.0**, bản cài **Setup** của SanoVids tự tìm, tải và cài bản mới. Tài liệu này dành cho chủ dự án và người
> sửa mã: cách tự cập nhật hoạt động, cách đăng một bản mới, các quy tắc an toàn và cách thử nghiệm.
> Phần dành cho người dùng: mục **🔄 Cập nhật tự động** trong [README](../README.md). Chữ ký số, ghim chứng chỉ và chống
> can thiệp: [SIGNING.md](SIGNING.md).

## 1. Tóm tắt

| | |
|---|---|
| Bản tự cập nhật | **Setup (NSIS)**: tải trong nền, cài khi khởi động lại hoặc khi tắt app |
| Bản chỉ báo | **Portable** (và thư mục `win-unpacked`): báo có bản mới, nút **Tải bản mới** mở trang tải về |
| Không cập nhật | Chạy từ mã nguồn (`npm run desktop`, `electron .`) và bản web |
| Nguồn cập nhật | GitHub Releases của repo **công khai** [`JameSteven404/sanovids-releases`](https://github.com/JameSteven404/sanovids-releases/releases) — chỉ chứa file cài đặt + file cập nhật |
| Mã nguồn | Repo `JameSteven404/sanovids` vẫn **riêng tư**. App **không chứa token** nào |
| Thư viện | `electron-updater` 6.8.10 (ghim đúng bản, khớp electron-builder 26) — phụ thuộc runtime duy nhất |
| Chữ ký số | Bản cập nhật chỉ được nhận khi ký bởi chứng chỉ có dấu vân tay ghim trong app (`package.json` → `sanovids.signers`); bộ kiểm tra riêng `electron/signature.cjs`, xem [SIGNING.md](SIGNING.md) |

Bản ≤ 0.4.2 không có trình cập nhật: người dùng phải **cài tay 0.5.0 một lần**.

## 2. Cách hoạt động

```
package.json  build.publish = { github, JameSteven404, sanovids-releases, releaseType: release }
      │ electron-builder (npm run dist:win)
      ▼
resources/app-update.yml  ← nguồn DUY NHẤT app đọc (không setFeedURL, không token, renderer không gửi URL)
      │
electron/main.cjs ── setupUpdater() ──▶ electron/updater.cjs ──▶ electron-updater (NsisUpdater)
      │                                   │ quy tắc thuần: electron/updater-rules.cjs       │ HTTPS
      │                                   │ IPC updates:* (chỉ nhận từ app://bdp/)          ▼
electron/preload.cjs → window.bdpDesktop.updates            github.com/JameSteven404/sanovids-releases
      ▼
renderer: lib/updates.ts ⇄ src/updateActions.ts ⇄ UpdatePill · UpdateDialog · Cài đặt → Cập nhật
```

**Một lần kiểm tra** (electron-updater, nhà cung cấp GitHub, không đăng nhập):
1. `GET /JameSteven404/sanovids-releases/releases.atom` và `GET …/releases/latest` (Accept: JSON) → tag mới nhất (bỏ qua bản nháp và pre-release).
2. `GET …/releases/download/<tag>/latest.yml` → phiên bản, tên file, kích thước, **SHA-512**, ngày, ghi chú.
3. Mới hơn bản đang chạy → tải (bản cài, khi bật "Tự động tải bản cập nhật"):
   - lấy `.blockmap` của bản mới **và của bản đang chạy** (`…/download/v<bản cũ>/SanoVids-Setup-<bản cũ>.exe.blockmap`), so sánh với bản cài cũ nằm trong `%LOCALAPPDATA%\sanovids-updater\` và chỉ tải các khúc thay đổi (HTTP Range). Không được thì tải cả file;
   - kiểm tra SHA-512 của file ghép xong; sai là bỏ (`checksum`);
   - **kiểm tra chữ ký số** (`electron/signature.cjs`, bảng quyết định trong `updater-rules.cjs`, [SIGNING.md](SIGNING.md) mục 5): phải ký bởi một dấu vân tay trong `sanovids.signers` **và** đúng là bản được báo (ProductName SanoVids, ProductVersion = phiên bản trong `latest.yml`, mới hơn bản đang chạy: không quay về bản cũ). Không ký, người ký khác (kể cả trùng tên), file bị sửa, sai phiên bản → **xoá file**, không cài, lỗi `signature`; file đó được nhớ theo SHA-512 trong `updater.json` và không bao giờ được tự tải lại (bấm **Thử lại** vẫn được). Không kiểm tra được (PowerShell bị chặn, quá lâu…) → không cài, lỗi `signature-unverified`, tự thử lại mỗi ngày. Bộ kiểm tra gắn cả vào `verifyUpdateCodeSignature` lẫn ghi đè `verifySignature` của updater, nên `app-update.yml` thiếu `publisherName` cũng không bỏ qua được.
4. Xong → **kiểm tra chữ ký lần nữa** rồi mới tới trạng thái `ready` (file gắn với mã SHA-512 của nó). **Khởi động lại để cập nhật** = băm lại + kiểm tra lần thứ ba rồi `quitAndInstall(silent, relaunch)`; tắt app khi đang `ready` = `autoInstallOnAppQuit` (cài im lặng, không tự mở lại) — chỉ khi bộ cài vẫn đúng là file đã xác minh (băm lại lúc tắt), khác thì bỏ qua lần cài khi tắt.

**Lịch**: lần đầu 15 giây sau khi cửa sổ hiện; sau đó cứ 10 phút xem đã tới hạn chưa (4 giờ sau lần thử trước, 30 phút nếu lần trước mất mạng / GitHub giới hạn), và khi máy thức dậy. Kiểm tra tự động **không** hiện hộp thoại hay thông báo, trừ một trường hợp: bản tải về bị từ chối hoặc chưa kiểm tra được chữ ký số → một thông báo cho mỗi phiên bản (nút mở hộp cập nhật; **Cài đặt → Cập nhật → Xem chi tiết** cũng mở được). **Kiểm tra ngay** luôn báo kết quả.

**Loại bản** (`updater-rules.detectKind`): chưa đóng gói → `dev`; có biến `PORTABLE_EXECUTABLE_FILE` → `portable`; cạnh file exe có `Uninstall SanoVids.exe` → `installer`; còn lại → `portable` (chỉ kiểm tra).

**Trước khi khởi động lại** (renderer, `updateActions.installNow`): giữ không gửi video mới → đợi video đang gửi gửi xong (tối đa 15 s) → lưu chữ đang gõ trong ô prompt → lưu dự án (autosave) → `updates:install`. Không bao giờ khởi động lại khi hộp **Nhập prompt** đang mở (chữ dán vào chỉ nằm trong hộp đó). Main ghi `attempt` vào `updater.json` (khi tắt app: trong sự kiện `quit`, cùng lúc và cùng điều kiện mã thoát 0 với electron-updater, nên một lần tắt bị cửa sổ khác chặn không để lại `attempt`); lần mở sau so phiên bản để báo **"Đã cập nhật SanoVids lên …"** hoặc **"Chưa cài được bản …"**. Mở lại trong vòng 2 phút sau khi tắt (bộ cài có thể vẫn đang chạy, ~15 s) thì không báo gì và giữ `attempt` cho lần mở sau. Nếu 18 giây sau `quitAndInstall` app vẫn còn chạy, main báo cài thất bại và trả trình cập nhật về trạng thái dùng được (cài lại / cài khi tắt). "Cập nhật khi xong" đợi hàng đợi (trừ video của cảnh đã xoá — chúng không bao giờ chạy và vẫn còn sau khi khởi động lại), video chờ lưu vào thư mục, lượt nạp credit và hộp **Nhập prompt** rảnh hết, đếm ngược 5 giây (huỷ được) rồi mới cài.

**Kiểm tra lại khi đã biết có bản mới** không làm mất bản đó: trạng thái `available` giữ nguyên trong lúc kiểm tra (nút trên thanh không nháy) và một lần kiểm tra lỗi (mất mạng…) không xoá nó. GitHub giới hạn lượt / lỗi 5xx ở bước `releases/latest` (electron-updater gói chung thành "không tìm thấy bản") được nhận ra từ mã HTTP thật: 403 / 429 → **Máy chủ cập nhật đang bận** (thử lại sau 30 phút).

**Trang chọn kiểu cài** của bộ cài tiếng Việt vẫn hiện bằng tiếng Anh ("Choose Installation Options", có từ 0.4.2): electron-builder chưa có bản dịch tiếng Việt cho trang này. Mặc định là "Only for me" (chỉ người dùng này) — đúng cấu hình `perMachine: false`.

**Cài cho mọi người dùng** (trang chọn kiểu cài của bộ cài: "Anyone who uses this computer" → `Program Files`): electron-builder không đánh dấu `isAdminRightsRequired` với cấu hình `oneClick: false, perMachine: false`, nên bộ cài cập nhật tự xin quyền quản trị → Windows hiện **UAC** mỗi lần cập nhật, kể cả lúc cài khi tắt app (cửa sổ đã đóng). Từ chối → vẫn bản cũ, lần mở sau báo "Chưa cài được bản …". Bài E2E chỉ thử kiểu cài "Only for me" (cài cho mọi người dùng cần bấm UAC, không tự động được). Đổi kiểu cài mặc định (vd. chỉ cho phép per-user) phải tính tới người đang cài per-machine.

### Các file

| File | Vai trò |
|---|---|
| `electron/updater.cjs` | Nối electron-updater: IPC `updates:getState / check / download / install / setPrefs / openReleasePage`, đẩy `updates:state` (chỉ tới cửa sổ chính), lịch kiểm tra, log, `updater.json` |
| `electron/updater-rules.cjs` | Thuần, không `require` gì: so phiên bản, loại bản, reducer trạng thái, đổi lỗi thành câu tiếng Việt cố định, ghi chú → chữ thường, thư mục profile, **script PowerShell + bảng quyết định chữ ký số** (`judgeSignature`). Test: `src/lib/__tests__/updaterRules.test.ts`, `signature.test.ts` |
| `electron/signature.cjs` | Đọc ghim `sanovids.signers` (`readSignerPins`), kiểm tra chữ ký một file bằng `powershell.exe` (`checkFileSignature`, tối đa 60 s, không bao giờ ném lỗi). Không `require('electron')`: main, updater và script phát hành cùng dùng |
| `electron/main.cjs` | Gọi `setupUpdater` trước khi tạo cửa sổ; `will-prevent-unload` + sự kiện `quit` để ghi lần cài khi tắt; override profile chỉ dùng khi thử; tự kiểm tra chữ ký (`app:signature`) và các lớp chống can thiệp ([SIGNING.md](SIGNING.md) mục 8) |
| `electron/preload.cjs` | `window.bdpDesktop.updates` (7 hàm), `window.bdpDesktop.app.signature()` |
| `src/lib/updateTypes.ts` | Hợp đồng dữ liệu main ⇄ renderer |
| `src/lib/updateModel.ts` | Thuần: kiểm tra state nhận được, chữ hiển thị, nút trên thanh trên cùng, nút trong hộp thoại, thông báo |
| `src/lib/updatePrefs.ts` | Cài đặt máy `bdp:pref:updates` = `{ autoDownload }` (có trong sao lưu / khôi phục cài đặt) |
| `src/lib/updates.ts` | Chọn cầu nối (desktop / giả lập / không có) + store gương |
| `src/updateActions.ts` | Thông báo, luồng cài, "Cập nhật khi xong" |
| `UpdatePill.tsx`, `UpdateDialog.tsx`, nhóm Cài đặt "Cập nhật" | Giao diện |
| `src/providers/dev/updates.ts`, tab Bảng phát triển "Cập nhật" | Giả lập trình cập nhật khi chạy `npm run dev` (không bao giờ chạy trong Electron) |
| `scripts/update-notes.mjs` | Mục CHANGELOG của phiên bản → `build/release-notes.md` (gitignore) → `releaseNotes` trong latest.yml = phần **Có gì mới** trong app. Dòng tiêu đề kiểu `✨ **…**` thành `### ✨ …` để app hiện là tiêu đề |
| `scripts/electron-build.mjs` | Chạy electron-builder cho `dist:win`: tắt cache build (`ELECTRON_BUILDER_DISABLE_BUILD_CACHE=true`), từ chối khi có `ELECTRON_BUILDER_OFFLINE` (mất dấu thời gian) hoặc thiếu `--publish never` |
| `scripts/tidy-release.mjs` | Dọn `release/`; giữ `latest.yml` + blockmap hiện tại trong `release/_build`; **cảnh báo to** nếu app-update.yml không trỏ đúng nguồn hoặc **thiếu `publisherName`** |
| `scripts/publish-release.mjs` + `scripts/releaseLib.mjs` | Kiểm tra rồi đăng lên hai repo. Logic thuần trong releaseLib, test: `scripts/__tests__/releaseLib.test.mjs` |
| `scripts/buildInspect.mjs` | Đọc lại một bản build Windows: chữ ký + dấu thời gian của Setup / Portable / exe / `elevate.exe`, chữ ký của **mọi** file mã trong `win-unpacked`, thông tin phiên bản, fuse, mã toàn vẹn asar trong exe, `win-unpacked` không mới hơn bộ cài, giấy phép cạnh exe, `app-update.yml` (nhóm kiểm tra **(j)**, dùng lại trong bài E2E). Test: `scripts/__tests__/buildInspect.test.mjs` |
| `scripts/third-party-notices.mjs` | Tạo `build/license-third-party.txt` (chép thành `THIRD-PARTY-NOTICES.txt` cạnh exe) từ `node_modules`: giấy phép của mọi gói mà renderer import / `app.asar` chứa. Test `thirdPartyNotices.test.mjs` báo khi file đã cũ |

### Dữ liệu trên máy người dùng

| Ở đâu | Là gì |
|---|---|
| `%APPDATA%\SanoVids\updater.json` | `{ v: 1, autoDownload, attempt?, rejected? }` — bản sao cài đặt cho main, lần cài đang chờ, và tối đa 5 file cập nhật đã bị từ chối / chưa kiểm tra được (phiên bản, SHA-512, lý do, thời điểm) để không tự tải lại |
| `%APPDATA%\SanoVids\logs\updater.log` | Nhật ký trình cập nhật (quá 256 KB thì chuyển sang `updater.1.log`) — xin file này khi người dùng báo lỗi |
| `%APPDATA%\SanoVids\.updaterId` | Mã cài đặt ngẫu nhiên của electron-updater, gửi kèm mỗi lần kiểm tra (`x-user-staging-id`) |
| `%LOCALAPPDATA%\sanovids-updater\` | `pending\` = bản cài đã tải / đang tải: lần mở đầu tiên sau khi cập nhật xong dọn nó (kiểm tra lại thư mục đã trống, thử lại sau 5 / 20 / 60 giây khi bộ cài vừa chạy còn giữ file; không bao giờ lúc đang tải hay có bản chờ cài). `installer.exe` + `current.blockmap` = bản sao bộ cài hiện tại (để tải phần thay đổi); `current.blockmap` bị xoá khi bản vừa tải bị từ chối hoặc không được cài |
| localStorage `bdp:pref:updates` | Công tắc "Tự động tải bản cập nhật" (khác `downloads.autoDownload` = "Tự tải khi video xong") |

## 3. Đăng một bản mới (chủ dự án)

**Chuẩn bị một lần**
- Cài [GitHub CLI](https://cli.github.com) và `gh auth login` bằng tài khoản JameSteven404 (có quyền ghi cả hai repo).
- Tạo repo **công khai** `JameSteven404/sanovids-releases`, **có README** (để có nhánh `main`). Không đưa mã nguồn vào repo này. Nội dung của nó nằm sẵn ở `scripts/releases-repo/` (`README.md`, `LICENSE.txt`, `SanoVids-NguyenGiangMinh.cer`, `tin-cay-chung-chi.ps1`): đẩy tay lên nhánh `main` của repo công khai (`release:check` báo ⚠ khi thiếu file hoặc file lệch bản gốc).
- Máy build phải có **khoá ký** trong `Cert:\CurrentUser\My` (dấu vân tay `7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`); máy khác thì khôi phục bằng `scripts/signing/khoi-phuc-khoa-ky.ps1`. Xem [SIGNING.md](SIGNING.md).
- Bật xác thực hai lớp (2FA) cho tài khoản GitHub: ai nắm tài khoản là nắm được bản cập nhật của mọi người dùng.

**Mỗi lần phát hành**
1. Viết mục `## [x.y.z] — yyyy-mm-dd — tiêu đề` ở đầu `CHANGELOG.md` (viết cho người dùng: đây là phần **Có gì mới** trong app và trên trang tải về), thêm dòng liên kết `[x.y.z]: https://github.com/JameSteven404/sanovids-releases/releases/tag/vx.y.z` ở cuối, đổi `version` trong `package.json`.
2. Merge vào `main` (PR như mọi lần).
3. Trên `main` đã cập nhật: `git tag -a vx.y.z -m "SanoVids x.y.z"` → `git push origin vx.y.z`.
4. `npm run dist:win` — **sau** khi tag (kiểm tra đòi ngày build mới hơn commit), **có mạng** (dấu thời gian của chữ ký). Lệnh này tự chạy `update-notes`, kiểm tra `THIRD-PARTY-NOTICES` còn mới (`third-party-notices.mjs --check`; cũ thì chạy `node scripts/third-party-notices.mjs` rồi commit), build qua `scripts/electron-build.mjs` với `--publish never` (electron-builder không tự đăng gì), **ký số** mọi file `.exe` bằng khoá trên máy (thiếu khoá là build dừng) và `tidy-release`.
5. `npm run release:check` — chỉ đọc, không đăng: in danh sách ✓ / ⚠ / ✗ và **đúng các lệnh `gh` sẽ chạy**. Phải hết ✗.
6. `npm run release:publish` — chạy lại toàn bộ kiểm tra rồi:
   1. repo riêng `sanovids`: tạo **bản nháp** (`--verify-tag`), tải Setup + Portable + `SanoVids-NguyenGiangMinh.cer` lên;
   2. repo công khai `sanovids-releases`: tạo **bản nháp** (`--target main`), tải Setup, `.blockmap`, `latest.yml`, Portable, `SanoVids-NguyenGiangMinh.cer` lên;
   3. đọc lại từ GitHub: đủ file, đúng kích thước, đúng **SHA-256** (không có mã thì tải về tính lại);
   4. đăng bản riêng, rồi **cuối cùng** mới đăng bản công khai (`--draft=false --prerelease=false --latest`) — từ giây này máy người dùng thấy bản mới;
   5. kiểm tra như một máy lạ (không đăng nhập): `/releases/latest` = tag mới, `latest.yml` tải về giống hệt file trên máy, `releases.atom` có tag mới (5 lần, cách 10 giây).
7. Mở trang tải về xem lại bằng mắt. Máy đã cài bản Setup sẽ nhận bản mới trong vòng vài giờ.

**`release:check` kiểm tra gì**:
- (a) mục CHANGELOG (thiếu dòng liên kết chỉ ⚠);
- (b) git sạch, tag `vX.Y.Z` = HEAD = tag trên GitHub, HEAD nằm trong `origin/main` (bản xem trước không `git fetch` nên báo ⚠ thông tin có thể cũ; không ở `main` cũng ⚠);
- (c) đủ **5 file**: Setup, Portable trong `release/`; `.blockmap`, `latest.yml` trong `release/_build/` (hoặc `release/`); `build/signing/SanoVids-NguyenGiangMinh.cer`;
- (d) `latest.yml` khớp file Setup (phiên bản, đường dẫn, SHA-512, kích thước, ngày build ≥ ngày commit; thiếu ghi chú chỉ ⚠);
- (e) blockmap giải nén được;
- (f) **`app-update.yml` trỏ đúng `github / JameSteven404 / sanovids-releases`, CÓ `publisherName` đúng bằng `Nguyễn Giang Minh (Jame Steven)`, không token / private / channel — lỗi này luôn chặn**. Thiếu `publisherName` không tắt bộ kiểm tra chữ ký của app (nó luôn chạy), nhưng mất lớp kiểm tra thứ hai của electron-updater và cho thấy bản build không dùng cấu hình phát hành;
- (g) `app.asar` có `electron/main.cjs`, `preload.cjs`, `updater.cjs`, `updater-rules.cjs`, `signature.cjs`, `hardening-rules.cjs`, `electron-updater` **và mọi gói nó cần khi chạy** (đọc `dependencies` lần lượt theo cách Node tìm gói: `builder-util-runtime`, `js-yaml`, `semver`, `fs-extra`…), và `package.json` bên trong là `sanovids / SanoVids / X.Y.Z`, tác giả `Nguyễn Giang Minh (Jame Steven)`, `sanovids.signers` đúng như trong repo (bản build thử có ghim thêm bị chặn), không có `sanovidsTestProfileDir`;
- (h) `package.json`: `build.publish` đúng, không token / private, không có script tên `release`; `author.name` và `build.win.signtoolOptions.publisherName` = `Nguyễn Giang Minh (Jame Steven)`, `build.copyright` = `© 2026 Nguyễn Giang Minh (Jame Steven) · Đồng hành: Sano Group`; có `sanovids.signers`; `build.win.signtoolOptions.certificateSha1` = `SIGNER_THUMBPRINT` (`scripts/releaseLib.mjs`) và nằm trong `sanovids.signers`;
- (i) `gh` đã đăng nhập, repo công khai tồn tại, công khai, có nhánh, và chưa có bản nào mới hơn;
- (j) **Chữ ký số — luôn chặn** (`scripts/buildInspect.mjs`):
  - Setup, Portable, `SanoVids.exe`, `elevate.exe` ký bằng **đúng** chứng chỉ `SIGNER_THUMBPRINT` **và có dấu thời gian**; `ffmpeg.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`, `dxcompiler.dll` ký bởi chứng chỉ đó; `d3dcompiler_47.dll` / `dxil.dll` giữ chữ ký Microsoft;
  - **mọi file mã khác** trong `win-unpacked` (`*.exe`, `*.dll`, `*.node`…) được tác giả ký hoặc giữ chữ ký hợp lệ của hãng làm ra nó (thiếu → "Thêm … vào package.json build.win.signExts");
  - CompanyName = tác giả, LegalCopyright = copyright ở (h) (exe, Setup, Portable); Setup có ProductName = `SanoVids`, ProductVersion = đúng phiên bản và đủ lớn của một bộ cài (đúng điều app đã cài đòi ở bản cập nhật: sai là mọi máy tải về rồi từ chối); thiếu một DLL trong danh sách (`SIGNED_DLLS` / `MICROSOFT_DLLS` của `electron/hardening-rules.cjs`, dùng chung với phần tự kiểm tra) là chặn; fuse đúng; không có `app.asar.unpacked`; mã toàn vẹn asar (`INTEGRITY/ELECTRONASAR`) trong exe khớp header `app.asar`; exe và `app.asar` của `win-unpacked` không mới hơn Setup / Portable; `LICENSE.txt` và `THIRD-PARTY-NOTICES.txt` cạnh exe giống hệt bản trong repo;
  - file `build/signing/SanoVids-NguyenGiangMinh.cer` khớp ghim (file này được băm SHA-256 và tải lên cùng các file khác);
  - **"ghim trước, ký sau"**: `SIGNER_THUMBPRINT` nằm trong `sanovids.signers` của bản công khai mới nhất trước bản này (`git show v<bản đó>:package.json`; chưa có bản công khai nào thì bỏ qua).
- Nhóm ⚠ **Repo công khai**: `scripts/releases-repo/` đủ `README.md`, `LICENSE.txt` (giống hệt `LICENSE.txt` gốc), `.cer` (giống hệt `build/signing/`) và `tin-cay-chung-chi.ps1` (giống hệt `scripts/signing/`).
- Có biến `ELECTRON_BUILDER_OFFLINE` trong môi trường → chặn.

**Chạy lại an toàn**: bị ngắt giữa chừng (mất mạng, tắt máy…) thì chạy lại `npm run release:publish`. Kế hoạch tự tính theo trạng thái trên GitHub:

| Trên GitHub | Việc làm |
|---|---|
| chưa có bản | tạo nháp → tải lên → kiểm tra → đăng |
| bản nháp | cập nhật ghi chú → tải file còn thiếu, ghi đè (`--clobber`) file khác → kiểm tra → đăng |
| đã đăng, đủ và khớp | bỏ qua |
| đã đăng, thiếu file | tải bổ sung → kiểm tra |
| đã đăng, **file khác** | **DỪNG** — không bao giờ ghi đè file đã đăng (máy người dùng có thể đang tải nó). Muốn sửa: tăng phiên bản và đăng bản mới |

Ghi chú GitHub được lưu ở `release/_build/publish/notes-private.md` và `notes-public.md` (bản xem trước ghi vào thư mục tạm). Bản công khai không có liên kết nào vào repo riêng.

### Quy tắc an toàn (đừng phá)
- **Không bao giờ build bản phát hành thiếu `build.publish`** (hoặc trỏ nơi khác): người cài bản đó sẽ không bao giờ nhận bản sau. `tidy-release` cảnh báo, `release:check` chặn.
- **Không xoá bản phát hành công khai cũ hay file `.blockmap` cũ**: máy đang ở bản cũ cần blockmap của bản cũ để chỉ tải phần thay đổi; ai đó có thể đang tải. Không đổi repo công khai thành riêng tư (mọi app sẽ báo "Chưa tìm thấy bản cập nhật nào").
- **Luôn đăng qua bản nháp**, repo công khai **cuối cùng**. Không đánh dấu pre-release (app bỏ qua pre-release).
- **Không dùng lại số phiên bản**, không sửa file của bản đã đăng. Tag luôn là `v<phiên bản>`, tên file luôn có phiên bản.
- **Không thêm script tên `release`** vào `package.json` (electron-builder tự đăng bản khi `npm_lifecycle_event === 'release'`). Mọi lệnh electron-builder đều kèm `--publish never`.
- Không đặt `channel`, `token`, `private` trong cấu hình; không gọi `setFeedURL` / `addAuthHeader`. **`publisherName` là bắt buộc**: nó đến từ `build.win.signtoolOptions.publisherName` và electron-builder ghi vào `app-update.yml`. Không đặt `win.verifyUpdateCodeSignature` (làm mất `publisherName`).
- **Không bao giờ phát hành bản chưa ký** hoặc ký bằng chứng chỉ chưa được ghim: mọi máy đã cài sẽ từ chối nó. Đổi chứng chỉ đúng quy trình "ghim trước, ký sau" ([SIGNING.md](SIGNING.md) mục 7). Không build bản phát hành với `ELECTRON_BUILDER_OFFLINE` (mất dấu thời gian).
- Không thêm `beforeunload` trong mã desktop: nó lặng lẽ chặn `quitAndInstall`.
- Đổi phiên bản Electron = người dùng phải tải gần như cả bộ cài (~100 MB). Gom việc nâng Electron vào ít bản thôi.

### Bảo mật
- Mọi file `.exe` được **ký số** bởi Nguyễn Giang Minh (Jame Steven) (SHA-256, dấu thời gian DigiCert). App chỉ nhận bản cập nhật ký bởi một dấu vân tay ghim trong app (`sanovids.signers`, nằm trong `app.asar`) và đúng là phiên bản mới được báo, kiểm tra ngay sau khi tải, trước khi báo sẵn sàng và trước mỗi lần cài; cộng thêm HTTPS của GitHub và SHA-512 trong `latest.yml`. Với **máy đã cài**, chiếm được tài khoản GitHub thôi chưa đủ để đẩy bản cập nhật độc: còn cần khoá ký, thứ không bao giờ rời máy tác giả. **Người cài mới** và **script tin cậy chứng chỉ** thì vẫn phụ thuộc tài khoản GitHub: trang tải về, bộ cài, `.cer` và script cùng nằm trên đó, nên ai chiếm được tài khoản thay được cả bộ cho khớp nhau. Vì vậy: bật 2FA, không chia sẻ token, và tài liệu cho người dùng luôn dặn so dấu vân tay với một nguồn khác (tác giả gửi trực tiếp, hoặc Cài đặt → Giới thiệu của bản đã cài). Chi tiết: [SIGNING.md](SIGNING.md).
- Nguồn cập nhật cố định trong app; trang (renderer) chỉ xin main kiểm tra / tải / cài / mở trang tải về cố định. Main chỉ nhận lệnh từ `app://bdp/`, bỏ qua mọi tham số trừ `setPrefs({ autoDownload: boolean })`.
- Ghi chú phát hành chỉ hiện dạng **chữ** (không HTML). Lỗi hiện bằng câu tiếng Việt cố định, không bao giờ hiện thông báo lỗi gốc.
- Mỗi lần kiểm tra GitHub nhận IP và mã cài đặt ngẫu nhiên `x-user-staging-id`; không có gì từ dự án. electron-updater đọc thẳng github.com (không qua API nên ít bị giới hạn lượt), và app chỉ kiểm tra 4 giờ một lần.

## 4. Thử nghiệm

**Tự động**: `npm test` gồm `src/lib/__tests__/updaterRules.test.ts` (quy tắc main + cấu hình `package.json`), `signature.test.ts` (bảng quyết định chữ ký số, script PowerShell, tiến trình giả), `buildConfig.test.ts` (tác giả, ký số, fuse, bộ cài, giấy phép), `hardeningRules.test.ts` (tham số bị từ chối, tải về, quyền, CSP), test renderer (`updateModel`, `updatePrefs`, `updates`, `updateActions`, giả lập `dev-updates`, `settings`, `devModel`, `aboutModel`, `appSignature`) và `scripts/__tests__/`: `releaseLib.test.mjs` + `buildInspect.test.mjs` (CHANGELOG, ghi chú, latest.yml, app-update.yml, asar, chữ ký từng file mã, mã toàn vẹn asar, fuse, "ghim trước, ký sau", kế hoạch đăng bản), `signingFiles.test.mjs` (chứng chỉ công khai, script ký / tin cậy, giấy phép, không có khoá bí mật trong repo), `thirdPartyNotices.test.mjs` (giấy phép thư viện còn khớp `node_modules`), `docsSync.test.mjs` (câu lỗi chữ ký số trong tài liệu này khớp app).

**Giao diện**: `npm run dev` → Bảng phát triển → tab **Cập nhật** giả lập mọi trạng thái (bản cài / portable / phát triển, có bản mới, đang tải, đã tải xong, lỗi mạng, chưa có bản phát hành, **lỗi chữ ký số**) và mọi trạng thái chữ ký của khối **Giới thiệu** — không tải gì, không gọi mạng.

**Cách ly khi thử bản đóng gói** (bắt buộc với mọi lần chạy thử, nhất là khi agent chạy):
- Biến môi trường `SANOVIDS_PROFILE_DIR=<thư mục tạm>` chuyển dữ liệu app (userData) ra khỏi `%APPDATA%\SanoVids`. Bản build thử có thể "nướng" sẵn đường dẫn bằng `extraMetadata.sanovidsTestProfileDir` (vì bộ cài NSIS khởi động lại app **không** giữ biến môi trường). Khoá này **không bao giờ** có trong `package.json` thật.
- Đường dẫn phải tuyệt đối, ≤ 240 ký tự, không phải gốc ổ đĩa, không trùng / không nằm trong / không chứa `%APPDATA%\SanoVids`. Các bí danh Windows của thư mục đó cũng bị chặn: đường dẫn UNC / `\\?\` / `\\.\`, tên thư mục kết thúc bằng dấu chấm hay dấu cách, tên ngắn 8.3 (có `~`), luồng dữ liệu (`:` sau ký tự ổ đĩa), và (qua `realpath`) junction / symlink trỏ vào đó. Sai → app thoát với mã 2, không mở cửa sổ.
- Cổng gỡ lỗi (`--remote-debugging-port`, dùng cho CDP) và DevTools chỉ mở được trong **bản build thử** có `sanovidsTestProfileDir` nướng sẵn, chạy với profile thử; bản chính thức luôn từ chối (thoát mã 3), kể cả khi có `SANOVIDS_PROFILE_DIR`.
- **Không bao giờ chạy `electron .` hay bản đóng gói mà thiếu biến này** khi thử (dữ liệu thật của người dùng nằm ở `%APPDATA%\SanoVids`). Bộ cài thử phải có `appId` / `productName` / `executableName` riêng (vd. `com.sanovids.updtest` / `SanoVidsUpdTest`), cài vào thư mục tạm (`/S /D=…`), build với `--publish never` vào thư mục ra tạm, không bao giờ vào `release/`. Không đụng tới tiến trình SanoVids đang chạy của người dùng.

**Thử đầu-cuối (E2E)** — chạy bằng script trong thư mục tạm, không nằm trong repo:
- Build 3 bản cài thử `SanoVidsUpdTest` 0.5.90 → 0.5.91 → 0.5.92 (+ một bản portable), nguồn cập nhật `generic` tại `http://127.0.0.1:47391/` do một máy chủ Node nhỏ phục vụ (hỗ trợ Range).
- Cài A im lặng vào thư mục tạm, mở qua cổng gỡ lỗi (CDP) với profile tạm. Kiểm tra: `kind=installer`, các hàm `bdpDesktop.updates`, tham số sai bị từ chối.
- A→B: file Setup bị sửa 1 byte → lỗi `checksum`, không cài gì; file đúng → tải phần thay đổi (log máy chủ có cả hai blockmap và Range), nút trên thanh hiện 0.5.91, ghi chú hiện dạng chữ (`<b>` không thành thẻ); bấm **Khởi động lại để cập nhật** → app tắt, cài, mở lại 0.5.91, dữ liệu IndexedDB còn nguyên, thông báo "Đã cập nhật" hiện một lần.
- B→C: tắt tự tải → chỉ báo có bản mới, không tải; tải tay → `ready`; đóng cửa sổ → cài im lặng khi tắt, không tự mở lại; mở lại thấy 0.5.92.
- Portable: chỉ báo, `download` / `install` bị từ chối; bản chạy từ mã nguồn: `unsupported`; đường dẫn profile sai: thoát mã 2.
- Dọn dẹp: chỉ tắt tiến trình do bài thử mở (theo PID), gỡ bản cài thử bằng uninstaller của nó, xoá thư mục tạm; kiểm tra lại SanoVids thật của người dùng vẫn chạy và `%APPDATA%\SanoVids` không bị đụng.

**Thử chữ ký số (E2E, đã chạy 03/10/2026 trên commit `9c1b412`)** — bằng script trong thư mục tạm (bằng chứng: log, ảnh chụp, JSON lưu ngoài repo). Năm danh tính thử `SanoVidsUpdTest1…5` (appId `com.sanovids.updtestN`, productName / executableName riêng, nguồn cập nhật `generic` tại `127.0.0.1:4741N`, cài im lặng vào thư mục tạm, mở qua CDP với profile nướng sẵn). Chứng chỉ thử là **file** tạo bằng openssl (RSA 3072, *Code Signing*; không bao giờ nhập vào kho chứng chỉ của Windows, xoá khi xong): **T1** được ghim thêm qua `extraMetadata.sanovids.signers` (electron-builder **gộp** mảng nên bản thử ghim `[thật, T1]`), **T2** là kẻ giả — có lần mang đúng tên `CN=Nguyễn Giang Minh (Jame Steven)`, có lần trùng tên T1 — không ghim. Kết quả:
- **Cập nhật hợp lệ**: 0.5.90 → 0.5.91 qua **Khởi động lại để cập nhật** (kiểm tra chữ ký ở bước tải, ở `update-downloaded` và ngay trước khi cài; app tự mở lại 0.5.91, dự án / IndexedDB / localStorage còn nguyên) và qua **đóng cửa sổ** (cài im lặng khi tắt; lần mở sau báo "Đã cập nhật SanoVids lên 0.5.91."). Tải phần thay đổi (blockmap + Range) và tải cả file đều qua.
- **Bị từ chối**: ký bởi T2 (cả khi trùng đúng tên tác giả) → `other-signer`; không ký → `not-signed`; Setup bị sửa 1 byte sau khi ký, `latest.yml` (SHA-512, kích thước) và blockmap tính lại cho khớp → `hash-mismatch`, cả khi tải cả file lẫn tải phần thay đổi. Mỗi lần: file bị xoá, không bao giờ `ready`, không có tiến trình cài nào, app vẫn chạy, hiện thông báo lỗi; **Cài đặt → Cập nhật → Xem chi tiết** mở hộp cập nhật.
- **Không tải lại**: lần kiểm tra sau bỏ qua việc tự tải bản đã bị từ chối (không có lượt tải exe nào trên máy chủ); **Thử lại** tải lại và từ chối lại. Bộ cài bị từ chối được đặt sẵn vào bộ nhớ đệm của updater (electron-updater bỏ qua bước tải) → vẫn bị kiểm tra ở `update-downloaded`, bị xoá; tắt app ngay lúc đang kiểm tra → "install on quit skipped: installer not verified", không cài gì.
- **Tráo bộ cài sau khi xác minh**: tráo bằng file khác kích thước → không cài khi tắt. Một lần tráo **giữ nguyên kích thước và thời điểm sửa** thì lọt qua kiểm tra cũ (đường dẫn + kích thước + `mtime`) → đã sửa sau lần thử: bộ cài được gắn với SHA-512 và băm lại ngay trước khi cài.
- **Tự kiểm tra (Giới thiệu)**: ký T1 → `signed` sau 2–3 giây; ký T2 mang đúng tên tác giả → `other-signer`; không ký → `unsigned`; exe ký T1 bị sửa 1 byte → `tampered`; mỗi trạng thái hiện đúng (cả khối tác giả, đồng hành, bản quyền, giấy phép); ô tìm "chữ ký" thấy Giới thiệu.
- **Chống can thiệp** (không profile thử): `--remote-debugging-port` (cả dạng `-X`, `/X`, chữ hoa), `--remote-debugging-pipe`, `--inspect` → hộp báo tiếng Việt, thoát mã 3, không mở cổng, không tạo thư mục dữ liệu; với profile thử, `--inspect` / `--no-sandbox` / `--js-flags` vẫn bị từ chối. `ELECTRON_RUN_AS_NODE` và `NODE_OPTIONS=--inspect` vô tác dụng. Sửa 1 byte trong `electron/main.cjs` hay `dist/index.html` bên trong `app.asar` → thoát mã 1 ("ASAR Integrity Violation"); sửa header asar → lỗi toàn vẹn, không mở; thay `app.asar` bằng thư mục `resources\app` → thoát mã 1. Fuse đọc lại đúng.
- **Bản build ký bằng chứng chỉ thật** (số phiên bản 0.4.2, chỉ đọc, không cài): `buildInspect` 17/17 ✓; exe, `elevate.exe`, Setup, Portable, trình gỡ cài đặt ký đúng một chữ ký SHA-256 + dấu thời gian DigiCert; VersionInfo đúng; chạy thử với profile tạm: CSP đúng một mã băm, `eval` bị chặn, không lỗi console, Giới thiệu `signed` sau 2,7 giây. Icon trong exe / Setup / Portable / trình gỡ giống hệt `build/icon.ico`; ảnh bộ cài giống hệt `build/*.bmp`; trang giấy phép = `build/license_vi.txt`, hiển thị đúng dấu và xuống dòng với LF (bộ cài xem thử dựng bằng cùng makensis); khoá gỡ cài đặt (giải mã từ Setup) ghi Publisher = tác giả; `app-64.7z` trong Setup chứa đúng exe / `LICENSE.txt` / `app-update.yml` của `win-unpacked`.
- Mỗi lần thử tự kiểm toán: chỉ tắt tiến trình của mình (theo PID), gỡ bản cài thử, `%APPDATA%\SanoVids` không đổi (671 file), mọi kho chứng chỉ không đổi, chứng chỉ thử không nằm trong kho nào, `release/` không đổi. Chứng chỉ thật có sẵn cả ở `CurrentUser\My` lẫn bản công khai ở `CurrentUser\CA` từ trước khi thử ([SIGNING.md](SIGNING.md) mục 1).

**Thử lại khi tích hợp lần cuối (E2E, 03/10/2026, mã của bản 0.5.0)** — danh tính thử `SanoVidsUpdTest9` (appId `com.sanovids.updtest9`, nguồn `generic` tại `127.0.0.1:47419`, CDP 9419, profile nướng sẵn, cài im lặng vào thư mục tạm); chứng chỉ thử là file openssl, đã xoá: **A** được ghim thêm, **B** mang đúng tên `CN=Nguyễn Giang Minh (Jame Steven)`, không ghim.
- **Từ chối**: 0.5.92 ký bởi B → tải về, `other-signer`, file bị xoá, SHA-512 của nó lưu vào `updater.json` `rejected`, lỗi `signature` với câu mới (không bảo tải ở trang tải về); thông báo có nút **Xem** → hộp cập nhật: tiêu đề "Bản 0.5.92 bị chặn — …", **không** hiện ghi chú của bản bị chặn, khung hướng dẫn kiểm tra chữ ký có dấu vân tay chính thức, **Mở trang tải về** chỉ là nút phụ; kiểm tra lại → không tải lại ("auto-download skipped 0.5.92: this file was refused before").
- **Chấp nhận**: 0.5.91 ký bởi A → tải, chữ ký + VersionInfo (đúng `SanoVidsUpdTest9` 0.5.91, mới hơn) đúng, `ready` (thông báo lỗi cũ tự đóng) → **cài** → app tắt, cài im lặng, mở lại 0.5.91 (~14 giây), log "notice updated 0.5.90 -> 0.5.91", DisplayVersion 0.5.91, trình gỡ cài ký bởi A, `LICENSE.txt` / `THIRD-PARTY-NOTICES.txt` trong thư mục cài giống hệt repo, Publisher = tác giả. Mở lại qua CDP: tự kiểm tra `signed`, Giới thiệu "Phiên bản 0.5.91 · Bản cài", tác giả, đồng hành, bản quyền, dấu vân tay; ô tìm "chữ ký" thấy Giới thiệu.
- **Lỗi tìm ra và đã sửa**: lần chạy đầu, `pending\` vẫn còn bộ cài 0.5.91 sau khi cập nhật dù log ghi đã dọn — bộ cài vừa chạy còn giữ file và `DownloadedUpdateHelper.clear()` nuốt lỗi. Nay app liệt kê lại thư mục và thử lại sau 5 / 20 / 60 giây; lần chạy lại: lần 1 còn file → 5 giây sau trống.
- **Bản build ký bằng chứng chỉ thật** (0.4.2, `--publish never`, thư mục tạm, không cài): `buildInspect` 22/22 ✓ (Setup, Portable, exe, `elevate.exe` ký đúng chứng chỉ + dấu thời gian DigiCert; 4 DLL ký bởi tác giả; 2 DLL Microsoft giữ chữ ký Microsoft; không có file mã nào khác chưa ký; VersionInfo + ProductName / ProductVersion của Setup; fuse; mã toàn vẹn asar; `LICENSE.txt` + `THIRD-PARTY-NOTICES.txt`; `app-update.yml`); `app.asar` chứa đúng các `electron/*.cjs` hiện tại và mọi gói electron-updater cần, `package.json` bên trong đúng tác giả, chỉ một ghim, không có profile thử; icon trong exe / Setup / Portable và `dist/icons/icon.ico` giống hệt `build/icon.ico`. Chạy thử với profile tạm: cửa sổ mở sau ~1,6 giây, tự kiểm tra exe + 4 DLL ký bởi tác giả và 2 DLL Microsoft giữ chữ ký Microsoft; `--remote-debugging-port` bị từ chối (thoát mã 3, không mở cổng, không tạo profile) dù có `SANOVIDS_PROFILE_DIR`.
- Kiểm toán: chỉ tắt tiến trình của mình (theo PID), gỡ bản cài thử, không còn khoá gỡ cài đặt / thư mục dữ liệu / bộ nhớ đệm nào của `SanoVidsUpdTest9`; mọi kho chứng chỉ không đổi, chứng chỉ thử không nằm trong kho nào; `release/` không đổi; không bản thử nào chạy trên `%APPDATA%\SanoVids` (mọi bản build của nhánh này ghi `logs\updater.log` khi mở — thư mục thật không có file đó; các thay đổi trong đó là của SanoVids 0.4.2 người dùng đang mở).

**Chưa chạy E2E** (chỉ có test tự động / đọc mã): mã lỗi `signature-unverified`, từ chối bộ cài sai phiên bản (chống quay về bản cũ), file bị từ chối vẫn bị bỏ qua sau khi mở lại app, băm lại SHA-512 khi tráo bộ cài, tự kiểm tra báo `tampered` khi một DLL bị sửa, danh sách tham số bị từ chối mở rộng (`--gpu-launcher`, `--disable-features`…), `isPackagedApp` (exe đổi tên), xoá `SSLKEYLOGFILE`, "ghim trước, ký sau" của `release:check`; và trong bản đóng gói: tải `.exe` bị huỷ / `.mp4` được lưu, quyền vị trí / thông báo, `window.open('file:///…')`, F12 khi không có profile thử, sửa 1 byte trong một đoạn mã nạp muộn của `app.asar` (ví dụ `dist/assets/TakeViewer-*.js`: app mở bình thường, phải thoát mã 1 khi mở màn hình đó), cài thật bản ký bằng chứng chỉ thật (trang chào / giấy phép của chính Setup đó), cài cho mọi người dùng. Chạy lại các bài thử cập nhật và chống can thiệp trên bản build 0.5.0 trước khi phát hành.

## 5. Khi người dùng báo lỗi

| App báo | Nghĩa là | Làm gì |
|---|---|---|
| Chưa tìm thấy bản cập nhật nào trên trang tải về. | Repo công khai chưa có bản đã đăng / thiếu `latest.yml` / repo bị chuyển riêng tư | Kiểm tra trang tải về; chạy lại `release:publish` |
| Không kết nối được máy chủ cập nhật. | Mất mạng, tường lửa, proxy | App tự thử lại sau 30 phút |
| Máy chủ cập nhật đang bận. | GitHub giới hạn lượt (403 / 429) | Đợi; app tự thử lại |
| File cập nhật tải về bị lỗi (sai mã kiểm tra) nên đã bị bỏ. | File trên GitHub khác `latest.yml` (hoặc tải hỏng) | Kiểm tra bằng `release:check` / đăng bản mới hơn |
| Bản cập nhật này không mang chữ ký số đúng của tác giả hoặc không đúng phiên bản được báo (có thể là file giả mạo) nên SanoVids đã xoá nó, không cài gì. Đừng tự tải bản này về cài. Chỉ cài bộ cài có dấu vân tay chứng chỉ trùng với Cài đặt → Giới thiệu, hoặc hỏi tác giả. | Mã `signature`: bộ cài tải về không ký, ký bởi chứng chỉ chưa ghim (kể cả trùng tên), bị sửa sau khi ký, không đúng phiên bản / sản phẩm được báo, hoặc bị đổi sau khi xác minh. Lý do ở dòng `signature <lý do>` trong `updater.log`. Hiện một thông báo cho mỗi phiên bản; **Cài đặt → Cập nhật → Xem chi tiết** mở hộp cập nhật | Người dùng: đừng cài bản đó; so dấu vân tay với Giới thiệu trước khi tự cài bộ cài nào, hoặc hỏi tác giả. Tác giả: `release:check` nhóm (j); bản đã đăng sai thì đăng bản mới hơn, ký đúng ([SIGNING.md](SIGNING.md)); nếu chính bạn không đăng bản đó, coi như tài khoản GitHub bị chiếm |
| Chưa kiểm tra được chữ ký số của bản cập nhật (máy đang chặn việc kiểm tra hoặc kiểm tra quá lâu) nên SanoVids chưa cài bản này. Bấm “Thử lại” để kiểm tra lại. | Mã `signature-unverified`: PowerShell bị chính sách (AppLocker / WDAC) / diệt virus chặn, quá 60 s, chuỗi chứng chỉ lạ, hoặc app không có ghim | **Thử lại**; app tự thử lại mỗi ngày. Máy bị khoá chính sách thì nhờ quản trị cho phép PowerShell chạy bình thường |
| Ổ đĩa không đủ chỗ để tải bản cập nhật. | Ổ C đầy | Dọn ổ đĩa |
| Không khởi động được trình cài bản cập nhật. | Bộ cài không chạy được khi bấm **Khởi động lại để cập nhật** | Tắt hẳn app (bản mới tự cài khi tắt); hoặc tải Setup ở trang tải về, so dấu vân tay, cài đè |
| Chưa cài được bản x. SanoVids sẽ thử lại khi bạn tắt app. | Bộ cài không chạy được (diệt virus, quyền ghi) | Tắt hẳn app; hoặc tải Setup ở trang tải về cài đè |

Nhật ký chi tiết: `%APPDATA%\SanoVids\logs\updater.log`.
