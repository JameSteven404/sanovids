# 🎬 Bàn Dựng Phim

**Bàn Dựng Phim** là một ứng dụng web dạng *canvas node* để làm phim AI theo từng cảnh: quản lý nhân vật, nối ảnh tham chiếu vào cảnh, viết prompt, chạy tạo video hàng loạt và chọn take đẹp nhất. Ứng dụng được thiết kế lại từ trải nghiệm thực tế với các công cụ canvas tạo video (Seedance 2.5, MiniMax-H3) để **việc nối node nhanh hơn, ít rối dây hơn và ít copy-paste hơn**.

> ⚠️ **Đây là bản demo.** Phần tạo video đang dùng **nhà cung cấp giả lập** (mock): không gọi mạng, không tốn tiền, video trả về là clip minh hoạ được tạo ngay trong trình duyệt. Mục đích là để thử giao diện, cách nối node và quy trình làm việc trước khi kết nối API thật.

---

## ✨ Tính năng chính

### Canvas & nối node
- **Kéo dây thả vào bất kỳ đâu trên thẻ cảnh** để nối, không cần nhắm đúng chấm tròn.
- **Kéo nhân vật từ Thư viện** thả vào cảnh. Nếu đang chọn nhiều cảnh thì nối vào tất cả cùng lúc.
- **Nối hàng loạt**: chọn nhiều nhân vật và nhiều cảnh rồi bấm `C`.
- **Dây ẩn mặc định**, chỉ hiện dây của cảnh đang chọn hoặc đang rê chuột (có thể đổi sang Ẩn / Đang chọn / Tất cả). Không còn cảnh "mì sợi".
- Bấm vào dây rồi `Delete`, hoặc bấm nút × trên dây để cắt. Kéo đầu dây sang cảnh khác để nối lại.
- Thả dây ra chỗ trống: hiện menu tạo cảnh mới đã nối sẵn.
- **Hoàn tác / Làm lại** (`Ctrl+Z` / `Ctrl+Y`) cho mọi thao tác.
- Bản đồ thu nhỏ (minimap), lưới bắt điểm, sắp xếp tự động. Khi thu nhỏ, thẻ cảnh chuyển sang chế độ hiển thị gọn.
- Kéo đổi độ rộng hai thanh bên (bấm đúp để về mặc định).

### Viết prompt
- Gõ `@` trong prompt để chèn nhân vật/bối cảnh, ứng dụng **tự nối** vào cảnh.
- Tự đánh số `@image_1`, `@image_2`… theo thứ tự tham chiếu.
- Xem trước **prompt cuối cùng** sẽ gửi đi, đếm ký tự theo giới hạn của từng model, cảnh báo khi thiếu hoặc thừa tham chiếu.
- Nút **Copy prompt** và **Tải ảnh + prompt (.zip)**, ảnh được đặt tên đúng thứ tự (`01_Elara.png`…), tiện dán sang công cụ khác.
- **Nhập prompt cũ**: dán nhiều prompt (hoặc thả các file `.txt`), ứng dụng tự tách thành từng cảnh.

### Chạy video & quản lý take
- **Preset** (ví dụ *Nháp 30s · 480p*, *Final 15s · 1080p*), áp dụng cho nhiều cảnh một lần.
- **Chạy hàng loạt** với bảng xác nhận chi phí: tổng credit, số dư trước và sau, cảnh nào bị bỏ qua và vì sao.
- **Hàng đợi** chạy song song, cập nhật tiến độ trực tiếp. Có thể huỷ hoặc chạy lại; lỗi được hoàn credit.
- Mỗi lần chạy là một **take** (T1, T2…): xem video, đánh dấu ★ take chọn, **khôi phục prompt** của take cũ, tải về.

### Các màn hình khác
- **Bảng cảnh**: xem tất cả cảnh dạng bảng, sắp xếp lại thứ tự, sửa hàng loạt.
- **Storyboard**: lưới các cảnh theo thứ tự kèm take đã chọn, nút **Phát liền** để xem nối tiếp.
- Nhiều dự án; xuất/nhập dự án ra file `.bdp.json` (kèm ảnh) để sao lưu hoặc chuyển máy.

---

## 🚀 Cài đặt & chạy

