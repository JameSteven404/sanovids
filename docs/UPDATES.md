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
   - **kiểm tra chữ ký số** (`electron/signature.cjs`, bảng quyết định trong `updater-rules.cjs`): phải ký bởi một dấu vân tay trong `sanovids.signers`. Sai (không ký, người ký khác kể cả trùng tên, file bị sửa, không kiểm tra được) → **xoá file**, không cài, lỗi `signature`; phiên bản đó không được tự tải lại trong lần chạy này (bấm **Thử lại** vẫn được). Bộ kiểm tra gắn cả vào `verifyUpdateCodeSignature` lẫn ghi đè `verifySignature` của updater, nên `app-update.yml` thiếu `publisherName` cũng không bỏ qua được.
4. Xong → **kiểm tra chữ ký lần nữa** rồi mới tới trạng thái `ready`. **Khởi động lại để cập nhật** = kiểm tra chữ ký lần thứ ba rồi `quitAndInstall(silent, relaunch)`; tắt app khi đang `ready` = `autoInstallOnAppQuit` (cài im lặng, không tự mở lại) — chỉ khi bộ cài vẫn đúng là file đã xác minh (đường dẫn, kích thước, thời điểm sửa), khác thì bỏ qua lần cài khi tắt.

**Lịch**: lần đầu 15 giây sau khi cửa sổ hiện; sau đó cứ 10 phút xem đã tới hạn chưa (4 giờ sau lần thử trước, 30 phút nếu lần trước mất mạng / GitHub giới hạn), và khi máy thức dậy. Kiểm tra tự động **không bao giờ** hiện hộp thoại hay thông báo; chỉ **Kiểm tra ngay** mới báo kết quả.

**Loại bản** (`updater-rules.detectKind`): chưa đóng gói → `dev`; có biến `PORTABLE_EXECUTABLE_FILE` → `portable`; cạnh file exe có `Uninstall SanoVids.exe` → `installer`; còn lại → `portable` (chỉ kiểm tra).

**Trước khi khởi động lại** (renderer, `updateActions.installNow`): giữ không gửi video mới → đợi video đang gửi gửi xong (tối đa 15 s) → lưu chữ đang gõ trong ô prompt → lưu dự án (autosave) → `updates:install`. Không bao giờ khởi động lại khi hộp **Nhập prompt** đang mở (chữ dán vào chỉ nằm trong hộp đó). Main ghi `attempt` vào `updater.json` (khi tắt app: trong sự kiện `quit`, cùng lúc và cùng điều kiện mã thoát 0 với electron-updater, nên một lần tắt bị cửa sổ khác chặn không để lại `attempt`); lần mở sau so phiên bản để báo **"Đã cập nhật SanoVids lên …"** hoặc **"Chưa cài được bản …"**. Mở lại trong vòng 2 phút sau khi tắt (bộ cài có thể vẫn đang chạy, ~15 s) thì không báo gì và giữ `attempt` cho lần mở sau. Nếu 18 giây sau `quitAndInstall` app vẫn còn chạy, main báo cài thất bại và trả trình cập nhật về trạng thái dùng được (cài lại / cài khi tắt). "Cập nhật khi xong" đợi hàng đợi (trừ video của cảnh đã xoá — chúng không bao giờ chạy và vẫn còn sau khi khởi động lại), video chờ lưu vào thư mục, lượt nạp credit và hộp **Nhập prompt** rảnh hết, đếm ngược 5 giây (huỷ được) rồi mới cài.

**Kiểm tra lại khi đã biết có bản mới** không làm mất bản đó: trạng thái `available` giữ nguyên trong lúc kiểm tra (nút trên thanh không nháy) và một lần kiểm tra lỗi (mất mạng…) không xoá nó. GitHub giới hạn lượt / lỗi 5xx ở bước `releases/latest` (electron-updater gói chung thành "không tìm thấy bản") được nhận ra từ mã HTTP thật: 403 / 429 → **Máy chủ cập nhật đang bận** (thử lại sau 30 phút).

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
| `scripts/buildInspect.mjs` | Đọc lại một bản build Windows: chữ ký + dấu thời gian từng file, thông tin phiên bản, fuse, `app-update.yml` (nhóm kiểm tra **(j)**, dùng lại trong bài E2E). Test: `scripts/__tests__/buildInspect.test.mjs` |

### Dữ liệu trên máy người dùng

