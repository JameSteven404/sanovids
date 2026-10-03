# SanoVids — trang tải về chính thức

**SanoVids** là ứng dụng Windows để làm phim AI theo từng cảnh trên một canvas: quản lý nhân vật, nối ảnh tham chiếu vào cảnh, viết prompt với `@image_1`, `@video_1`, chạy tạo video hàng loạt, rồi lấy video vừa tạo để nối tiếp sang cảnh sau.

**Tác giả:** Nguyễn Giang Minh (Jame Steven) · **Đồng hành:** Sano Group

**[Tải bản mới nhất](https://github.com/JameSteven404/sanovids-releases/releases/latest)** · [Tất cả phiên bản và ghi chú thay đổi](https://github.com/JameSteven404/sanovids-releases/releases)

Repo này chỉ chứa **bản cài đặt** và **tệp cập nhật** của SanoVids, không chứa mã nguồn. Ai có đường link đều tải được, nhưng **chỉ người được tác giả cho phép mới được cài và dùng** (xem [Giấy phép](#giấy-phép)).

---

## Tải về: Setup hay Portable?

| File (trong mục **Assets** của mỗi bản) | Dùng khi | Tự cập nhật |
|---|---|---|
| `SanoVids-Setup-x.y.z.exe` | Cài vào máy, có lối tắt ở Start và Desktop. **Nên dùng.** | **Có**: tải trong nền, cài khi khởi động lại hoặc khi tắt app |
| `SanoVids-Portable-x.y.z.exe` | Chạy thẳng, không cần cài (USB, máy không được cài phần mềm) | Không: chỉ báo có bản mới, bạn tự tải ở đây |
| `latest.yml`, `*.blockmap` | Dành cho trình tự cập nhật của app | Không cần tải |
| `SanoVids-NguyenGiangMinh.cer` | Chứng chỉ công khai để kiểm tra / tin cậy chữ ký số | — |

Cần **Windows 10 hoặc 11, 64-bit**. Dự án được lưu trên máy của bạn; cập nhật không làm mất dự án.

### Cài đặt

1. Tải `SanoVids-Setup-x.y.z.exe` và [kiểm tra chữ ký số](#kiểm-tra-chữ-ký-số) của file.
2. Chạy file. Windows SmartScreen có thể hiện **"Windows đã bảo vệ PC của bạn"** (*Windows protected your PC*) vì bản cài mới còn ít người tải: bấm **Thông tin khác** (*More info*), xem dòng **Nhà phát hành** rồi bấm **Vẫn chạy** (*Run anyway*).
   - Máy đã [tin cậy chứng chỉ](#tin-cậy-chứng-chỉ-trên-máy-nội-bộ-tuỳ-chọn): Nhà phát hành là **Nguyễn Giang Minh (Jame Steven)**.
   - Máy chưa tin cậy: Windows ghi *Không xác định* (*Unknown publisher*). Khi đó chỉ chạy sau khi đã kiểm tra chữ ký số như hướng dẫn bên dưới.
3. Bộ cài hỏi ngôn ngữ, hiện **Giấy phép sử dụng** (bấm **Tôi đồng ý** để tiếp tục), cho chọn cài **chỉ cho bạn** hay **cho mọi người dùng** (cần quyền quản trị) và thư mục cài.

---

## Tự cập nhật

- Bản **Setup** tự kiểm tra bản mới (lần đầu khoảng 15 giây sau khi mở, sau đó khoảng 4 giờ một lần), tải trong nền, rồi hiện nút **Khởi động lại để cập nhật** trên thanh trên cùng. Không bấm thì bản mới được cài lúc bạn tắt app. Kiểm tra tay: **Cài đặt → Cập nhật → Kiểm tra ngay**.
- **Mỗi bản cập nhật được kiểm tra chữ ký số trước khi cài**: app chỉ nhận file được ký bằng chứng chỉ của tác giả (dấu vân tay ghim sẵn trong app). File sai chữ ký hoặc đã bị sửa bị từ chối, app báo lỗi và mời bạn tải bản mới bằng tay ở trang này.
- Bản **0.4.2 trở về trước** chưa có tự cập nhật: tải và cài bản Setup mới **một lần** (cài đè lên bản cũ, dự án vẫn còn). Từ đó về sau app tự cập nhật.
- Bản **Portable** chỉ báo có bản mới; tải bản mới ở đây rồi thay file cũ.
- Cập nhật bị lỗi: gửi cho tác giả file `%APPDATA%\SanoVids\logs\updater.log`.

---

## Kiểm tra chữ ký số

Bản cài chính thức (cả Setup lẫn Portable) **luôn** được ký số bởi:

| | |
|---|---|
| Người ký | **Nguyễn Giang Minh (Jame Steven)** (`CN=Nguyễn Giang Minh (Jame Steven), C=VN`) |
| Dấu vân tay chứng chỉ (SHA-1) | **`7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`** |
| Hiệu lực | 03/10/2026 → 03/10/2036 |

File không mang đúng chữ ký này **không phải bản gốc**: đừng chạy, hãy xoá và báo tác giả.

**Cách 1: chuột phải** vào file `.exe` → **Properties** (*Thuộc tính*) → tab **Digital Signatures** (*Chữ ký số*) → chọn dòng **Nguyễn Giang Minh (Jame Steven)** → **Details** → **View Certificate** → tab **Details** → dòng **Thumbprint** phải đúng `7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`.
- Không có tab Chữ ký số: file chưa được ký → không phải bản chính thức.
- Máy chưa tin cậy chứng chỉ thì Windows ghi chứng chỉ "không xác minh được tới một tổ chức cấp chứng chỉ tin cậy". Điều này bình thường với chứng chỉ tự ký; điều quan trọng là **Thumbprint phải khớp**.

**Cách 2: PowerShell** (mở PowerShell trong thư mục chứa file):

```powershell
$s = Get-AuthenticodeSignature .\SanoVids-Setup-0.5.0.exe
$s.Status
$s.SignerCertificate.Thumbprint
$s.TimeStamperCertificate.Subject
```

| `Status` | Ý nghĩa |
|---|---|
| `Valid` | Chữ ký còn nguyên và máy đã tin cậy chứng chỉ. Thumbprint đúng là bản gốc. |
| `UnknownError` (kèm câu *"…terminated in a root certificate which is not trusted…"*) | Chữ ký **còn nguyên**, chỉ là máy chưa tin cậy chứng chỉ tự ký (bình thường). Thumbprint đúng là bản gốc. |
| `HashMismatch` | File đã bị sửa sau khi ký. **Xoá, không chạy.** |
| `NotSigned` | Không có chữ ký. Không phải bản chính thức. |
| Thumbprint khác | Ký bởi người khác. Không phải bản chính thức. |

Dòng thứ ba có nội dung (ví dụ `CN=DigiCert …`) nghĩa là chữ ký có **dấu thời gian**: chữ ký vẫn hợp lệ cả sau khi chứng chỉ hết hạn.

Kiểm tra file chứng chỉ `SanoVids-NguyenGiangMinh.cer`: bấm đúp → tab **Details** → **Thumbprint**, hoặc `(Get-PfxCertificate .\SanoVids-NguyenGiangMinh.cer).Thumbprint`.

---

## Tin cậy chứng chỉ trên máy nội bộ (tuỳ chọn)

SanoVids được ký bằng **chứng chỉ tự ký** của tác giả (không mua từ một tổ chức cấp chứng chỉ công cộng), nên Windows chưa biết chứng chỉ này: bộ cài hiện *Nhà phát hành không xác định*, trạng thái chữ ký là `UnknownError`. Máy trong nhóm nội bộ có thể **tin cậy chứng chỉ một lần** để Windows hiện đúng tên tác giả và chữ ký ở trạng thái `Valid`.

- **Không bắt buộc**: SanoVids vẫn chạy và tự cập nhật bình thường khi chưa tin cậy.
- **Chỉ làm khi** bạn ở trong nhóm được tác giả cho phép, và dấu vân tay khớp **đúng** `7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED`. Tin cậy một chứng chỉ gốc nghĩa là Windows tin mọi thứ được ký bằng chứng chỉ đó, nên chỉ tin cậy đúng chứng chỉ này, không tin cậy chứng chỉ nào khác gửi qua chat hay email.

### Cách 1: dùng script (khuyên dùng)

1. Tải file [`tin-cay-chung-chi.ps1`](tin-cay-chung-chi.ps1) trong repo này (script đã chứa sẵn chứng chỉ công khai và tự kiểm tra dấu vân tay; không cần tải thêm file nào).
2. Trong thư mục chứa file, giữ **Shift** + chuột phải vào chỗ trống → **Open PowerShell window here**, rồi chạy:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\tin-cay-chung-chi.ps1
   ```

   (hoặc chuột phải vào file → **Run with PowerShell**). `-ExecutionPolicy Bypass` chỉ áp dụng cho lần chạy này, không đổi cài đặt của máy.
3. Script hiện dấu vân tay và hỏi lại: gõ `C` rồi Enter.
4. Windows hiện hộp **Security Warning**: so dòng **Thumbprint** với `7489ABFA C1A7CD23 D5FFB078 5CA7CAB4 14AE49ED`. Khớp thì bấm **Yes**.

| Muốn | Lệnh (thêm vào sau `.\tin-cay-chung-chi.ps1`) |
|---|---|
| Tin cậy cho **mọi tài khoản** trên máy | `-TatCaNguoiDung` (mở PowerShell bằng **Run as administrator**) |
| Xem chứng chỉ đang được tin cậy ở đâu | `-KiemTra` |
| Bỏ tin cậy | `-Go` (thêm `-TatCaNguoiDung` nếu đã cài cho mọi tài khoản) |
| Cài hàng loạt, không hỏi lại | `-TatCaNguoiDung -KhongHoi` (quyền quản trị) |

Chạy lại nhiều lần vẫn an toàn: phần nào đã có thì bỏ qua. Script chỉ thêm / gỡ đúng chứng chỉ có dấu vân tay trên.

### Cách 2: bằng tay (không cần script)

1. Tải `SanoVids-NguyenGiangMinh.cer` (trong repo này hoặc mục Assets của bản phát hành), bấm đúp, kiểm tra **Thumbprint** ở tab **Details**.
2. Tab **General** → **Install Certificate…** → **Current User** → **Place all certificates in the following store** → **Browse…** → **Trusted Root Certification Authorities** → **Next** → **Finish** → Windows hỏi lại → kiểm tra Thumbprint → **Yes**.
3. Làm lại bước 2, lần này chọn kho **Trusted Publishers**.

Bỏ tin cậy bằng tay: `Win + R` → `certmgr.msc` → **Trusted Root Certification Authorities → Certificates** → chuột phải **Nguyễn Giang Minh (Jame Steven)** → **Delete**; làm tương tự trong **Trusted Publishers → Certificates**.

---

## Giấy phép

SanoVids là phần mềm **thuộc quyền sở hữu của tác giả Nguyễn Giang Minh (Jame Steven)** (đồng hành: Sano Group). Tóm tắt:

- Bạn được cài và dùng SanoVids **khi được tác giả cho phép** (ví dụ: trong nội bộ nhóm làm việc). Tải được từ trang công khai này **không** có nghĩa là được phép dùng.
- **Không** được sao chép, chỉnh sửa, dịch ngược, tháo rời, phân phối lại, cho thuê hoặc bán lại SanoVids khi chưa có sự đồng ý bằng văn bản của tác giả.
- Bản cài chính thức luôn được ký số bởi "Nguyễn Giang Minh (Jame Steven)" (dấu vân tay ở trên).
- SanoVids được cung cấp "nguyên trạng", không kèm bảo đảm nào.
- Các thành phần mã nguồn mở (Electron, Chromium, React…) theo giấy phép riêng của chúng, được kèm trong thư mục cài đặt.

Toàn văn: [LICENSE.txt](LICENSE.txt). Bộ cài cũng hiện toàn văn giấy phép trước khi cài.

---

## Các file trong repo này

| File | Là gì |
|---|---|
| `README.md` | Trang này |
| `LICENSE.txt` | Giấy phép sử dụng SanoVids |
| `SanoVids-NguyenGiangMinh.cer` | Chứng chỉ ký số **công khai** của tác giả (không chứa khoá bí mật) |
| `tin-cay-chung-chi.ps1` | Script tin cậy / bỏ tin cậy chứng chỉ trên máy Windows |

Bản cài của từng phiên bản nằm ở mục [Releases](https://github.com/JameSteven404/sanovids-releases/releases). Các bản cũ được giữ lại vì máy đang ở bản cũ cần chúng để cập nhật.

---

© 2026 Nguyễn Giang Minh (Jame Steven) · Đồng hành: Sano Group
