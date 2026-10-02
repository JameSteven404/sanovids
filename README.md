# 🎬 SanoVids

**SanoVids** là ứng dụng dạng *canvas node* để làm phim AI theo từng cảnh: quản lý nhân vật, nối ảnh tham chiếu vào cảnh, viết prompt với `@image_1`, `@video_1`, chạy tạo video hàng loạt, rồi lấy video vừa tạo để nối tiếp sang cảnh sau.

Ứng dụng được thiết kế lại từ trải nghiệm thực tế với các công cụ canvas tạo video (Seedance 2.5, MiniMax-H3), để **nối node nhanh hơn, ít rối dây hơn và không lệch số tham chiếu**. Chạy được **trên web**, **cài như app** (PWA) hoặc bằng **file `.exe` trên Windows**.

> ⚠️ **Đây là bản demo.** Phần tạo video đang dùng **nhà cung cấp giả lập**: không gọi mạng, không tốn tiền. Video trả về là clip minh hoạ được tạo ngay trên máy. Mục đích là thử giao diện, cách nối node và quy trình làm việc trước khi kết nối API thật.

---

## ✨ Tính năng chính

### Canvas & nối node
- **Mỗi lần tạo video sinh ra một node Video** nối từ cảnh, xếp ngay bên phải cảnh. Có **nút "⬇ Tải video" to** ở dưới mỗi node.
- **Kéo node Video sang cảnh khác** để dùng làm video tham chiếu `@video_1` (nối tiếp câu chuyện). Thả ra chỗ trống để **tạo cảnh tiếp nối**: giữ nhân vật, prompt bắt đầu bằng `Continue from @video_1:`.
- **Kéo dây từ nhân vật thả vào bất kỳ đâu trên thẻ cảnh** để nối ảnh tham chiếu. Kéo nhân vật từ Thư viện vào cảnh cũng được.
- **Nối hàng loạt**: chọn nhiều nhân vật hoặc video cùng nhiều cảnh rồi bấm `C`.
- **Dây ẩn mặc định**, chỉ hiện dây của cảnh đang chọn hoặc đang trỏ chuột vào (đổi được: Ẩn / Đang chọn / Tất cả).
- Cắt dây bằng nút × hoặc phím `Delete`. Kéo đầu dây sang cảnh khác để nối lại.
- **Hoàn tác / Làm lại** (`Ctrl+Z` / `Ctrl+Y`), bản đồ thu nhỏ, sắp xếp tự động.
- Chế độ "Chỉ take chọn" chỉ hiện video ★ của mỗi cảnh cho gọn.
- Kéo đổi độ rộng hai thanh bên (bấm đúp để về mặc định).

### Viết prompt với `@image_N` / `@video_N`
- Prompt gửi đi **đúng như bạn viết**. Ảnh nối vào cảnh được đánh số `@image_1`, `@image_2`… theo thứ tự nối; video tham chiếu là `@video_1`, `@video_2`….
- Gõ `@` để chọn nhanh: ảnh đã nối, video đã nối, hoặc nhân vật chưa nối (ứng dụng tự nối rồi chèn số).
- **Tự đánh lại số**: khi đổi thứ tự hoặc bỏ một ảnh/video, mọi `@image_N` / `@video_N` trong prompt được sửa theo, để không bị lệch nhân vật.
- Token được tô màu ngay trong ô prompt. Số không có ảnh thật trong lần gửi (vượt số ảnh, vượt giới hạn của model, hoặc dấu chờ `@image_?N`) tô đỏ và **chặn nút Chạy**, để không bao giờ gửi nhầm nhân vật. Dưới ô có bảng chú giải ảnh ↔ số.
- Viết prompt trước rồi nối ảnh sau cũng được: `@image_1`, `@image_2` sẽ khớp với các nhân vật nối vào theo thứ tự.
- Take đã bấm Chạy luôn gửi đúng bộ ảnh lúc bấm, dù bạn sửa thư viện trong lúc chờ.
- Cảnh báo khi thiếu tham chiếu, vượt giới hạn ảnh/video của model, prompt quá dài.
- **Copy prompt** và **Tải ảnh + video + prompt (.zip)** đã đánh số đúng thứ tự.
- **Nhập prompt cũ**: dán nhiều prompt hoặc thả các file `.txt` để tạo cảnh hàng loạt. Có thể gán ảnh thư viện cho từng số `@image_N`.