| Ở đâu | Là gì |
|---|---|
| `%APPDATA%\SanoVids\updater.json` | `{ v: 1, autoDownload, attempt? }` — bản sao cài đặt cho main + lần cài đang chờ |
| `%APPDATA%\SanoVids\logs\updater.log` | Nhật ký trình cập nhật (quá 256 KB thì chuyển sang `updater.1.log`) — xin file này khi người dùng báo lỗi |
| `%APPDATA%\SanoVids\.updaterId` | Mã cài đặt ngẫu nhiên của electron-updater, gửi kèm mỗi lần kiểm tra (`x-user-staging-id`) |
| `%LOCALAPPDATA%\sanovids-updater\` | Bản cài đã tải / đang tải, bản sao bộ cài hiện tại (để tải phần thay đổi) |
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
4. `npm run dist:win` — **sau** khi tag (kiểm tra đòi ngày build mới hơn commit), **có mạng** (dấu thời gian của chữ ký). Lệnh này tự chạy `update-notes`, build qua `scripts/electron-build.mjs` với `--publish never` (electron-builder không tự đăng gì), **ký số** mọi file `.exe` bằng khoá trên máy (thiếu khoá là build dừng) và `tidy-release`.
5. `npm run release:check` — chỉ đọc, không đăng: in danh sách ✓ / ⚠ / ✗ và **đúng các lệnh `gh` sẽ chạy**. Phải hết ✗.
6. `npm run release:publish` — chạy lại toàn bộ kiểm tra rồi:
   1. repo riêng `sanovids`: tạo **bản nháp** (`--verify-tag`), tải Setup + Portable + `SanoVids-NguyenGiangMinh.cer` lên;
   2. repo công khai `sanovids-releases`: tạo **bản nháp** (`--target main`), tải Setup, `.blockmap`, `latest.yml`, Portable, `SanoVids-NguyenGiangMinh.cer` lên;
   3. đọc lại từ GitHub: đủ file, đúng kích thước, đúng **SHA-256** (không có mã thì tải về tính lại);
   4. đăng bản riêng, rồi **cuối cùng** mới đăng bản công khai (`--draft=false --prerelease=false --latest`) — từ giây này máy người dùng thấy bản mới;
   5. kiểm tra như một máy lạ (không đăng nhập): `/releases/latest` = tag mới, `latest.yml` tải về giống hệt file trên máy, `releases.atom` có tag mới (5 lần, cách 10 giây).
7. Mở trang tải về xem lại bằng mắt. Máy đã cài bản Setup sẽ nhận bản mới trong vòng vài giờ.

**`release:check` kiểm tra gì**: (a) mục CHANGELOG (thiếu dòng liên kết chỉ ⚠); (b) git sạch, tag `vX.Y.Z` = HEAD = tag trên GitHub, HEAD nằm trong `origin/main` (bản xem trước không `git fetch` nên báo ⚠ thông tin có thể cũ; không ở `main` cũng ⚠); (c) đủ 4 file trong `release/` và `release/_build/`; (d) `latest.yml` khớp file Setup (phiên bản, đường dẫn, SHA-512, kích thước, ngày build ≥ ngày commit; thiếu ghi chú chỉ ⚠); (e) blockmap giải nén được; (f) **`app-update.yml` trỏ đúng `github / JameSteven404 / sanovids-releases`, CÓ `publisherName` đúng bằng `Nguyễn Giang Minh (Jame Steven)` (thiếu = app không kiểm tra chữ ký của bản cập nhật), không token / private / channel — lỗi này luôn chặn**; (g) `app.asar` có `electron/main.cjs`, `preload.cjs`, `updater.cjs`, `updater-rules.cjs`, `signature.cjs`, `hardening-rules.cjs`, `electron-updater` **và mọi gói nó cần khi chạy** (đọc `dependencies` lần lượt theo cách Node tìm gói: `builder-util-runtime`, `js-yaml`, `semver`, `fs-extra`…), và `package.json` bên trong là `sanovids / SanoVids / X.Y.Z`, tác giả `Nguyễn Giang Minh (Jame Steven)`, `sanovids.signers` đúng như trong repo (bản build thử có ghim thêm bị chặn), không có `sanovidsTestProfileDir`; (h) `package.json` `build.publish` đúng, không có script tên `release`; (i) `gh` đã đăng nhập, repo công khai tồn tại, công khai, có nhánh, và chưa có bản nào mới hơn; (j) **Chữ ký số — luôn chặn** (`scripts/buildInspect.mjs`): Setup, Portable, `SanoVids.exe`, `elevate.exe` ký bởi một dấu vân tay trong `sanovids.signers` **và có dấu thời gian**; `ffmpeg.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`, `dxcompiler.dll` ký bởi tác giả, `d3dcompiler_47.dll` / `dxil.dll` giữ chữ ký Microsoft; CompanyName = tác giả, LegalCopyright = `© 2026 Nguyễn Giang Minh (Jame Steven) · Đồng hành: Sano Group`; fuse đúng; không có `app.asar.unpacked`; `publisherName` trong `app-update.yml` đúng UTF-8 (không có `?`); file `build/signing/SanoVids-NguyenGiangMinh.cer` khớp ghim (file này được băm SHA-256 và tải lên cùng các file khác). Thêm nhóm ⚠ **Repo công khai**: `scripts/releases-repo/` đủ `README.md`, `LICENSE.txt` (giống hệt `LICENSE.txt` gốc), `.cer` (giống hệt `build/signing/`) và `tin-cay-chung-chi.ps1`. Có biến `ELECTRON_BUILDER_OFFLINE` trong môi trường → chặn.

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
- Mọi file `.exe` được **ký số** bởi Nguyễn Giang Minh (Jame Steven) (SHA-256, dấu thời gian DigiCert). App chỉ nhận bản cập nhật ký bởi một dấu vân tay ghim trong app (`sanovids.signers`, nằm trong `app.asar` được bảo vệ toàn vẹn), kiểm tra ngay sau khi tải, trước khi báo sẵn sàng và trước mỗi lần cài; cộng thêm HTTPS của GitHub và SHA-512 trong `latest.yml`. Chiếm được tài khoản GitHub thôi chưa đủ để đẩy bản cập nhật độc: còn cần khoá ký, thứ không bao giờ rời máy tác giả. Vẫn giữ 2FA, không chia sẻ token. Chi tiết: [SIGNING.md](SIGNING.md).
- Nguồn cập nhật cố định trong app; trang (renderer) chỉ xin main kiểm tra / tải / cài / mở trang tải về cố định. Main chỉ nhận lệnh từ `app://bdp/`, bỏ qua mọi tham số trừ `setPrefs({ autoDownload: boolean })`.
- Ghi chú phát hành chỉ hiện dạng **chữ** (không HTML). Lỗi hiện bằng câu tiếng Việt cố định, không bao giờ hiện thông báo lỗi gốc.
- Mỗi lần kiểm tra GitHub nhận IP và mã cài đặt ngẫu nhiên `x-user-staging-id`; không có gì từ dự án. electron-updater đọc thẳng github.com (không qua API nên ít bị giới hạn lượt), và app chỉ kiểm tra 4 giờ một lần.