### Yêu cầu
- [Node.js](https://nodejs.org/) **20 trở lên** (khuyến nghị bản LTS mới nhất)
- [Git](https://git-scm.com/)
- Trình duyệt nhân Chromium (Chrome, Edge, Brave) để có trải nghiệm tốt nhất

### Cách nhanh nhất (Windows)
Bấm đúp vào **`start.bat`**. Lần đầu tiên nó sẽ tự cài thư viện, sau đó mở trình duyệt tại http://localhost:5180.

### Chạy bằng dòng lệnh
```bash
git clone <địa-chỉ-repo-của-bạn>
cd <thư-mục-repo>
npm install
npm run dev
```
Mở http://localhost:5180

### Các lệnh khác
| Lệnh | Tác dụng |
|---|---|
| `npm run dev` | Chạy bản phát triển (tự tải lại khi sửa code) |
| `npm run build` | Kiểm tra kiểu và build bản chạy thật vào thư mục `dist/` |
| `npm run preview` | Chạy thử bản đã build |
| `npm run typecheck` | Kiểm tra lỗi TypeScript |
| `npm test` | Chạy unit test (Vitest) |

> 💾 **Dữ liệu được lưu ngay trong trình duyệt** của bạn (localStorage + IndexedDB), không gửi đi đâu. Xoá dữ liệu trình duyệt sẽ mất dự án, nên hãy dùng **Cài đặt → Xuất dự án** để sao lưu.

---

## ⌨️ Phím tắt

| Phím | Tác dụng |
|---|---|
| `N` | Tạo cảnh mới / cảnh tiếp theo |
| `C` | Nối nhân vật đang chọn vào các cảnh đang chọn |
| `Ctrl + Enter` | Chạy các cảnh đang chọn |
| `Ctrl + D` | Nhân bản cảnh |
| `Delete` | Xoá cảnh / cắt dây đang chọn |
| `Ctrl + Z` / `Ctrl + Y` | Hoàn tác / Làm lại |
| `Ctrl + A` | Chọn tất cả cảnh |
| `F` | Vừa màn hình |
| `E` | Đổi chế độ hiện dây nối |
| `H` / `V` | Công cụ Tay (kéo màn hình) / Chọn |
| `M` | Bật/tắt bản đồ thu nhỏ |
| `1` `2` `3` | Canvas / Bảng cảnh / Storyboard |
| `Ctrl + K` | Tìm trong thư viện |
| `Ctrl + S` | Lưu ngay |
| `?` | Xem toàn bộ phím tắt |

---

## 🗂️ Cấu trúc thư mục

```
src/
├── core/          # Mô hình dữ liệu, bộ ghép prompt, bảng giá model, dữ liệu mẫu (+ unit test)
├── store/         # Trạng thái: dự án (có hoàn tác), hàng đợi/take, giao diện, lưu trữ
├── lib/           # Lưu ảnh/video (IndexedDB), nhà cung cấp video giả lập
├── components/
│   ├── canvas/    # Bảng canvas, thẻ cảnh, thẻ nhân vật, dây nối, thanh công cụ
│   ├── sidebar/   # Thư viện nhân vật/bối cảnh, preset
│   ├── inspector/ # Bảng chỉnh sửa bên phải, ô prompt có gợi ý @
│   ├── runs/      # Hàng đợi, xác nhận chạy, xem take
│   ├── views/     # Bảng cảnh, Storyboard
│   ├── dialogs/   # Nhập prompt, cài đặt, dự án, phím tắt
│   └── common/    # Thành phần dùng chung (modal, thông báo, ảnh…)
├── actions.ts     # Các lệnh dùng chung (nối, xoá, chạy, copy…)
└── App.tsx        # Khung ứng dụng
docs/              # Đặc tả giao diện (SPEC.md, SPEC-v2.md)
```

## 🛠️ Công nghệ
[Vite](https://vite.dev) · [React 19](https://react.dev) · TypeScript · [React Flow (@xyflow/react)](https://reactflow.dev) · [Zustand](https://zustand.docs.pmnd.rs) + [zundo](https://github.com/charkour/zundo) (hoàn tác) · [lucide-react](https://lucide.dev) · idb-keyval · JSZip · Vitest

---

## 🧭 Lộ trình

**Đang làm (v2)**: xem chi tiết ở [`docs/SPEC-v2.md`](docs/SPEC-v2.md)
- [ ] Mỗi lần tạo video sinh ra một **node Video** nối từ cảnh. Kéo node Video sang cảnh khác để dùng làm tham chiếu `@video_1` và làm cảnh tiếp nối.
- [ ] Prompt dùng trực tiếp `@image_N` / `@video_N`, **tự đánh lại số** khi đổi thứ tự hoặc bỏ tham chiếu.
- [ ] Bỏ "khối prompt" và đoạn tham chiếu tự sinh cho gọn.
- [ ] Cài như ứng dụng (PWA), chạy cả khi không có mạng.
- [ ] Lưu dữ liệu bằng IndexedDB để không giới hạn dung lượng; tối ưu tốc độ tải.

**Tiếp theo**
- [ ] Kết nối API thật (BytePlus ModelArk cho Seedance 2.5, MiniMax cho H3) qua lớp *provider adapter*, giữ API key ở máy chủ, có giới hạn chi tiêu.
- [ ] So sánh nhiều take cạnh nhau, ghép cả phim thành một file MP4.
- [ ] Đóng gói thành ứng dụng desktop (.exe).

---

## 📄 Giấy phép
Dự án cá nhân, chưa chọn giấy phép mã nguồn mở. Mọi quyền được bảo lưu.