### Chạy video & tải về
- **Preset** (ví dụ *Nháp 30s · 480p*, *Final 15s · 1080p*), áp dụng cho nhiều cảnh một lần.
- **Chạy hàng loạt** với bảng xác nhận chi phí, hàng đợi chạy song song, cập nhật tiến độ trực tiếp. Lỗi được hoàn credit.
- Đánh dấu ★ take chọn, khôi phục prompt của take cũ.
- **Tải video**: một nút cho từng video (kèm file `.txt` chứa prompt), **"Tải tất cả video chọn (.zip)"**, hoặc bật **Tự tải video khi tạo xong** vào thư mục bạn chọn.

### Các màn hình khác
- **Bảng cảnh**: xem dạng bảng, sắp xếp thứ tự, sửa hàng loạt.
- **Storyboard**: các cảnh theo thứ tự kèm take đã chọn, nút **Phát liền**.
- Nhiều dự án; xuất/nhập `.sanovids.json` (kèm ảnh) để sao lưu hoặc chuyển máy.

---

## 💻 Cài trên Windows (file .exe)

Trong mục [Releases](../../releases) (hoặc thư mục `release/` sau khi tự build) có 2 file:

| File | Dùng khi |
|---|---|
| `SanoVids-Setup-<phiên bản>.exe` | **Khuyên dùng.** Bộ cài đặt: chọn thư mục, tạo icon ở Desktop và Start Menu. |
| `SanoVids-Portable-<phiên bản>.exe` | Bấm là chạy, không cần cài (mở chậm hơn vì phải tự giải nén mỗi lần). Hợp để chép USB. |

> 🛡️ File chưa có chữ ký số nên lần đầu mở Windows có thể báo **"Windows protected your PC"**. Bấm **More info → Run anyway**.

- Dữ liệu của bản desktop nằm ở `%APPDATA%\SanoVids` trên từng máy. Muốn mang dự án sang máy khác, dùng **Cài đặt → Xuất dự án** rồi **Nhập** ở máy kia.
- Video tải về được lưu vào thư mục **Downloads**, hoặc thư mục bạn chọn trong Cài đặt.

### Cài như app từ trình duyệt (PWA)
Mở bản web bằng Chrome / Edge / Brave, rồi bấm biểu tượng **Cài đặt ứng dụng** trên thanh địa chỉ (hoặc **Cài đặt → Ứng dụng → Cài app** trong SanoVids). App có cửa sổ riêng, icon riêng và chạy được khi không có mạng.

---

## 🚀 Chạy từ mã nguồn