## 4. Thử nghiệm

**Tự động**: `npm test` gồm `src/lib/__tests__/updaterRules.test.ts` (quy tắc main + cấu hình `package.json`), `signature.test.ts` (bảng quyết định chữ ký số, script PowerShell, tiến trình giả), `buildConfig.test.ts` (tác giả, ký số, fuse, bộ cài, giấy phép), `hardeningRules.test.ts` (tham số bị từ chối, tải về, quyền, CSP), test renderer (`updateModel`, `updatePrefs`, `updates`, `updateActions`, giả lập `dev-updates`, `settings`, `devModel`, `aboutModel`, `appSignature`) và `scripts/__tests__/releaseLib.test.mjs` + `buildInspect.test.mjs` (CHANGELOG, ghi chú, latest.yml, app-update.yml, asar, chữ ký, fuse, kế hoạch đăng bản).

**Giao diện**: `npm run dev` → Bảng phát triển → tab **Cập nhật** giả lập mọi trạng thái (bản cài / portable / phát triển, có bản mới, đang tải, đã tải xong, lỗi mạng, chưa có bản phát hành, **lỗi chữ ký số**) và mọi trạng thái chữ ký của khối **Giới thiệu** — không tải gì, không gọi mạng.

**Cách ly khi thử bản đóng gói** (bắt buộc với mọi lần chạy thử, nhất là khi agent chạy):
- Biến môi trường `SANOVIDS_PROFILE_DIR=<thư mục tạm>` chuyển dữ liệu app (userData) ra khỏi `%APPDATA%\SanoVids`. Bản build thử có thể "nướng" sẵn đường dẫn bằng `extraMetadata.sanovidsTestProfileDir` (vì bộ cài NSIS khởi động lại app **không** giữ biến môi trường). Khoá này **không bao giờ** có trong `package.json` thật.
- Đường dẫn phải tuyệt đối, ≤ 240 ký tự, không phải gốc ổ đĩa, không trùng / không nằm trong / không chứa `%APPDATA%\SanoVids`. Các bí danh Windows của thư mục đó cũng bị chặn: đường dẫn UNC / `\\?\` / `\\.\`, tên thư mục kết thúc bằng dấu chấm hay dấu cách, tên ngắn 8.3 (có `~`), luồng dữ liệu (`:` sau ký tự ổ đĩa), và (qua `realpath`) junction / symlink trỏ vào đó. Sai → app thoát với mã 2, không mở cửa sổ.
- **Không bao giờ chạy `electron .` hay bản đóng gói mà thiếu biến này** khi thử (dữ liệu thật của người dùng nằm ở `%APPDATA%\SanoVids`). Bộ cài thử phải có `appId` / `productName` / `executableName` riêng (vd. `com.sanovids.updtest` / `SanoVidsUpdTest`), cài vào thư mục tạm (`/S /D=…`), build với `--publish never` vào thư mục ra tạm, không bao giờ vào `release/`. Không đụng tới tiến trình SanoVids đang chạy của người dùng.

**Thử đầu-cuối (E2E)** — chạy bằng script trong thư mục tạm, không nằm trong repo:
- Build 3 bản cài thử `SanoVidsUpdTest` 0.5.90 → 0.5.91 → 0.5.92 (+ một bản portable), nguồn cập nhật `generic` tại `http://127.0.0.1:47391/` do một máy chủ Node nhỏ phục vụ (hỗ trợ Range).
- Cài A im lặng vào thư mục tạm, mở qua cổng gỡ lỗi (CDP) với profile tạm. Kiểm tra: `kind=installer`, các hàm `bdpDesktop.updates`, tham số sai bị từ chối.
- A→B: file Setup bị sửa 1 byte → lỗi `checksum`, không cài gì; file đúng → tải phần thay đổi (log máy chủ có cả hai blockmap và Range), nút trên thanh hiện 0.5.91, ghi chú hiện dạng chữ (`<b>` không thành thẻ); bấm **Khởi động lại để cập nhật** → app tắt, cài, mở lại 0.5.91, dữ liệu IndexedDB còn nguyên, thông báo "Đã cập nhật" hiện một lần.
- B→C: tắt tự tải → chỉ báo có bản mới, không tải; tải tay → `ready`; đóng cửa sổ → cài im lặng khi tắt, không tự mở lại; mở lại thấy 0.5.92.
- Portable: chỉ báo, `download` / `install` bị từ chối; bản chạy từ mã nguồn: `unsupported`; đường dẫn profile sai: thoát mã 2.
- Dọn dẹp: chỉ tắt tiến trình do bài thử mở (theo PID), gỡ bản cài thử bằng uninstaller của nó, xoá thư mục tạm; kiểm tra lại SanoVids thật của người dùng vẫn chạy và `%APPDATA%\SanoVids` không bị đụng.

