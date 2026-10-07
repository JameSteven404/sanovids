# Bộ đo P1 · SanoVids 0.6.0

Chỉ chạy các lệnh mở GUI dưới đây **ngoài sandbox**, trên máy thử. Không chạy driver trong `npm test`.

```powershell
npm.cmd run perf:run -- --target web --size L --runs 3 --headed
npm.cmd run perf:run -- --target exe --size L --runs 3 --trace
npm.cmd run perf:run -- --target web --size L --headed --baseline .perf/report-web-L-....json
# Ma trận gõ trên node: 300 / 1.000 / 3.000 cảnh (chạy riêng từng lệnh).
npm.cmd run perf:run -- --target web --size M --runs 3 --headed
npm.cmd run perf:run -- --target web --size XL --runs 3 --headed
npm.cmd run perf:run -- --target web --size XXL --runs 3 --headed
```

Chỉ thêm script `perf:*` theo quyền sở hữu P1; lệnh chạy là `perf:run` (thay cho tên `perf` trong bản kế hoạch).
Node 24 cung cấp WebSocket cho CDP. Web mặc định dùng Edge; có thể chọn Chromium bằng `--browser <đường dẫn>`.
Driver tự build, tạo profile mới trong `.perf/run-*`, chặn yêu cầu renderer ra ngoài origin thử,
ghi báo cáo `.perf/report-*.json`, dọn dữ liệu rồi đóng đúng tiến trình đã tạo và xoá profile tạm.
Nếu dọn thất bại do file còn bị khoá, driver báo lỗi và giữ thư mục để kiểm tra.

Target exe dựng `SanoVidsPerf`, appId riêng, profile thử được ghi vào package metadata; tắt ký bằng
`win.signExecutable: false`, giữ bước cập nhật resource/ASAR integrity. Không sửa chứng chỉ hay feed phát hành.
Target exe có cửa sổ hiện và là nơi đánh giá ngân sách chính thức. Target web/headless chỉ dùng kiểm nhanh.

Đo thủ công:

```powershell
npm.cmd run perf:build
npm.cmd run perf:serve
```

Mở `http://127.0.0.1:5191`, Bảng phát triển → Hiệu năng. Manifest được ghi trước mọi dữ liệu thử;
“Dọn dữ liệu thử nghiệm” xoá project, tombstone, media, key `bdp:perf:*` rồi trả về dự án trước đó.
Khi chạy, panel đóng tạm để không che bài đo; nút “Dừng đo hiệu năng” nổi ở góc dưới. Panel trở lại khi xong.
Đóng trang giữa chừng: mở lại origin thử và dùng nút dọn; manifest vẫn còn để phục hồi.

Mỗi bài làm nóng một lần, sau đó đo 3 lượt (có thể đổi `--runs`). `workMs` gồm flush React, microtask,
đo node React Flow và ép layout; không tính paint hoặc thời gian chờ rAF giữa các bước. Các bài mở màn hình
và lưu bất đồng bộ đo cả thời gian chờ tới ổn định/hoàn tất. `dom` dùng số phần tử, không phải mili giây.
Khung hình chỉ có khi cửa sổ hiện; headless ghi “ước lượng”. Profiler `CanvasInner` bao cả cây canvas;
khẳng định “CanvasInner không render” dùng probe của chính component, vì commit ở con không phải render ở cha.
Không xem một kịch bản chưa thực hiện được là “Đạt”. Cần thử driver trực tiếp để xác nhận selector và sự kiện kéo
trên Chromium/Electron thực tế. Không có số đo trước/sau hay tuyên bố đạt ngân sách từ unit test/build.

Các ID E2 cũ `typeNode`, `openEditor`, `closeEditor`, `panWithEditor`, `zoomWithEditor` giờ là bài bắt buộc.
Không còn kết quả “Chờ giao diện E2” được miễn lỗi. `tableScroll`, `storyboardOpen`, `storyboardReorder`,
`returnCanvas` đã bỏ cùng các view ẩn; hiện không có ngân sách tương đối. B1 cần thêm kiểm tra số node mount lúc mở.
So sánh từ chối khi khác tier/hash/máy/viewport/DPR/target/chế độ cửa sổ. Chậm hơn quá 15% hoặc vượt ngân sách
quá 10% trả mã 1; thiếu bài bắt buộc/lỗi trả 2. Mã 0 chỉ có nghĩa đạt các ngân sách hiện đã được cấu hình;
chưa gồm nghiệm thu tương tác bằng mắt hoặc kiểm tra số node mount của B1.

## Kịch bản canvas 0.6.0

Giữ `PerfReport.version = 1`, các trường JSON và ID cũ. Thêm tier `XXL` = 3.000 cảnh / 6.000 take;
M = 300 / 600, L = 600 / 1.200, XL = 1.000 / 3.000 giữ nguyên dữ liệu và hash. Tier XXL chọn bằng CLI
hoặc `sanovidsPerf.create('XXL')`; danh sách tier trong panel hiện vẫn chỉ có M/L/XL. API custom tối đa 3.000 cảnh,
6.000 take vẫn không gán ngân sách. Panel còn hint “chờ E2” và input `max=2000` tại
`src/components/dev/DevPerfTab.tsx:27,36` (ngoài phạm vi harness); dùng CLI/API cho ma trận trên.
So sánh baseline chỉ xét các ID có số đo ở cả hai báo cáo.

