# 🎬 SanoVids

**SanoVids** là ứng dụng dạng *canvas node* để làm phim AI theo từng cảnh: quản lý nhân vật, nối ảnh tham chiếu vào cảnh, viết prompt với `@image_1`, `@video_1`, chạy tạo video hàng loạt, rồi lấy video vừa tạo để nối tiếp sang cảnh sau.

📥 **[Tải bản mới nhất (.exe)](https://github.com/JameSteven404/sanovids/releases/latest)** · 📜 **[Lịch sử phiên bản](CHANGELOG.md)**

Ứng dụng được thiết kế lại từ trải nghiệm thực tế với các công cụ canvas tạo video (Seedance 2.5, MiniMax-H3), để **nối node nhanh hơn, ít rối dây hơn và không lệch số tham chiếu**. Chạy được **trên web**, **cài như app** (PWA) hoặc bằng **file `.exe` trên Windows**.

> ℹ️ **Hai cách tạo video:**
> - **Chế độ Phát triển** (mặc định, cả web lẫn desktop): chạy **đúng mã của cổng canvasapp thật** nhưng tới một **canvasapp.io.vn giả lập ngay trong app** — không gọi mạng, không tốn tiền (credit dev giả lập). Có đủ đăng nhập, credit, nạp credit qua SePay giả, lịch sử credit, và **Bảng phát triển** để gây lỗi có chủ đích, xem nhật ký từng yêu cầu — dùng để làm quen và **tìm, sửa lỗi** trước khi dùng tiền thật. Xem mục [Chế độ Phát triển](#-chế-độ-phát-triển-tìm-và-sửa-lỗi).
> - **Cổng canvasapp.io.vn** (thử nghiệm, **chỉ bản desktop `.exe`**): tạo video thật bằng **tài khoản canvasapp của chính bạn**, trừ **credit thật**. Xem mục [Tạo video thật qua canvasapp.io.vn](#-tạo-video-thật-qua-canvasappiovn-bản-desktop).

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
- Prompt gửi đi **đúng như bạn viết**. Ảnh nối vào cảnh được đánh số `@image_1`, `@image_2`… theo thứ tự nối; video tham chiếu là `@video_1`, `@video_2`…. Viết `@Image 1`, `@image1` hay `@IMAGE_1` cũng được hiểu y như `@image_1`.
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
- **Chạy hàng loạt** với bảng xác nhận chi phí (ghi rõ trừ **credit dev** (giả lập) hay **credit canvasapp** (thật)), hàng đợi chạy song song, cập nhật tiến độ trực tiếp. Mọi nút Chạy / Chạy lại / Thử lại đều qua bảng chi phí, bấm đúp không bị chạy hai lần.
- Nút Chạy bị khoá kèm lý do khi cảnh chưa chạy được (prompt trống, thiếu ảnh, `@image_N` không có ảnh thật…).
- Đánh dấu ★ take chọn, khôi phục prompt của take cũ.
- **Tải video**: một nút cho từng video (kèm file `.txt` chứa prompt), **"Tải tất cả video chọn (.zip)"**, hoặc bật **Tự tải video khi tạo xong** vào thư mục bạn chọn.

### Xem video
- **Rê chuột lên node Video** để xem ngay trên canvas, **có tiếng**. Thanh điều khiển ở đáy video: **thanh thời gian** (bấm hoặc kéo để tua), **phát/dừng**, **tốc độ** (0,5× → 2×), **âm lượng** (bấm loa để tắt/bật, kéo thanh hoặc lăn chuột để chỉnh).
- Đã bấm vào điều khiển thì video **giữ mở** kể cả khi chuột rời node; bấm ra chỗ trống trên canvas để đóng. Rê sang node khác thì video đang mở tự dừng (không bao giờ hai video cùng kêu).
- Âm lượng, tốc độ và bật/tắt tiếng được **nhớ trên máy**, dùng chung cho node, cửa sổ xem take và **Phát liền** ở Storyboard.

### Các màn hình khác
- **Bảng cảnh**: xem dạng bảng, sắp xếp thứ tự, sửa hàng loạt.
- **Storyboard**: các cảnh theo thứ tự kèm take đã chọn, nút **Phát liền**.
- Nhiều dự án; xuất/nhập `.sanovids.json` (kèm ảnh) để sao lưu hoặc chuyển máy.
- Giao diện kiểu Apple, chế độ **Sáng / Tối / Theo hệ thống**.

---

## 🧪 Chế độ Phát triển (tìm và sửa lỗi)

Mặc định SanoVids chạy ở **chế độ Phát triển**: mọi bước của chế độ thật — đăng nhập, đọc số dư, tải ảnh tham chiếu lên, lưu canvas cầu nối, tạo job, theo dõi tiến độ, tải video về, nạp credit qua SePay, lịch sử credit — đều chạy bằng **chính mã của cổng canvasapp**, nhưng nói chuyện với một **canvasapp.io.vn giả lập nằm ngay trong app**. Không có yêu cầu mạng nào, không tốn tiền.

**Nhận biết:** ô credit trên thanh trên cùng có viền nét đứt và chữ **DEV** (ví dụ `DEV 1.000 credit`), mọi chi phí ghi **credit dev**, node Video có nhãn **DEV**. Credit dev **không phải tiền thật**.

**Dùng thử như thật**
- Lần đầu: bấm **DEV · Đăng nhập** → trang đăng nhập **giả lập** hiện ra (không cần mật khẩu) → **Đăng nhập**. Tài khoản giả lập có sẵn **1.000 credit dev**.
- Chạy cảnh như bình thường: video giả dài 3 giây, ghi nhãn **`@image_1`, `@image_2`…** lên từng ảnh tham chiếu **theo đúng thứ tự canvasapp nhận** — nhìn là biết có gửi đúng nhân vật không. Mặc định video xong sau khoảng 8 giây (đổi sang “Thực tế” 60–90 giây trong Bảng phát triển).
- Nút **+** cạnh ô credit → **Mở thanh toán QR** → trang **SePay giả lập** hiện ra trong app: bấm **Thanh toán thành công / Huỷ / Lỗi thanh toán / Đóng cửa sổ** để thử từng trường hợp.

**Bảng phát triển** (nút 🐞 trên thanh trên cùng, hoặc **Cài đặt → Chế độ Phát triển**):
- **Trạng thái**: đăng nhập / đăng xuất / hết phiên phía máy chủ, đặt số dư (+100, −100, về 0, về 1.000), tốc độ tạo video, bật/tắt nạp credit, chống trùng job, mã lỗi khi hết credit (402/400), độ trễ mạng, tỉ lệ job tự lỗi, bật/tắt từng model và chế độ, xoá dữ liệu máy chủ giả lập.
- **Gây lỗi**: bấm một nút để lần yêu cầu tới bị lỗi (bật “giữ” để lặp lại tới khi tắt): mất mạng khi tạo job, **mất câu trả lời sau khi đã tạo job (đã trừ tiền)**, 502, 200 không có mã job, không đủ credit (402), dữ liệu sai (422), “Invalid canvas payload”, hết phiên (401), quá nhiều yêu cầu (429), job tiếp theo lỗi / hết hạn, tải video lỗi N lần, tải ảnh lên lỗi, chậm 3 giây… hoặc tự tạo lỗi cho bất kỳ yêu cầu nào. Nút 🐞 hiện số lỗi giả đang bật để không nhầm với lỗi thật.
- **Nhật ký**: mọi yêu cầu SanoVids gửi đi và câu trả lời (mã, thời gian, lỗi giả đã áp dụng), mở ra xem JSON; lọc; **Copy nhật ký** (JSON) để gửi kèm khi báo lỗi. Với mỗi lần tạo job có ô **Kiểm tra nhân vật**: từng ảnh theo thứ tự = `@image_N` → ảnh và tên nhân vật trong dự án, và cảnh báo nếu prompt nhắc `@image_N` mà không có ảnh.
- **Job & đơn nạp**: job trên máy chủ giả lập (tiến độ, chi phí, đã hoàn chưa, thuộc take nào) với **Hoàn tất ngay / Cho lỗi / Cho hết hạn**; đơn nạp với **Đã thanh toán / Cần đối soát / Từ chối / Hết hạn**; ảnh đã tải lên.

**Cách tìm lỗi:** bật một lỗi → làm thao tác bình thường (chạy cảnh, nạp credit, đăng nhập) → xem SanoVids báo gì, take có giữ đúng trạng thái không, credit có bị trừ hai lần không → mở **Nhật ký** xem từng yêu cầu → **Copy nhật ký** gửi kèm báo lỗi. Chế độ Phát triển cũng từ chối đúng những gì canvasapp từ chối (ảnh không phải JPG/PNG/WEBP, video tham chiếu `@video_N`, prompt quá dài…).

---

## 🔌 Tạo video thật qua canvasapp.io.vn (bản desktop)

> 🧪 **Thử nghiệm.** Cổng dùng API nội bộ của trang canvasapp.io.vn (không phải API công khai), có thể thay đổi bất cứ lúc nào. Nên hỏi ý bên vận hành canvasapp trước khi dùng lâu dài.

**Bật cổng**
1. Mở bản **desktop** (`.exe`) → **Cài đặt** → **Cổng canvasapp.io.vn**.
2. Bấm **Đăng nhập canvasapp**: trang đăng nhập **thật** của canvasapp mở trong cửa sổ riêng, bạn tự đăng nhập ở đó. **SanoVids không bao giờ thấy mật khẩu.**
3. Chọn **canvasapp.io.vn** ở "Nhà cung cấp video cho take mới". Ô credit trên thanh trên cùng đổi từ **DEV** (giả lập) sang **canvasapp · số credit thật**.

**Credit & nạp credit**
- Số dư đọc trực tiếp từ tài khoản canvasapp (1 credit ≈ 1.000đ). Bảng chi phí trước khi chạy dùng đúng bảng giá của canvasapp.
- Nút **+** cạnh ô credit (hoặc **Cài đặt → Nạp credit**): nhập số tiền → **Mở thanh toán QR** → trang **SePay** mở trong cửa sổ riêng → **bạn tự quét QR** bằng app ngân hàng. SanoVids chỉ cho mở trang của sepay.vn, không nhập hay thấy thông tin ngân hàng, và chỉ báo **"Đã nhận tiền"** khi chính canvasapp xác nhận.
- **Lịch sử credit** xem ngay trong app.

**An toàn tiền & đúng nhân vật**
- `@image_N` luôn là đúng tấm ảnh thứ N gửi đi (thứ tự tải lên = thứ tự `@image`). Mỗi ảnh chỉ tải lên canvasapp một lần.
- Mất mạng đúng lúc gửi: SanoVids **không tự gửi lại thành job mới**. Take hiện "không rõ đã bị trừ chưa". Bấm gửi lại thì app tìm job cũ trên canvasapp trước, rồi mới gửi lại bằng **cùng mã yêu cầu**.
- Video đã tạo xong (đã trả tiền) mà tải về lỗi thì app tự thử tải lại, không đánh "thất bại".
- Đóng app khi đang tạo: mở lại, app tiếp tục theo dõi job cũ, không gửi lại.

**Giới hạn hiện tại**
- Tối đa 2 job cùng lúc, cập nhật tiến độ khoảng 20 giây/lần.
- **Chưa hỗ trợ video tham chiếu** `@video_N` qua cổng (cả chế độ Phát triển cũng từ chối giống vậy): bỏ `@video_N` để chạy cảnh tiếp nối.
- App dùng một phiên tên **"SanoVids bridge"** trên canvasapp để gửi job. **Đừng sửa phiên này bằng tay.**
- Huỷ trong SanoVids chỉ ngừng theo dõi: job đã gửi vẫn chạy và tính tiền trên canvasapp.

👉 Lần đầu dùng credit thật: tập dượt miễn phí bằng chế độ Phát triển trước, rồi làm theo danh sách tự kiểm tra (tốn khoảng 8 credit): [docs/TEST-REAL-CREDITS.md](docs/TEST-REAL-CREDITS.md).

---

## 💻 Cài trên Windows (file .exe)

Vào mục **[Releases](https://github.com/JameSteven404/sanovids/releases)** (hoặc thư mục `release/` sau khi tự build), chọn phiên bản mới nhất. Mỗi phiên bản có 2 file:

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
| `npm run dist:win` | Tạo 2 file `.exe` (cài đặt + portable) trong `release/`; bản cũ tự chuyển vào `release/ban-cu/` |
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
├── lib/           # Lưu ảnh/video, tải về, kéo-thả, PWA, giao diện sáng/tối, phát video, credit
├── providers/     # Nhà cung cấp video: cổng canvasapp.io.vn (api, ánh xạ, cầu nối desktop), dev/ = canvasapp giả lập
│                  #   của chế độ Phát triển (máy chủ, cầu nối, lỗi giả, nhật ký), mock = demo cũ
├── components/
│   ├── canvas/    # Canvas: thẻ cảnh, node Video, thẻ nhân vật, dây nối, thanh công cụ
│   ├── sidebar/   # Thư viện, Video đã tạo, Preset
│   ├── inspector/ # Bảng chỉnh sửa, ô prompt có gợi ý @ và tô màu token
│   ├── runs/      # Hàng đợi, xác nhận chạy, xem take
│   ├── views/     # Bảng cảnh, Storyboard
│   ├── dialogs/   # Nhập prompt, cài đặt (cổng canvasapp), dự án, phím tắt
│   ├── topbar/    # Thanh trên cùng, ô credit (DEV / canvasapp)
│   ├── topup/     # Nạp credit (QR SePay; SePay giả lập ở chế độ Phát triển), lịch sử credit
│   ├── dev/       # Bảng phát triển, trang đăng nhập / SePay giả lập
│   └── common/    # Modal, thông báo, ảnh, kéo đổi độ rộng
├── actions.ts     # Lệnh dùng chung (nối, xoá, chạy, tải, copy…)
└── App.tsx        # Khung ứng dụng
electron/          # Vỏ ứng dụng desktop (Electron), cửa sổ đăng nhập / thanh toán canvasapp
public/            # Icon, manifest PWA
docs/              # Đặc tả (SPEC.md, SPEC-v2.md), cổng canvasapp, tự kiểm tra credit thật
```

## 🛠️ Công nghệ
[Vite](https://vite.dev) · [React 19](https://react.dev) · TypeScript · [React Flow](https://reactflow.dev) · [Zustand](https://zustand.docs.pmnd.rs) + zundo · lucide-react · idb-keyval · JSZip · vite-plugin-pwa · [Electron](https://www.electronjs.org/) + electron-builder · Vitest

---

## 🧭 Lộ trình
Chi tiết từng phiên bản: [CHANGELOG.md](CHANGELOG.md).

- [x] v1: canvas, thư viện, nối hàng loạt, hàng đợi giả lập, bảng cảnh, storyboard
- [x] v2: node Video, `@image_N` / `@video_N` tự đánh số, bỏ khối prompt, IndexedDB, PWA, file `.exe`, nút tải video
- [x] v0.2 (thử nghiệm): cổng canvasapp.io.vn trong bản desktop (đăng nhập trên trang thật, credit thật, nạp credit bằng QR SePay), khoá chặt đồng bộ nhân vật, xem video có tiếng + thanh điều khiển ngay trên node. Tự kiểm tra trước khi dùng: [docs/TEST-REAL-CREDITS.md](docs/TEST-REAL-CREDITS.md)
- [x] Chế độ Phát triển thay cho demo: canvasapp giả lập trong app với đủ tính năng của chế độ thật, Bảng phát triển (gây lỗi, nhật ký, kiểm tra nhân vật, điều khiển job / đơn nạp)
- [ ] Video tham chiếu `@video_N` qua cổng canvasapp
- [ ] Kết nối API thật (BytePlus ModelArk cho Seedance 2.5, MiniMax cho H3) qua lớp *provider adapter*, có giới hạn chi tiêu
- [ ] So sánh nhiều take cạnh nhau, ghép cả phim thành một MP4
- [ ] Ký số file `.exe`, tự cập nhật phiên bản

## 📄 Giấy phép
Dự án cá nhân, chưa chọn giấy phép mã nguồn mở. Mọi quyền được bảo lưu.
