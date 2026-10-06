# Bộ đo P1 · SanoVids 0.6.0

Chỉ chạy các lệnh mở GUI dưới đây **ngoài sandbox**, trên máy thử. Không chạy driver trong `npm test`.

```powershell
npm.cmd run perf:run -- --target web --size L --runs 3 --headed
npm.cmd run perf:run -- --target exe --size L --runs 3 --trace
npm.cmd run perf:run -- --target web --size L --headed --baseline .perf/report-web-L-....json
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

`typeNode`, `openEditor`, `closeEditor`, `panWithEditor`, `zoomWithEditor` ghi rõ chờ E2, không tính là bài đã đo.
E2 cần nối các kịch bản này sau khi có UI. B1 (Đợt 3) cần thêm kiểm tra số node mount lúc mở.
`tableScroll` / `storyboardOpen` lấy 60% baseline; `storyboardReorder` lấy baseline. Thiếu baseline: chưa có ngân sách.
So sánh từ chối khi khác tier/hash/máy/viewport/DPR/target/chế độ cửa sổ. Chậm hơn quá 15% hoặc vượt ngân sách
quá 10% trả mã 1; thiếu bài bắt buộc/lỗi trả 2. Mã 0 chỉ có nghĩa đạt các ngân sách hiện đã được cấu hình;
chưa gồm nghiệm thu tương tác bằng mắt, bài E2/B1 hoặc ngân sách tương đối nếu chưa cung cấp baseline.

Kiểm thử không mở GUI:

```powershell
npm.cmd run typecheck
npx.cmd vitest run --exclude ".claude/**" src/perf/__tests__ src/store/__tests__/persistProgress.test.ts src/components/dev/__tests__/devModel.test.ts scripts/__tests__/perfGuards.test.mjs
```

Nếu Windows chặn bước bundle cấu hình (`spawn EPERM`), thêm `--configLoader native --pool threads` cho Vitest.
Các guard kiểm cả archive ASAR thật và bundle Vite production/perf thật; không chạy Electron hay ký file.