### Yêu cầu
- [Node.js](https://nodejs.org/) **20 trở lên** (khuyến nghị bản LTS mới nhất)
- [Git](https://git-scm.com/)

### Cách nhanh nhất (Windows)
- **`start.bat`**: build (nếu chưa có) rồi mở bản chạy thật tại http://localhost:5180. Sau khi sửa code, xoá thư mục `dist/` hoặc chạy `npm run build` để cập nhật.
- **`dev.bat`**: bản phát triển, tự tải lại khi sửa code.

### Dòng lệnh
```bash
git clone https://github.com/JameSteven404/sanovids.git
cd sanovids
npm install
npm run dev
```

| Lệnh | Tác dụng |
|---|---|
| `npm run dev` | Bản phát triển tại http://localhost:5180 |
| `npm run build` | Kiểm tra kiểu và build bản chạy thật vào `dist/` (đưa lên host web tĩnh nào cũng chạy) |
| `npm run preview` | Chạy thử bản đã build |
| `npm run desktop` | Build rồi mở bản desktop (Electron) trên máy |
| `npm run dist:win` | Tạo 2 file `.exe` (cài đặt + portable) trong `release/` |
| `npm run icons` | Tạo lại icon ứng dụng |
| `npm run typecheck` / `npm test` | Kiểm tra TypeScript / chạy unit test |

> 💾 Dữ liệu được lưu **ngay trên máy** (IndexedDB của trình duyệt hoặc của app desktop), không gửi đi đâu.

---

## ⌨️ Phím tắt

| Phím | Tác dụng |
|---|---|
| `N` | Tạo cảnh mới / cảnh tiếp theo (bên dưới cảnh đang chọn) |
| `C` | Nối nhân vật hoặc video đang chọn vào các cảnh đang chọn |
| `Ctrl + Enter` | Chạy các cảnh đang chọn |
| `Ctrl + D` | Nhân bản cảnh |
| `Delete` | Xoá cảnh / video / cắt dây đang chọn |
| `Ctrl + Z` / `Ctrl + Y` | Hoàn tác / Làm lại |
| `Ctrl + A` | Chọn tất cả cảnh |
| `F` | Vừa màn hình |
| `E` | Đổi chế độ hiện dây nối |
| `H` / `V` | Công cụ Tay / Chọn |
| `M` | Bật/tắt bản đồ thu nhỏ |
| `1` `2` `3` | Canvas / Bảng cảnh / Storyboard |
| `Ctrl + K` | Tìm trong thư viện |
| `Ctrl + S` | Lưu ngay |
| `?` | Xem toàn bộ phím tắt |

---

## 🗂️ Cấu trúc thư mục

```
src/
├── core/          # Mô hình dữ liệu, xử lý prompt & đánh số @image/@video, model & giá, di trú dữ liệu (+ test)
├── store/         # Trạng thái: dự án (có hoàn tác), hàng đợi/take, giao diện, lưu trữ IndexedDB
├── lib/           # Lưu ảnh/video, tải về, kéo-thả, PWA, nhà cung cấp video giả lập
├── components/
│   ├── canvas/    # Canvas: thẻ cảnh, node Video, thẻ nhân vật, dây nối, thanh công cụ
│   ├── sidebar/   # Thư viện, Video đã tạo, Preset
│   ├── inspector/ # Bảng chỉnh sửa, ô prompt có gợi ý @ và tô màu token
│   ├── runs/      # Hàng đợi, xác nhận chạy, xem take
│   ├── views/     # Bảng cảnh, Storyboard
│   ├── dialogs/   # Nhập prompt, cài đặt, dự án, phím tắt
│   └── common/    # Modal, thông báo, ảnh, kéo đổi độ rộng
├── actions.ts     # Lệnh dùng chung (nối, xoá, chạy, tải, copy…)
└── App.tsx        # Khung ứng dụng
electron/          # Vỏ ứng dụng desktop (Electron)
public/            # Icon, manifest PWA
docs/              # Đặc tả (SPEC.md, SPEC-v2.md)
```

## 🛠️ Công nghệ
[Vite](https://vite.dev) · [React 19](https://react.dev) · TypeScript · [React Flow](https://reactflow.dev) · [Zustand](https://zustand.docs.pmnd.rs) + zundo · lucide-react · idb-keyval · JSZip · vite-plugin-pwa · [Electron](https://www.electronjs.org/) + electron-builder · Vitest

---

## 🧭 Lộ trình
- [x] v1: canvas, thư viện, nối hàng loạt, hàng đợi giả lập, bảng cảnh, storyboard
- [x] v2: node Video, `@image_N` / `@video_N` tự đánh số, bỏ khối prompt, IndexedDB, PWA, file `.exe`, nút tải video
- [x] v0.2 (thử nghiệm): cổng canvasapp.io.vn trong bản desktop (đăng nhập trên trang thật, credit thật, nạp credit bằng QR SePay). Tự kiểm tra trước khi dùng: [docs/TEST-REAL-CREDITS.md](docs/TEST-REAL-CREDITS.md)
- [ ] Kết nối API thật (BytePlus ModelArk cho Seedance 2.5, MiniMax cho H3) qua lớp *provider adapter*, có giới hạn chi tiêu
- [ ] So sánh nhiều take cạnh nhau, ghép cả phim thành một MP4
- [ ] Ký số file `.exe`, tự cập nhật phiên bản

## 📄 Giấy phép
Dự án cá nhân, chưa chọn giấy phép mã nguồn mở. Mọi quyền được bảo lưu.