**Thử chữ ký số (E2E, 0.5.0)** — cũng bằng script trong thư mục tạm. Chứng chỉ thử là **file** tạo bằng openssl (không bao giờ nhập vào kho chứng chỉ của Windows, xoá khi xong): **A** (`CN=SanoVids Thử Nghiệm A`, được ghim thêm trong bản thử qua `extraMetadata.sanovids.signers`; electron-builder **gộp** mảng nên bản thử ghim `[thật, A]`) và **B** (kẻ giả mang **đúng tên** `CN=Nguyễn Giang Minh (Jame Steven)`, không ghim). Năm danh tính thử `SanoVidsSigT1…T5`, mỗi cái có appId / productName / executableName riêng, thư mục ra / cài / profile tạm:
- **T1 — cấu hình phát hành thật** (ký bằng chứng chỉ thật): `buildInspect` toàn ✓ (Setup, Portable, exe, `elevate.exe`, uninstaller, 4 DLL ký + dấu thời gian; DLL Microsoft giữ nguyên; CompanyName / Publisher có đủ "(Jame Steven)"; fuse; `publisherName` UTF-8); cài im lặng; chụp trang chào / giấy phép (dấu tiếng Việt, xuống dòng) / trang trong của bộ cài; app báo `signed`, khối Giới thiệu hiện đúng tác giả, đồng hành, bản quyền, phiên bản, dấu vân tay; Portable cũng `signed`.
- **T2 — ghim khi cập nhật** (feed nội bộ `127.0.0.1`): bản ký bởi B → từ chối `other-signer` và không tải lại lần hai; bản không ký → `not-signed`; bản ký A bị sửa 1 byte (SHA-512 tính lại cho khớp) → `hash-mismatch`; xoá `publisherName` khỏi `app-update.yml` rồi tải tay bản B → vẫn từ chối; bản A đúng → `ready`, rồi tráo bộ cài đã tải bằng bản B → `install()` trả lỗi `signature`, app không tắt; bản A đúng → cài và mở lại bản mới (cả đường cài khi tắt app).
- **T3 — không profile thử**: tham số gỡ lỗi (cả dạng `-X`, `/X`, chữ hoa) bị từ chối, thoát mã 3, không mở cổng, không tạo thư mục dữ liệu; `ELECTRON_RUN_AS_NODE` và `NODE_OPTIONS=--inspect` vô tác dụng; F12 / Ctrl+Shift+I không mở DevTools; `app.asar` sửa 1 byte (dữ liệu hoặc header) hay bị thay bằng thư mục `resources\app` → app không mở.
- **T4 — tự kiểm tra**: ký A → `signed`; exe ký A bị sửa 1 byte → `tampered`; ký B (trùng tên tác giả) → `other-signer` (tên thôi không bao giờ đủ); không ký → `unsigned`; mỗi trạng thái hiện đúng trong Giới thiệu, có kết quả trong vòng 15 giây.
- **T5 — trang trong app**: header CSP có đúng một mã băm, không vi phạm CSP nào khi đi qua mọi màn hình và chạy một video DEV; `eval` bị chặn; tải `.exe` bị huỷ, `.mp4` được lưu; quyền vị trí / thông báo bị từ chối; `window.open('file:///…')` không mở gì.
- Kiểm toán cuối: mọi tiến trình thử đã tắt (tiến trình SanoVids của người dùng còn nguyên), `%APPDATA%\SanoVids` không đổi, không còn bản cài / thư mục thử, kho chứng chỉ Windows không có chứng chỉ thử, chứng chỉ thật vẫn chỉ ở `CurrentUser\My`, `release/` không bị đụng.

