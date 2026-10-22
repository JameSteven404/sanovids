# UI mượt — tham khảo Magnific Spaces và ElevenLabs Flows

Yêu cầu của Minh (2026-10-22): Claude cùng Codex tham khảo giao diện hai trang dưới đây để áp dụng vào SanoVids, "muốn nó mượt như thế này".

- Magnific Spaces: `magnific.com/app/spaces/…` (một space có node "Video Generator").
- ElevenLabs Flows: `elevenlabs.io/app/flows/…` (một Flow trống).

Hai trang cần đăng nhập. Claude xem bằng Chrome của Minh, chỉ đọc: không tạo node, không chạy tạo video.

## 1. Đã quan sát (2026-10-22)

### Chung
- **Cùng loại thư viện với SanoVids.** ElevenLabs dùng React Flow (`react-flow flows-canvas`), Magnific dùng Vue Flow (bản Vue của React Flow). Vì vậy độ mượt không đến từ engine khác mà từ cách làm giao diện:
  1. Chuyển động ngắn, chỉ đổi màu / độ mờ / transform, không đổi kích thước hay vị trí bố cục.
  2. Thanh điều khiển nổi, trong suốt có blur, nên canvas tràn hết màn hình.
  3. Node gọn; thao tác chỉ hiện khi chọn hoặc rê chuột.
