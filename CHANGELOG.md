# 📜 Lịch sử phiên bản

Mọi thay đổi đáng chú ý của SanoVids. Bản cài `.exe` của từng phiên bản có ở mục [Releases](https://github.com/JameSteven404/sanovids/releases).

Ký hiệu: ✨ thêm mới · 🛠️ thay đổi · 🐞 sửa lỗi · ⚠️ lưu ý

---

## [0.2.5] — 2026-10-02

🐞 **Node mới không còn "bay" ra xa**
- Bấm **+ Cảnh** / `N` / **Cảnh mới** khi không chọn cảnh nào: cảnh mới nằm **ngay dưới cảnh bạn vừa chọn hoặc vừa tạo** (chọn một nhân vật cũng không làm mất mốc này). Nếu cảnh đó không nằm trong vùng đang nhìn thì đặt dưới cảnh thấp nhất trong vùng nhìn, còn không có cảnh nào trong vùng nhìn thì đặt giữa màn hình. Trước đây cảnh mới luôn về cột bên trái (x 420) ở hàng tính theo số cảnh, có khi cách chỗ bạn làm hàng nghìn px.
- Cảnh mới **không đè** lên thẻ nhân vật, video đã kéo ra chỗ khác hay hàng video của cảnh khác: nó trượt xuống chỗ trống gần nhất.
- **Bấm đúp** lên nền canvas: cảnh mới nằm đúng chỗ bấm, chỉ xê dịch vừa đủ (lên/xuống trước, sang ngang sau, tối đa khoảng một hàng) nếu chạm thẻ khác — không còn trượt xuống tận cuối một cột dài cảnh hay thẻ nhân vật. Không có chỗ trống gần đó thì giữ đúng chỗ bấm. Khi vùng đang nhìn không có cảnh nào, cảnh mới vào chỗ trống gần giữa màn hình nhất **trong vùng nhìn**.
- Khung nhìn **chỉ trượt vừa đủ** để thấy node mới và **giữ nguyên mức zoom**. Trước đây canvas tự phóng to lên 80% và nhảy tới node mới nên mọi thứ khác như bị dời đi xa.
- `N` khi đang chọn cảnh: cảnh mới nằm ngay dưới cảnh đó. Chỉ những thẻ **thật sự bị đè** mới được đẩy xuống, và chỉ vừa đủ. Cột bên cạnh (cách 16 px) không còn bị đẩy theo.
- Video đã kéo ra chỗ khác hoặc đang ẩn (chế độ "Chỉ take chọn") không còn làm cảnh tiếp theo bị đẩy xuống thấp. **Sắp xếp** vẫn chừa chỗ cho video đang ẩn, nên bật lại "Tất cả" thì không video nào đè hàng dưới.
- Video mới của một cảnh nằm ngay cạnh cảnh, không xếp sau các video đã kéo đi chỗ khác (trước đây video thứ 10 có thể nằm cách thẻ cảnh hơn 2.000 px). Video chỉ hơi xê dịch thì vẫn giữ chỗ của nó trong hàng.
- **Tạo cảnh tiếp nối** từ một video đã kéo ra chỗ khác: cảnh mới nằm ngay bên phải video đó. Video chỉ hơi xê dịch hoặc đổi cỡ tại chỗ (vẫn trong hàng của cảnh): cảnh mới nằm dưới cảnh gốc như trước, không chắn chỗ của video tiếp theo.
- **Đưa lên canvas** từ thư viện: thẻ mới vào đúng cột nhân vật, không chạy theo một thẻ lẻ đã kéo ra xa, và không đè thẻ nằm lệch cạnh cột. Thả nhiều thẻ cùng lúc: xếp thành hàng 4 thẻ, thẻ nào đã có trên canvas thì giữ nguyên chỗ.
- Nhập prompt hàng loạt: các cảnh mới xếp ngay dưới cảnh bạn vừa làm.

🛠️ **Thông báo chuyển lên trên**
- Thông báo hiện ở **giữa phía trên**, ngay dưới thanh trên cùng, thông báo mới nhất ở trên cùng. Không còn che thanh công cụ canvas (+ Cảnh, Chạy, Sắp xếp, zoom…) và hàng đợi ở dưới.

🛠️ **Chạy tối đa 10 video cùng lúc qua canvasapp** (trước đây 2)
- Từ video thứ 11 trở đi thì chờ trong hàng đợi.
- Vẫn nhẹ nhàng với máy chủ: tiến độ của mọi video được kiểm tra chung **một lần** (≥ 15 giây/lần), gửi từng video một, tối đa 2 yêu cầu + 2 lượt tải video cùng lúc. Tải video về không còn làm chậm việc kiểm tra tiến độ hay gửi video mới.
- Video đang tạo **không bao giờ bị gỡ** khỏi canvas cầu nối trên canvasapp để lấy chỗ cho video mới. Khi canvas đã kín (40 node / 30 ảnh — vd. nhiều cảnh, mỗi cảnh 4 nhân vật khác nhau), video mới **chờ trong hàng đợi** tới khi một video xong rồi tự gửi; chưa gửi thì không bị trừ credit.
- Video chờ gửi hiện đúng là "đang chờ" (gửi lần lượt từng cái): huỷ lúc này thì chắc chắn không bị trừ credit, và nếu app bị đóng giữa chừng thì nhiều nhất một video bị đánh dấu "không rõ đã trừ credit chưa".

## [0.2.4] — 2026-10-02

🐞 **Tag ảnh viết kiểu `@Image 1` giờ được nhận đúng** (sửa gấp)
- Prompt viết `@Image 1`, `@image 2`, `@image3`, `@IMAGE_4` (chữ hoa / thường, có dấu cách, gạch dưới hoặc viết liền) được hiểu **giống hệt** `@image_1`.
- Các tag này được **tô màu**, được kiểm tra có ảnh thật đi kèm hay không, và **tự đánh lại số** khi đổi thứ tự ảnh. App giữ nguyên cách bạn viết: `@Image 1` → `@Image 3`.
- Trước đây các tag này bị bỏ qua: không tô màu, và khi đổi thứ tự ảnh thì số không được sửa theo, nên có thể **trỏ nhầm nhân vật**.
- Tag trong ô prompt nổi bật hơn: nền màu đậm hơn và có viền mảnh cùng màu.

🛠️ **Ô tên cảnh gọn lại**
- Thẻ cảnh chưa đặt tên không còn hiện khối "Chưa đặt tên" to. Rê chuột lên thẻ mới hiện dòng chữ nhỏ "Bấm đúp để đặt tên". Tên đã đặt hiện gọn trên một dòng.

🛠️ Thư mục `release/` tự gọn sau mỗi lần build: ngoài cùng chỉ còn bản mới nhất, bản cũ nằm trong `release/ban-cu/<phiên bản>/`.

## [0.2.3] — 2026-10-02

✨ **Trình phát mini ngay trên node Video**
- Rê chuột lên node để xem video có tiếng. Thanh điều khiển ở đáy video gồm:
  - **thanh thời gian**: bấm hoặc kéo để tua, hiện giờ tại vị trí chuột;
  - **phát / dừng**;
  - **tốc độ**: 0,5×, 0,75×, 1×, 1,25×, 1,5×, 2×;
  - **âm lượng**: bấm loa để tắt/bật, kéo thanh hoặc lăn chuột để chỉnh.
- Đã bấm vào điều khiển thì video **giữ mở** kể cả khi chuột rời node; bấm ra chỗ trống trên canvas để đóng. Rê sang node khác thì video đang mở tự dừng, nên không bao giờ hai video cùng kêu.
- Mở lại node thì video phát tiếp từ chỗ đang xem.
- Âm lượng và tốc độ được nhớ trên máy, dùng chung với cửa sổ xem take. Phát liền ở Storyboard dùng chung âm lượng, giữ tốc độ thường.

🐞 **Sửa lỗi**
- Cài đặt › Cổng canvasapp: dòng "Đã đăng nhập canvasapp" không còn bị bóp méo hay đè chữ khi cửa sổ hẹp; các nút tự xuống dòng riêng.

## [0.2.2] — 2026-10-02

✨ **Xem video có tiếng**
- Xem trước khi rê chuột lên node, cửa sổ xem take và **Phát liền** ở Storyboard giờ phát có tiếng. Trước đây cả ba đều tắt tiếng cố định.
- Có nút loa để bật/tắt tiếng, một công tắc dùng chung và được nhớ trên máy.
- Bản desktop cho phép video tự phát có tiếng. Bản web: nếu trình duyệt chặn tiếng khi chưa bấm gì thì video phát không tiếng, bấm loa một lần là có tiếng.

## [0.2.1] — 2026-10-02

🐞 **Sửa lỗi "Invalid canvas payload" khi gửi sang canvasapp.io.vn**
- Canvas cầu nối và yêu cầu tạo video giờ gửi **đúng định dạng của trang canvasapp gốc**:
  - trường khung nhìn (viewport) đúng tên;
  - node video chỉ còn 6 trường dữ liệu và đúng kích thước;
  - mã node và mã yêu cầu dạng UUID, cố định theo cảnh / theo take;
  - khung cuối mang số thứ tự 2.
- Canvas bị canvasapp từ chối không còn làm hỏng các lần gửi sau.
- Thông báo lỗi ghi rõ yêu cầu nào, mã lỗi HTTP và chi tiết từng trường, để dễ báo lỗi.
- App đọc danh sách model / chế độ canvasapp đang mở trước khi gửi.
- Tổng số ảnh trên canvas cầu nối giữ trong giới hạn 30 như trang gốc, ảnh dùng chung một node.
- Hết credit thì không tải lại ảnh không cần thiết sau khi nạp.

⚠️ Đây là bản đầu tiên tạo video thật thành công qua canvasapp (đã thử với credit thật).

## [0.2.0] — 2026-10-02

✨ **Cổng canvasapp.io.vn (chỉ bản desktop, thử nghiệm)**
- Đăng nhập trên trang thật của canvasapp trong cửa sổ riêng. SanoVids không bao giờ thấy mật khẩu.
- Tạo video bằng tài khoản canvasapp của chính bạn, trừ **credit thật**.
- Ô credit tách bạch **DEMO** (credit giả lập) và **canvasapp** (credit thật).

✨ **Nạp credit trong app**
- Nút **+** cạnh ô credit, hoặc Cài đặt → **Nạp credit**. Thanh toán bằng **QR SePay**, bạn tự quét.
- App chỉ mở trang của sepay.vn và chỉ báo "Đã nhận tiền" khi canvasapp xác nhận.
- Xem **Lịch sử credit** trong app.

✨ **Đồng bộ nhân vật chặt chẽ**
- `@image_N` không có ảnh thật đi kèm thì bị tô đỏ và chặn nút Chạy. Các trường hợp: vượt số ảnh, vượt giới hạn của model, chế độ không gửi ảnh, dấu chờ `@image_?N`.
- Take gửi đúng bộ ảnh chụp lúc bấm Chạy.
- "Viết prompt trước, nối ảnh sau" vẫn khớp số.
- Có cảnh báo khi tắt "tự đánh lại số".

✨ **An toàn tiền** (đã thử toàn bộ với canvasapp giả lập)
- Mất mạng lúc gửi: không bao giờ tự gửi thành job mới. Gửi lại dùng cùng mã yêu cầu và tìm job cũ trước.
- Video đã trả tiền mà tải về lỗi thì app tự thử tải lại.
- Đổi dự án, xoá cảnh hay huỷ không làm mất job hoặc gửi nhầm job.

🐞 **Sửa lỗi giao diện**
- Kéo một thẻ mới thêm vào cảnh không còn nối cả loạt thẻ vừa thêm.
- Bấm `C` không kéo theo các thẻ đã chọn từ trước trong thư viện.
- "Chạy lại" và "Thử lại" luôn qua bảng chi phí, bấm đúp không bị chạy hai lần.
- Nút Chạy khoá kèm lý do khi cảnh chưa chạy được.

📄 Danh sách tự kiểm tra với credit thật: [docs/TEST-REAL-CREDITS.md](docs/TEST-REAL-CREDITS.md).

⚠️ **Lỗi đã biết:** gửi sang canvasapp bị từ chối "Invalid canvas payload" (không trừ credit). Đã sửa ở **0.2.1**. Đừng dùng bản này cho cổng canvasapp.

## [0.1.0] — 2026-10-02

Bản `.exe` đầu tiên. Gồm toàn bộ quá trình làm từ bản demo đầu tiên (chỉ có nhà cung cấp video giả lập).

**2026-10-01: bản demo đầu tiên**
- ✨ Canvas node: cảnh, thư viện nhân vật / bối cảnh / đạo cụ, nối ảnh tham chiếu bằng dây hoặc kéo thả, **nối hàng loạt** (`C`).
- ✨ Hàng đợi chạy giả lập, bảng xác nhận chi phí, **Bảng cảnh**, **Storyboard** (Phát liền), hoàn tác / làm lại.

**v2: node Video & `@image_N` / `@video_N`**
- ✨ Mỗi lần tạo video sinh ra một **node Video** nối từ cảnh. Kéo node Video sang cảnh khác để dùng làm `@video_N`, thả ra chỗ trống để tạo **cảnh tiếp nối**.
- 🛠️ Bỏ khối prompt và đoạn tham chiếu tự động. Prompt gửi đúng như viết, ảnh đánh số `@image_1`, `@image_2`… và **tự đánh lại số** khi đổi tham chiếu.
- ✨ Lưu bằng IndexedDB, cài như app (PWA), đóng gói **file `.exe`** cho Windows. Kéo đổi độ rộng hai thanh bên.

**Tải video & đổi tên**
- ✨ Nút **"Tải video"** to dưới mỗi node, tải hàng loạt (.zip), tự tải khi tạo xong.
- 🛠️ Đổi tên ứng dụng thành **SanoVids**. Ảnh đại diện vuông, **đổi kích thước node**.
- 🐞 Không tự tham chiếu video của chính cảnh. Huỷ xoá thì không xoá gì. Khôi phục take đánh lại số đúng.

**Web & ảnh tham chiếu**
- ✨ Bản web trên Cloudflare Workers.
- 🐞 Nối (C) không còn nối thừa ảnh: chọn 3 ảnh thì chỉ nối 3, không gộp lựa chọn cũ trong thư viện.
- ✨ Ảnh tham chiếu hiện **đủ cả tấm theo đúng tỉ lệ** (canvas, thư viện, inspector), cửa sổ phóng to ảnh, xem trước khi rê chuột.

**Giao diện kiểu Apple**
- ✨ Giao diện kiểu Apple, chế độ **Sáng / Tối / Theo hệ thống**.
- 🐞 Rà soát lỗi toàn app, kiểm chứng từng lỗi.
- 🛠️ Nền tảng cổng canvasapp (tắt mặc định).

[0.2.5]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.5
[0.2.4]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.4
[0.2.3]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.3
[0.2.2]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.2
[0.2.1]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.1
[0.2.0]: https://github.com/JameSteven404/sanovids/releases/tag/v0.2.0
[0.1.0]: https://github.com/JameSteven404/sanovids/releases/tag/v0.1.0