| ID ổn định | Thao tác và kiểm chứng | Ngân sách M / L / XL / XXL (p95 ms) |
| --- | --- | --- |
| `typeNode` | Click prompt trên node, chèn 120 ký tự qua textarea thật, cách nhau 30 ms; kiểm tra toàn bộ chữ và bản đã commit, đúng một editor | 3 / 5 / 10 / 20 |
| `openEditor` | 20 lần click prompt tĩnh thành editor; kiểm DOM và store | 36 / 60 / 120 / 240 |
| `closeEditor` | 20 lần Escape từ textarea; kiểm editor đã unmount và store đã đóng | 18 / 30 / 60 / 120 |
| `expandSettings` | 20 lần click dòng cấu hình; kiểm nhóm cấu hình xuất hiện; thu gọn giữa các mẫu | 36 / 60 / 120 / 240 |
| `panWithEditor` | 30 bước kéo viewport, giữ editor trong màn hình và đang mở | 4,2 / 7 / 14 / 28 |
| `zoomWithEditor` | 30 bước zoom 70–97%, giữ editor đang mở | 7,2 / 12 / 24 / 48 |
| `lodSwitch` | 30 bước 54% → 55% → 56% → 54%…; kiểm class `is-far` ở mỗi bước, đúng 55% là near | 18 / 30 / 60 / 120 |
| `librarySelect200` | Click mục đầu + Shift-click mục cuối, kiểm đúng 200 ID và 200 card được chọn | 60 / 100 / 200 / 400 |
| `libraryDelete200` | Chọn sẵn 200 mục, click nút xoá thư viện; kiểm đủ 200 mục biến mất, selection rỗng, cảnh giữ nguyên | 90 / 150 / 300 / 600 |
| `cutWire` | 20 lần gọi lệnh cắt dây của UI, kiểm mất ref, placeholder có tên ảnh và mark đỏ; hoàn tác giữa mẫu | 18 / 30 / 60 / 120 |
| `undoWire` | Cắt sẵn rồi đo 20 lần hoàn tác; kiểm prompt/ref trở lại và mark đỏ biến mất | 18 / 30 / 60 / 120 |

`typeNode` đo xử lý mỗi phím qua `work()` (React/layout), không tính thời gian chờ 30 ms, không phải độ trễ
từ bàn phím vật lý tới paint. `typeInspector` vẫn giữ ID cũ và mở khung soạn rộng ở bảng phải.
Các bài pan/zoom dùng React Flow `setViewport`, bài cắt/undo dùng lệnh ứng dụng; không đo hit-testing chuột
trên dây hoặc wheel input. Mở/đóng editor và settings dùng click/Escape trên DOM thật.
Setup và thao tác phục hồi giữa các mẫu nằm ngoài `workMs`; probe/frame tổng có thể bao gồm những thao tác đó.
Mỗi lượt đóng và flush editor trước khi phục hồi project, tránh nháp cũ lọt sang lượt sau.

Thư viện thêm tạm 200 mục **chưa dùng**, có ảnh chia sẻ từ fixture đã ghi manifest, không tạo blob mới;
12 mục gốc vẫn còn. Đây là đường xoá nhanh không cần xác nhận; xoá ảnh đang dùng có hộp xác nhận chưa được
đo ở bài này. Runner phục hồi project sau mỗi lượt. Selector sai, thiếu DOM hoặc thao tác không có tác dụng
đều làm bài `unavailable`, báo cáo không hoàn tất, driver trả mã 2.

Ngân sách mới là ngưỡng ban đầu trong `src/perf/budgets.ts`, chưa hiệu chỉnh bằng số đo GUI trên máy đích.
Không suy ra đạt ngân sách từ test headless. Ngưỡng frame hiện hữu cũng áp dụng cho `typeNode`, các bài kéo/zoom
khi sửa và LOD: median ≤ 17 ms, tối đa 5% frame > 33 ms, long frame ≤ 50 ms khi gõ / 100 ms khi kéo và zoom.

Kiểm thử không mở GUI:

```powershell
npm.cmd run typecheck
npx.cmd --offline vitest run --exclude ".claude/**" --pool threads src/perf/__tests__ scripts/perf/__tests__
npx.cmd --offline vitest run --exclude ".claude/**" --pool threads
```

Nếu Windows chặn bước bundle cấu hình (`spawn EPERM`), thêm `--configLoader native --pool threads` cho Vitest.
Các guard kiểm cả archive ASAR thật và bundle Vite production/perf thật; không chạy Electron hay ký file.

`canvasScenarios.timing.test.ts` chạy mặc định trong CI, dùng perf synth ở 300 / 1.000 / 3.000 cảnh,
mỗi phép đo làm nóng 3 lần rồi lấy 25 mẫu. Kiểm typing/compile + graph selector ổn định, open/close và flush nháp,
cấu hình + kích thước prompt, excerpt/highlight của 40 node qua LOD, chọn/xoá 200 mục và cắt ref/undo với
placeholder có nhãn. Assertions/setup nằm ngoài thời gian đo. Trần p95 **pure/store** riêng trong
`HEADLESS_BUDGETS`: 25 ms, riêng lập kế hoạch + xoá 200 mục và cắt ref là 50 ms; không phải ngân sách UI.
Test không mount React, không đo DOM/paint/IPC/ghi media. `typingPath.timing.test.ts` cũ vẫn là phép chẩn đoán
chi tiết dùng stress synth, chỉ chạy khi `SANOVIDS_TIMING=1`; nó không thay thế các gate mặc định mới.
