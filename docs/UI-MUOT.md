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
| UI-00 | Claude | Đo độ mượt hiện tại: pan, zoom, kéo node, chọn nhiều với 100–300 node; tìm chỗ render lại khi pan / zoom | chỉ đọc code; `src/perf/**` nếu cần thêm kịch bản | Bảng p50 / p95 và danh sách điểm nghẽn (file:dòng) | `npm run perf:build`, `perf:serve`, `perf:run` cỡ M / L / XL | Đang làm |
| UI-01 | Codex | Mockup HTML tĩnh "canvas SanoVids kiểu mới" theo mục 1, giữ màu thiết kế D (đỏ Sano, 3 nền tối, nền sáng). Gồm: (a) thanh điều khiển nổi (tên dự án, nhóm phải trên, thanh công cụ, zoom ▾); (b) node cảnh / ảnh / video gọn, bo 16px, tên ngoài khung, thanh thao tác nổi khi chọn, cổng có icon; (c) popover "+ Thêm" có ô tìm, chip lọc, danh sách nhóm; (d) đường gióng khi kéo; (e) bảng thời gian chuyển động đề xuất | thư mục mockup riêng (không phải mã app) | `index.html` mở được không cần mạng + mục "Số đo cho người làm app" | Claude mở thử ở cả Tối / Sáng và bề rộng 1280 / 1920 | Đã giao |
| UI-02 | — | Token và kiểu "viên nổi" cho thanh trên cùng / thanh công cụ / zoom | `src/styles/base.css`, `toolbar.css`, `topbar.css` | Chờ Minh duyệt UI-01 | test màu (`noLiteralColors`, `designD`) | Chờ duyệt |
| UI-03 | — | Thanh thao tác nổi trên node đang chọn + cổng có icon | `components/canvas/**` | Chờ Minh duyệt UI-01 | vitest + kiểm trong trình duyệt | Chờ duyệt |
| UI-04 | — | Popover "+ Thêm" có tìm kiếm | `components/canvas/**` | Chờ Minh duyệt UI-01 | vitest + kiểm trong trình duyệt | Chờ duyệt |
| UI-05 | — | Đường gióng khi kéo node | `components/canvas/**` | Chờ Minh duyệt UI-01 | vitest + perf không chậm hơn | Chờ duyệt |
| UI-06 | — | Thời gian chuyển động thống nhất (75–150 ms, chỉ màu / độ mờ / transform) | CSS các vùng | Chờ Minh duyệt UI-01 | perf + test giảm chuyển động (`data-motion`) | Chờ duyệt |

Quy tắc cho mọi người làm: đọc CLAUDE.md trước; chỉ sửa file trong phạm vi; không push; không chạy Electron hay trình duyệt trong sandbox; không gọi canvasapp.io.vn; không đụng `%APPDATA%\SanoVids`; chữ giao diện tiếng Việt.