## 5. Khi người dùng báo lỗi

| App báo | Nghĩa là | Làm gì |
|---|---|---|
| Chưa tìm thấy bản cập nhật nào trên trang tải về. | Repo công khai chưa có bản đã đăng / thiếu `latest.yml` / repo bị chuyển riêng tư | Kiểm tra trang tải về; chạy lại `release:publish` |
| Không kết nối được máy chủ cập nhật. | Mất mạng, tường lửa, proxy | App tự thử lại sau 30 phút |
| Máy chủ cập nhật đang bận. | GitHub giới hạn lượt (403 / 429) | Đợi; app tự thử lại |
| File cập nhật tải về bị lỗi (sai mã kiểm tra) nên đã bị bỏ. | File trên GitHub khác `latest.yml` (hoặc tải hỏng) | Kiểm tra bằng `release:check` / đăng bản mới hơn |
| Không xác minh được chữ ký số của tác giả trên bản cập nhật nên SanoVids đã bỏ file đó, không cài. Hãy tải bộ cài ở trang tải về rồi cài đè lên bản đang dùng. | Bộ cài tải về không ký, ký bởi chứng chỉ chưa ghim (kể cả trùng tên), bị sửa sau khi ký, hoặc không kiểm tra được (PowerShell bị chặn / quá 60 s). Lý do ở dòng `signature <lý do>` trong `updater.log` | Người dùng: nút **Mở trang tải về**, kiểm tra chữ ký rồi cài đè. Tác giả: `release:check` nhóm (j); bản đã đăng sai thì đăng bản mới hơn, ký đúng ([SIGNING.md](SIGNING.md)) |
| Ổ đĩa không đủ chỗ để tải bản cập nhật. | Ổ C đầy | Dọn ổ đĩa |
| Chưa cài được bản x. SanoVids sẽ thử lại khi bạn tắt app. | Bộ cài không chạy được (diệt virus, quyền ghi) | Tắt hẳn app; hoặc tải Setup ở trang tải về cài đè |

Nhật ký chi tiết: `%APPDATA%\SanoVids\logs\updater.log`.
