# Sano Agent — trang tải về chính thức

**Sano Agent** là app SANO trên máy tính Windows. Từ bản 1.0, **SanoVids đã gộp vào Sano Agent**: khu **Canvas** của SANO trong app là chính SanoVids, tạo video thật bằng tài khoản canvasapp.io.vn của bạn, và **dùng chung dự án với SanoVids** đã cài trên máy.

**Tác giả:** Nguyễn Giang Minh (Jame Steven) · **Đồng hành:** Sano Group

**[Tải bản mới nhất](https://github.com/JameSteven404/sano-agent-releases/releases/latest)** · [Tất cả phiên bản và ghi chú thay đổi](https://github.com/JameSteven404/sano-agent-releases/releases)

Repo này chỉ chứa **bản cài đặt** và **tệp cập nhật** của Sano Agent, không chứa mã nguồn. Ai có đường link đều tải được, nhưng **chỉ người được tác giả cho phép mới được cài và dùng** (xem [Giấy phép](#giấy-phép)).

---

## Tải về: Setup hay Portable?

| File (trong mục **Assets** của mỗi bản) | Dùng khi | Tự cập nhật |
|---|---|---|
| `SanoAgent-Setup-x.y.z.exe` | Cài vào máy, có lối tắt ở Start và Desktop. **Nên dùng.** | **Có**: tải trong nền, cài khi khởi động lại hoặc khi tắt app |
| `SanoAgent-Portable-x.y.z.exe` | Chạy thẳng, không cần cài | Không: chỉ báo có bản mới, bạn tự tải ở đây |
| `latest.yml`, `*.blockmap` | Dành cho trình tự cập nhật của app | Không cần tải |
| `SanoVids-NguyenGiangMinh.cer` | Chứng chỉ công khai để kiểm tra / tin cậy chữ ký số (cùng chứng chỉ với SanoVids) | — |

Cần **Windows 10 hoặc 11, 64-bit**. Không cần Docker hay máy chủ SANO: trang SANO có sẵn trong app.

### Trước khi cài

- **Dùng chung dữ liệu với SanoVids.** Sano Agent mở đúng thư mục dữ liệu của SanoVids (`%APPDATA%\SanoVids`): cùng dự án, cùng đăng nhập canvasapp. Trước lần mở đầu, đóng SanoVids và chép thư mục đó ra chỗ khác để sao lưu.
- **Không mở cùng lúc** SanoVids và Sano Agent: mở app thứ hai thì nó tự thoát và đưa cửa sổ app đang mở lên trước.
- **Cài vào thư mục riêng.** Đừng chọn thư mục cài của SanoVids: Sano Agent sẽ nằm bên trong thư mục đó, và lần cập nhật hay gỡ cài tiếp theo của SanoVids có thể xoá mất nó. Thư mục mặc định (`%LOCALAPPDATA%\Programs\Sano Agent`) là đúng.
- Bộ cài hỏi ngôn ngữ, hiện **Giấy phép sử dụng** và cho chọn thư mục cài. Windows SmartScreen hỏi như với bộ cài SanoVids: bấm **Thông tin khác** (*More info*), xem **Nhà phát hành**, rồi **Vẫn chạy** (*Run anyway*) — chỉ sau khi đã [kiểm tra chữ ký số](#kiểm-tra-chữ-ký-số).

---

## Tự cập nhật

- Bản **Setup** tự kiểm tra bản mới ở trang này, tải trong nền và cài khi khởi động lại hoặc khi tắt app, như SanoVids. Tự cập nhật chạy cả khi bạn không vào Canvas.
- **Mỗi bản cập nhật được kiểm tra chữ ký số trước khi cài**: chỉ file ký bằng chứng chỉ của tác giả và đúng là Sano Agent phiên bản mới mới được cài. Bộ cài SanoVids không bao giờ được cài thay Sano Agent, và ngược lại.
- Bản **Portable** chỉ báo có bản mới.
- Cập nhật bị lỗi: gửi cho tác giả file `%APPDATA%\SanoVids\logs\updater-sano-agent.log`.

---

## Kiểm tra chữ ký số

Bản cài chính thức (cả Setup lẫn Portable) **luôn** được ký số bởi **Nguyễn Giang Minh (Jame Steven)**, dấu vân tay chứng chỉ (SHA-1) **`7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`** — cùng chứng chỉ với SanoVids. File không mang đúng chữ ký này **không phải bản gốc**: đừng chạy, hãy xoá và báo tác giả.

> **So dấu vân tay với một nguồn khác trang này.** Trang tải về, file cài và chứng chỉ cùng nằm trên một tài khoản GitHub: ai chiếm được tài khoản đó thay được cả file lẫn dấu vân tay in ở đây. Hãy đối chiếu với dấu vân tay tác giả gửi trực tiếp, hoặc dòng dấu vân tay trong **Cài đặt → Giới thiệu** của một SanoVids đã cài từ trước.

Cách kiểm tra (chuột phải → **Properties** → **Digital Signatures**, hoặc PowerShell `Get-AuthenticodeSignature`) và cách tin cậy chứng chỉ trên máy nội bộ giống hệt SanoVids: xem [trang tải về của SanoVids](https://github.com/JameSteven404/sanovids-releases#kiểm-tra-chữ-ký-số). Script [`tin-cay-chung-chi.ps1`](tin-cay-chung-chi.ps1) trong repo này là cùng một script.

---

## Giấy phép

Sano Agent là phần mềm **thuộc quyền sở hữu của tác giả Nguyễn Giang Minh (Jame Steven)** (đồng hành: Sano Group), dùng cùng giấy phép với SanoVids: chỉ cài và dùng khi được tác giả cho phép; không sao chép, chỉnh sửa, dịch ngược, phân phối lại khi chưa có đồng ý bằng văn bản của tác giả; cung cấp "nguyên trạng". Các thành phần mã nguồn mở (Electron, Chromium, React…) theo giấy phép riêng, kèm trong thư mục cài đặt (`LICENSE.electron.txt`, `LICENSES.chromium.html`, `THIRD-PARTY-NOTICES.txt`).

Toàn văn: [LICENSE.txt](LICENSE.txt). Bộ cài cũng hiện toàn văn giấy phép trước khi cài.

---

## Các file trong repo này

| File | Là gì |
|---|---|
| `README.md` | Trang này |
| `LICENSE.txt` | Giấy phép sử dụng |
| `SanoVids-NguyenGiangMinh.cer` | Chứng chỉ ký số **công khai** của tác giả (không chứa khoá bí mật) |
| `tin-cay-chung-chi.ps1` | Script tin cậy / bỏ tin cậy chứng chỉ trên máy Windows |

Bản cài của từng phiên bản nằm ở mục [Releases](https://github.com/JameSteven404/sano-agent-releases/releases).

---

© 2026 Nguyễn Giang Minh (Jame Steven) · Đồng hành: Sano Group