- Nền gần đen (#0F0F0F / #0F0F10), lưới chấm mờ.

### ElevenLabs Flows
- **Mọi thanh điều khiển là "viên nổi" trên canvas:**
  - nền xám (oklab L 0.30) ở độ đục 90%, `backdrop-filter: blur(12px)`;
  - bo 12px (nút), 16px (thanh công cụ), 20px (ô lệnh);
  - bóng rất nhẹ (đen 6%), viền trắng 7,5–10% thay cho viền cứng.
- **Bố cục:**
  - trái trên: "Flows ▾ | tên flow";
  - phải trên: "Create template", rồi một nhóm "100% ▾ · bình luận · tài sản · Share · avatar";
  - giữa dưới: thanh công cụ (Chọn, Kéo, Bình luận, nút "+" trắng tròn) và ô lệnh bên cạnh;
  - phải dưới: Feedback.
- **Phản hồi bấm / rê:** chỉ đổi màu, 75 ms, `cubic-bezier(0.4, 0, 0.2, 1)`.
- **Nút "+" (Add node):** popover gồm
  - ô "Search nodes, models…";
  - chip lọc Image / Video / Audio / Text;
  - danh sách theo nhóm có icon: Most used, Image, Video, Audio, Text, Other.
- Font Inter 13–14px; nút 32–36px.

### Magnific Spaces
- **Thanh công cụ dọc bên trái (dạng viên):** + · Chọn · Kéo tay · Cắt dây (kéo) · Khung/ghi chú · Bình luận · Hoàn tác · Làm lại · Cài đặt.
- **Các góc khác:** dưới trái "Page 1"; dưới phải Give feedback · bản đồ nhỏ · zoom "49% ▾".
- **Node:**
  - 204×190, bo 16px, nền #1A1A1A;
  - tên node nằm ngoài khung, phía trên góc trái ("Video Generator #1").
- **Khi chọn node:**
  - viền xanh 3px (#3B82F6), chuyển 150 ms;
  - một thanh thao tác nổi phía trên node: ▶ Chạy ▾ · nối ▾ · nhân bản · xoá · …;
  - các cổng vào (trái) và cổng ra (phải) hiện thành chấm tròn có icon theo loại (chữ, ảnh, video, âm thanh).
- **Trong node:** ô prompt, một hàng chip cấu hình (x1 · Auto · 16:9 · 5–6" · Auto · Sound) và nút chạy tròn ở góc phải dưới.
- **Đường gióng (helper lines):** hiện khi kéo node, vẽ trên một canvas riêng.
- **Chuyển động:**
  - transform / bóng: 200 ms ease-in-out;
  - viền / độ mờ / nền: 300 ms `cubic-bezier(0, 0, 0.2, 1)`;
  - nút: 150 ms.
- Font Geist.

## 2. Bảng việc

Việc chỉ tính là đã giao khi có dòng ở đây (quy trình Zalo của nhóm). Mỗi việc làm trên nhánh riêng; Claude soát rồi mới gộp vào `release/0.6.0`.

| Mã | Ai | Việc | Phạm vi file | Đầu ra | Cách kiểm | Trạng thái |
|---|---|---|---|---|---|---|
| UI-00 | Claude | Đo độ mượt hiện tại: pan, zoom, kéo node, chọn nhiều với 100–300 node; tìm chỗ render lại khi pan / zoom | chỉ đọc code; `src/perf/**` nếu cần thêm kịch bản | Bảng p50 / p95 và danh sách điểm nghẽn (file:dòng) | `npm run perf:build`, `perf:serve`, `perf:run` cỡ M / L / XL | Đã đo M / L (mục 3) |
| UI-01 | Codex | Mockup HTML tĩnh "canvas SanoVids kiểu mới" theo mục 1, giữ màu thiết kế D (đỏ Sano, 3 nền tối, nền sáng). Gồm: (a) thanh điều khiển nổi (tên dự án, nhóm phải trên, thanh công cụ, zoom ▾); (b) node cảnh / ảnh / video gọn, bo 16px, tên ngoài khung, thanh thao tác nổi khi chọn, cổng có icon; (c) popover "+ Thêm" có ô tìm, chip lọc, danh sách nhóm; (d) đường gióng khi kéo; (e) bảng thời gian chuyển động đề xuất | thư mục mockup riêng (không phải mã app) | `index.html` mở được không cần mạng + mục "Số đo cho người làm app" | Claude mở thử ở cả Tối / Sáng và bề rộng 1280 / 1920 | Xong, chờ Minh duyệt |
| UI-02 | Claude | Token và kiểu "viên nổi" cho thanh trên cùng / thanh công cụ / zoom | `src/styles/base.css`, `toolbar.css`, `topbar.css`, `TopBar.tsx` (bọc cụm thành `.tb-pill`) | Thanh trên cùng trong suốt, 3 cụm nổi; thanh công cụ + khay cùng kiểu; bố cục giữ nguyên (thanh vẫn ở trên, không đè canvas) | test màu (`noLiteralColors`, `designD`), `topbarLayout`; xem Tối / Sáng, 1440 / 1100 px | Xong |
| UI-03 | Claude | Thanh thao tác nổi trên node đang chọn + cổng có icon | `NodeActionBar.tsx` (mới), `NodeSizer.tsx` (`PortIcon`), 4 node, `ToolbarTray` / `toolbarModel` (bỏ trường hợp 1 video), `canvasContextMenu.openNodeMenu`, CSS | Cảnh: Chạy · Nhân bản · Xoá · ⋯; video: ★ · Tải / Chạy lại / Huỷ · Xoá · ⋯; ảnh: Ẩn · ⋯; thư mục: Xoá · ⋯. Chấm nối của node đang chọn hiện icon ảnh / video | vitest; thử trên app: Chạy mở hộp chi phí, ⋯ mở menu chuột phải | Xong |
| UI-04 | Claude | Popover "+ Thêm" có tìm kiếm | `AddPopover.tsx` + `addPopover.css` (chunk riêng), `addModel.ts` (+ test), `ToolbarBar.tsx`, `actions.pickImagesAt` (chuyển từ canvasMenu) | Ô tìm không dấu, chip Tất cả / Cảnh / Ảnh / Thư mục, nhóm Thường dùng (Cảnh tiếp theo, Cảnh trống, Ảnh từ máy) và Nhập & lưu (Nhập nhiều prompt, Thư mục lưu video); Enter chạy dòng đầu. Chưa có "Video đã tạo" (câu hỏi 4 của mockup chưa chốt) | vitest; thử trên app: tìm "thu muc", Esc trả focus, Cảnh trống + Ctrl+Z | Xong |
| UI-05 | — | Đường gióng khi kéo node | `components/canvas/**` | Chờ Minh duyệt UI-01 | vitest + perf không chậm hơn | Chờ duyệt |
| UI-06 | — | Thời gian chuyển động thống nhất (75–150 ms, chỉ màu / độ mờ / transform) | CSS các vùng | Chờ Minh duyệt UI-01 | perf + test giảm chuyển động (`data-motion`) | Chờ duyệt |

Quy tắc cho mọi người làm: đọc CLAUDE.md trước; chỉ sửa file trong phạm vi; không push; không chạy Electron hay trình duyệt trong sandbox; không gọi canvasapp.io.vn; không đụng `%APPDATA%\SanoVids`; chữ giao diện tiếng Việt.

## 3. Số đo hiện tại (UI-00, 2026-10-22)

`npm run perf:run -- --target web --size M|L --runs 3 --browser <Chrome>`, chạy ẩn (headless) trên máy của Minh trong lúc
máy còn chạy việc khác, nên chỉ dùng để so tương đối giữa các bài; ngân sách chính thức là của bản `.exe`.
Số là p95 `workMs` (React + layout của một bước, chưa tính vẽ). Một khung hình ở 60 Hz là 16,7 ms.

| Bài | M (300 cảnh) | L (600 cảnh) | Ngân sách M / L | Nhận xét |
|---|---|---|---|---|
| `zoom` (một bước thu phóng) | 28,4 | 51,8 | 7,2 / 12 | Chậm nhất: mỗi bước vượt một khung hình |
| `panFar` (kéo canvas ở zoom 0,15) | 16,6 | 29,4 | 6 / 10 | Nhìn xa: nhiều thẻ vào / ra khung |
| `pan04` (kéo ở zoom 0,4) | 10,8 | 26,9 | 3,6 / 6 | |
| `pan` (kéo ở zoom 1) | 5,1 | 9,1 | 3,6 / 6 | |
| `hover` (rê chuột qua thẻ) | 13,6 | 19,3 | 3,6 / 6 | Rê chuột còn làm React vẽ lại |
| `select` (chọn cảnh) | 37,2 | 31,3 | 18 / 30 | |
| `star` (bấm sao) | 16,2 | 28 | 4,8 / 8 | |
| `drag50` (kéo 50 thẻ) | 26 | 37,3 | 7,2 / 12 | |
| `lodSwitch` (qua lại ngưỡng 55%) | 45,9 | 30,3 | 18 / 30 | |
| `autosaveRuns` | 26,5 | 47,3 | 3,6 / 6 | |

Đã làm (22/10, theo yêu cầu "lăn chuột bị khựng"): con lăn mặc định kéo canvas (Ctrl + lăn để zoom, Cài đặt › Con lăn chuột); bỏ backdrop-filter lặp lại ở thẻ Thư viện (Layerize 168 → ~15 ms); mức xa / gần trì hoãn (`useFarView`); thẻ cảnh vào khung lúc đang di chuyển dựng khung trước (`useBodyReady`).

Hướng xử lý còn lại (làm cùng UI-03…UI-06, đo lại sau mỗi bước): rê chuột chỉ bằng CSS, không qua store; zoom / pan không làm
vẽ lại thẻ (chỉ thẻ vào / ra khung); thanh tiến độ dùng `transform: scaleX` thay cho `width`.
