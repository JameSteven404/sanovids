# Cổng canvasapp.io.vn → SanoVids (nền tảng, thử nghiệm)

> **Trạng thái:** phần nền (foundation). Mặc định **TẮT** — SanoVids vẫn dùng *Demo giả lập* (không mạng, không tốn tiền).
> Cổng chỉ chạy trong **bản desktop (.exe)** và chỉ khi người dùng tự chọn trong Cài đặt.
> Chưa được thử với máy chủ thật: mọi chỗ ghi **VERIFY** cần kiểm tra theo kế hoạch thử ở cuối tài liệu.

## 1. Mục đích

Cho phép tạo **video thật** từ SanoVids bằng **tài khoản canvasapp.io.vn của chính người dùng**: SanoVids gửi prompt
(`@image_N`) + ảnh tham chiếu sang canvasapp, theo dõi tiến độ, tải MP4 về thành *take* trên canvas — giống như đang
bấm "Tạo video" trên canvasapp, nhưng quản lý theo cảnh trong SanoVids.

Nguyên tắc an toàn (bắt buộc):

- **Không bao giờ** nhận, hiển thị hay lưu mật khẩu canvasapp. Đăng nhập diễn ra trên **trang thật** của canvasapp trong
  một cửa sổ riêng; cookie nằm trong một phân vùng phiên riêng (`persist:canvasapp`) mà trang SanoVids không đọc được.
- **Không** né Cloudflare, CSRF hay giới hạn tần suất. Không giả mạo `Origin`/`Referer`/User-Agent. Header
  `X-CSRF-Token` được lấy từ cookie `canvas_csrf` của chính phiên đó — đúng như trang canvasapp tự làm.
- Nhẹ nhàng với máy chủ: tối đa **2 job** cùng lúc, kiểm tra tiến độ **≥ 15 giây/lần** (mặc định 20 s; trang canvasapp
  tự kiểm tra 60 s/lần), tải ảnh lên tuần tự và chỉ một lần cho mỗi ảnh.
- Đây là **API nội bộ không chính thức** của canvasapp. Chỉ dùng khi đã được bên vận hành canvasapp.io.vn cho phép.

## 2. Kiến trúc

```
 ┌──────────────────────────── Renderer (trang SanoVids, app://bdp) ────────────────────────────┐
 │                                                                                              │
 │  UI (Run, Settings › GatewaySection)                                                          │
 │        │ enqueue / cancel / retry                                                             │
 │        ▼                                                                                      │
 │  store/runs.ts  ── queue engine (tick 200 ms) ────────────────┐                               │
 │        │ submit(JobRequest) / poll(remoteIds) / fetchResult()   │ putBlob → posterId/videoId    │
 │        ▼                                                        ▼                               │
 │  providers/index.ts  (registry + "provider cho take mới")     lib/imageStore (IndexedDB)       │
 │        ├── providers/mock.ts ── lib/mockProvider.ts (canvas → poster + webm)                    │
 │        └── providers/canvasapp/adapter.ts                                                      │
 │               ├── mapping.ts   (THUẦN: JobRequest → body, job → status, bridge canvas)          │
 │               ├── api.ts       (endpoint có kiểu + map lỗi, 401 → 'login-required')             │
 │               └── transport.ts (window.bdpDesktop.canvasapp — web: "không khả dụng")            │
 └───────────────────────────────────────────────│──────────────────────────────────────────────┘
                                                 │ IPC (contextBridge, electron/preload.cjs)
 ┌───────────────────────────── Electron main (electron/main.cjs) ──────────────────────────────┐
 │  canvasapp:status | canvasapp:login | canvasapp:logout | canvasapp:request                     │
 │   • chỉ nhận lời gọi từ app://bdp/…                                                             │
 │   • allowlist method + path (+ query project_id), id chỉ gồm [A-Za-z0-9_-]                     │
 │   • thêm X-CSRF-Token từ cookie canvas_csrf; JSON ≤ 2 MB, ảnh ≤ 20 MB (multipart tự dựng)       │
 │   • tối đa 2 request song song; GET /api/video-jobs được cache 15 s                             │
 │   • session.fromPartition('persist:canvasapp').fetch(…)  (Electron 44: Session.fetch)           │
 │   • cửa sổ đăng nhập = trang thật https://canvasapp.io.vn/ trong cùng phân vùng                 │
 └───────────────────────────────────────────────│──────────────────────────────────────────────┘
                                                 ▼
                                   https://canvasapp.io.vn/api/…
```

Giao diện nhà cung cấp (`src/providers/types.ts`):

| Hàm | Ý nghĩa |
|---|---|
| `available()` | `{ok, reason?}` — canvasapp: có bridge desktop **và** `/api/auth/state` báo đã đăng nhập |
| `capabilities(model)` | giới hạn (modes, durations, resolutions, ratios, ảnh/video tối đa, prompt, concurrency, chu kỳ poll) |
| `submit(JobRequest)` | → `{ remoteId }` (lưu trên take: `take.remoteId`) |
| `poll(remoteIds)` | → `[{remoteId, state, progress?, error?}]` |
| `fetchResult(remoteId)` | → `{ video: Blob, poster?: Blob }` (thiếu poster → engine tự cắt khung hình từ video) |
| `cancel?(remoteId)` | mock: có. canvasapp: **không** (xem §6) |

Trường mới trên take (tuỳ chọn, tương thích ngược — take cũ không có = demo):
`provider` (`'mock' | 'canvasapp'`), `remoteId`, `charged` (đã trừ credit demo hay chưa → có hoàn khi lỗi/huỷ hay không),
`framesSnapshot` (khung đầu/cuối lúc bấm chạy). Hiện khai báo ở `providers/types.ts` (`RunTake`); nên chuyển vào
`core/types.ts` + `migrateTake` (xem TODO).

## 3. Ánh xạ dữ liệu

### 3.1 SanoVids → `POST /api/video-jobs`

| SanoVids (`JobRequest`, dựng từ snapshot của take) | canvasapp | Ghi chú |
|---|---|---|
| `take.id` | `client_request_id` | khoá idempotency: gửi lại cùng take không được tạo job thứ hai (**VERIFY** server tôn trọng) |
| `settings.model` `seedance_2_5` / `minimax_h3` | `model_profile` | trùng tên |
| `settings.mode` `t2v` / `i2v` / `transform` | `mode` | trùng tên |
| `settings.duration` | `duration` (số) | |
| `settings.resolution` | `resolution` | `480p/720p/1080p`, `768p/2k` |
| `settings.ratio` | `aspect_ratio` | |
| `promptSnapshot` (prompt đã biên dịch) | `prompt` | gửi nguyên văn, giữ `@image_N` |
| ảnh `@image_1…N` (thứ tự `scene.refs`, mỗi ảnh của nhân vật một số) | `upload_ids[]` **đúng thứ tự N** | ảnh tải lên `/api/uploads/images` một lần, cache theo `imageId` |
| khung đầu / cuối (H3 transform, ảnh chính của asset) | `first_frame_upload_id` / `last_frame_upload_id` | transform: `upload_ids = []` |
| cảnh (`sceneId`) | `canvas_node_id = "sv_<sceneId>"` | node video tồn tại trong canvas "SanoVids bridge" |
| — | `project_id` | phiên "SanoVids bridge" (tạo một lần, nhớ id) |
| — | `generate_audio: true` | mặc định như trang canvasapp |
| `@video_N` (video tham chiếu) | *không có* | **chưa hỗ trợ** → cảnh bị bỏ qua với lý do rõ ràng, không tốn credit |

### 3.2 Canvas cầu nối (`PUT /api/projects/{id}/canvas`)

Trang canvasapp lưu canvas trước khi tạo job, nên máy chủ có thể yêu cầu `canvas_node_id` có thật. SanoVids dựng canvas tối thiểu:

- 1 node `video` / cảnh: `{ id: "sv_<sceneId>", type: "video", data: { model_profile, duration, resolution, aspect_ratio, mode, prompt } }`.
- 1 node `images` / ảnh: `{ id: "sv_<sceneId>_r<N>", type: "images", data: { upload_ids: [uploadId] } }` (+ `_ff`, `_lf` cho khung).
- connection: `{ from: imageNode, to: videoNode, target_handle: "reference" | "first_frame" | "last_frame", order }`,
  `order = N` (`ORDER_BASE = 1`, **VERIFY** 0 hay 1).
- Giới hạn 40 node: giữ các cảnh gửi gần nhất, bỏ cảnh cũ.

### 3.3 Trạng thái job → take

| canvasapp `status` | Take |
|---|---|
| `queued` | processing (tiến độ ≥ 1%) |
| `processing` (+`progress`) | processing, % theo `progress` (kẹp 1–99) |
| `completed` + `download_available` ≠ false | tải `/stream` → **completed** (poster cắt từ video) |
| `completed` + `download_available = false` | processing 99% |
| `failed` | failed, lỗi = `canvasapp: <error_message>` |
| `expired` | failed ("đã hết hạn") |
| `cancelled` | cancelled |
| không thấy trong danh sách 3 lần liên tiếp | failed ("không thấy job…") |

## 4. Các luồng

**Đăng nhập** — Cài đặt › "Đăng nhập canvasapp" → `canvasapp:login` → nếu đã đăng nhập thì trả ngay; nếu chưa, mở cửa
sổ `https://canvasapp.io.vn/` (phân vùng `persist:canvasapp`, sandbox, không preload). Người dùng đăng nhập như bình thường
(email/mật khẩu hoặc Google). Main kiểm tra `GET /api/auth/state` khi trang điều hướng và mỗi 5 s; khi `authenticated`
→ đóng cửa sổ và trả `{ok:true, authenticated:true}`. Đóng cửa sổ giữa chừng → trả trạng thái hiện tại.

**Đăng xuất** — `canvasapp:logout` xoá cookie/storage/cache của phân vùng; renderer gọi `canvasappProvider().reset()`
(quên phiên cầu nối + cache upload) và chuyển về Demo giả lập.

**Gửi (submit)** — runs engine chọn take `queued` (≤ 2 take canvasapp đang chạy) → `processing` → `submit(req)`:
1. kiểm tra (`validateRequest`): prompt, giới hạn ký tự (H3 t2v/i2v 7.000), video tham chiếu, i2v cần ảnh, transform cần 2 khung, tuỳ chọn của `/api/video-profiles` nếu đã tải;
2. phiên "SanoVids bridge": dùng id đã nhớ → nếu chưa có thì tìm theo tên → nếu chưa có thì tạo;
3. tải lên các ảnh chưa có trong cache (tuần tự; chỉ JPG/PNG/WEBP);
4. `PUT …/canvas` (404 → tạo lại phiên một lần);
5. `POST /api/video-jobs` → `job_id` → `remoteId = "<project_id>:<job_id>"` lưu vào take.
Các lần submit được xếp hàng nối tiếp (không chen nhau). Lỗi → take `failed` với lý do tiếng Việt (không trừ credit demo).

**Theo dõi (poll)** — mỗi nhà cung cấp một lời gọi: canvasapp gom mọi take đang chạy thành **1** `GET /api/video-jobs?project_id=…`,
không sớm hơn 20 s (engine ép tối thiểu 15 s; adapter cache 15 s; main cache 15 s). Lỗi khi poll (mạng, 401, 429…) **không**
làm hỏng take: engine giữ take đang chạy, nghỉ 1 → 2 → 4 → … tối đa 10 phút, và đặt `useRuns.providerIssue` để UI báo.

**Tải kết quả** — `completed` → `GET /api/video-jobs/{job_id}/stream` (nhị phân qua IPC) → Blob `video/mp4` → engine cắt
poster (≤ 640 px, `providers/poster.ts`) → `putBlob` → take `completed` (+ tự tải về máy nếu bật "Tự tải video").

**Mở lại app** — take canvasapp đang `processing` có `remoteId` được giữ nguyên và **tiếp tục poll** (không gửi lại = không
trả tiền hai lần). Take đang gửi dở (chưa có `remoteId`) được gửi lại với cùng `client_request_id`.

## 5. Credit

- Take canvasapp **không** trừ credit demo của SanoVids (`charged: false`) và không được "hoàn" khi lỗi — tiền thật nằm ở
  tài khoản canvasapp (hiện ở Cài đặt, từ `GET /api/me` → `credits_balance`; 1 credit ≈ 1.000đ).
- Bảng giá trong `core/models.ts` trùng với canvasapp nên ước tính trong hộp xác nhận vẫn đúng.

## 6. Giới hạn & rủi ro

| Rủi ro | Cách xử lý hiện tại |
|---|---|
| API nội bộ, có thể đổi bất cứ lúc nào | mọi giả định gom ở `mapping.ts`/`api.ts`, có test; lỗi định dạng → `bad-response` rõ ràng |
| Điều khoản sử dụng / quyền của bên vận hành | cảnh báo trong Cài đặt; tắt mặc định; **xin phép trước khi dùng**. Nếu canvasapp có API chính thức, thay `transport.ts` + `api.ts` |
| Giới hạn tần suất, Cloudflare | ≤ 2 request song song, ≤ 2 job, poll ≥ 15 s, cache danh sách job; 429 → nghỉ dần. Không có cơ chế vượt Cloudflare: nếu bị chặn thì dừng |
| CSRF / Origin | gửi `X-CSRF-Token` từ cookie; **không** giả `Origin`. Nếu máy chủ bắt buộc `Origin` = canvasapp → nhận 403 → cần bên vận hành hỗ trợ |
| Trả tiền hai lần | `client_request_id = take.id`; không gửi lại take đã có `remoteId`; thiếu `job_id` trong phản hồi → báo lỗi và khuyên kiểm tra trên canvasapp trước khi chạy lại |
| 401 (hết phiên) | submit: take `failed` "Chưa đăng nhập…" (không tốn credit); poll: take giữ nguyên, `providerIssue` báo đăng nhập lại, poll tự tiếp tục sau khi đăng nhập |
| Huỷ | canvasapp không có API huỷ rõ ràng (`DELETE` có thể không hoàn tiền) → huỷ trong SanoVids **chỉ ngừng theo dõi**; job vẫn chạy và tính tiền trên canvasapp |
| Google chặn đăng nhập trong cửa sổ nhúng | dùng email/mật khẩu trên trang canvasapp; không giả User-Agent |
| Video lớn qua IPC | MP4 đi qua IPC dạng bytes (giới hạn 10 phút). Video rất lớn → TODO ghi thẳng ra đĩa |
| Người dùng sửa phiên "SanoVids bridge" trên canvasapp | canvas bị ghi đè ở lần gửi sau. Đừng chỉnh phiên này bằng tay |

## 7. Bật thử

1. Chạy bản desktop: `npm run desktop` (hoặc cài `SanoVids-Setup-*.exe`).
2. Lead mount `GatewaySection` (từ `src/components/dialogs/GatewaySection.tsx`) vào hộp Cài đặt.
3. Cài đặt › **Cổng canvasapp.io.vn (thử nghiệm)** › **Đăng nhập canvasapp** → đăng nhập trên trang canvasapp → cửa sổ tự đóng, thấy số credit.
4. Chọn **canvasapp.io.vn** ở "Nhà cung cấp video cho take mới". Từ giờ take **mới** đi qua canvasapp; take đang chạy giữ nơi đã gửi.
5. Muốn quay lại: chọn **Demo giả lập** hoặc **Đăng xuất**.

## 8. Còn phải làm (TODO)

- [ ] Lead: mount `GatewaySection` trong `SettingsDialog`; thêm `canvasapp?: CanvasappBridge` vào `DesktopInfo` (`lib/pwa.ts`).
- [ ] Lead: chuyển `provider`, `remoteId`, `charged`, `framesSnapshot` vào `Take` (`core/types.ts`) + giá trị mặc định trong `migrateTake`.
- [ ] UI: nhãn nhà cung cấp trên take node / hàng đợi; hộp xác nhận chạy (RunConfirmDialog) ghi "credit canvasapp" thay vì credit demo khi đang dùng cổng, và không chặn vì thiếu credit demo; hiển thị `useRuns.providerIssue` (toast/banner "Đăng nhập lại canvasapp").
- [ ] Nạp `/api/video-profiles` khi đăng nhập (`canvasappProvider().refreshProfiles()`) và dùng `capabilities()` để giới hạn lựa chọn model/mode trong inspector.
- [ ] VERIFY với máy chủ thật: dạng phản hồi `POST /api/video-jobs`; `order` 0 hay 1; máy chủ có dedupe `client_request_id` không; `GET /api/projects` trả mảng hay `{projects}`; canvas tối thiểu có đủ trường không; `/stream` có chuyển hướng không.
- [ ] Video tham chiếu `@video_N`: tìm cách canvasapp nhận video (nếu có) rồi mở `maxRefVideos`.
- [ ] Tải video lớn: stream thẳng ra file trong main thay vì bytes qua IPC; dùng `download-token` nếu cần.
- [ ] Đồng bộ ngược: nhập các job đã tạo trên canvasapp (trong phiên bridge) thành take.
- [ ] Khi có API chính thức / token từ bên vận hành: thay `transport.ts` (vd. HTTP + API key do người dùng nhập, lưu bằng `safeStorage`), giữ nguyên `adapter`/`mapping`.

## 9. Kế hoạch thử thủ công (cho người dùng)

Chuẩn bị: tài khoản canvasapp có ít credit (≥ 30), bản desktop mới build, một dự án SanoVids có 2–3 cảnh ngắn (5 s, độ phân giải thấp nhất để rẻ).

1. **Mặc định an toàn** — mở Cài đặt: "Demo giả lập" đang chọn. Chạy 1 cảnh → video demo như cũ, credit demo bị trừ.
2. **Bản web** — mở bản web: nút "canvasapp.io.vn" bị khoá, có dòng giải thích chỉ dùng trong bản desktop.
3. **Đăng nhập** — bấm "Đăng nhập canvasapp": cửa sổ trang thật canvasapp mở ra; đăng nhập; cửa sổ tự đóng; Cài đặt hiện "Đã đăng nhập" + số credit đúng như trên canvasapp.
4. **Đóng giữa chừng** — Đăng xuất, bấm Đăng nhập rồi đóng cửa sổ khi chưa đăng nhập → trạng thái "Chưa đăng nhập", không lỗi.
5. **Một video t2v** — chọn canvasapp.io.vn; cảnh Seedance 2.5, 5 s, 480p, không ảnh. Chạy → take "đang tạo", % cập nhật khoảng 20 s/lần. Trên canvasapp.io.vn thấy phiên "SanoVids bridge" và job mới. Khi xong: take có poster + video MP4 phát được, nút "Tải video" lưu file .mp4. Credit canvasapp giảm đúng giá; credit demo SanoVids **không** đổi.
6. **Ảnh tham chiếu** — cảnh có 2 nhân vật (`@image_1`, `@image_2`). Chạy → trên canvasapp, job có 2 ảnh đúng thứ tự. Chạy lại lần 2 → ảnh **không** bị tải lên lại (xem phiên bridge chỉ có 2 upload).
7. **Hai job cùng lúc** — chạy 3 cảnh: chỉ 2 take "đang tạo", take thứ 3 chờ.
8. **Tắt app khi đang tạo** — trong lúc job chạy, đóng SanoVids, mở lại → take vẫn "đang tạo" và hoàn thành; trên canvasapp **không** có job trùng.
9. **Video tham chiếu** — cảnh có `@video_1`: bị bỏ qua với lý do "Cổng canvasapp chưa hỗ trợ video tham chiếu", không tốn credit.
10. **Hết phiên** — Đăng xuất trong lúc có take đang chạy → Cài đặt hiện cảnh báo đăng nhập lại; take không bị đánh lỗi; đăng nhập lại → take tiếp tục và hoàn thành.
11. **Huỷ** — huỷ take đang chạy: SanoVids ghi "Đã huỷ"; ghi nhận job trên canvasapp vẫn chạy (đúng như cảnh báo).
12. **Quay lại demo** — chọn Demo giả lập → take mới là demo, không gọi mạng.

Ghi lại mọi lỗi kèm thông báo hiển thị (và, nếu có, mã lỗi trong DevTools: `Ctrl+Shift+I` → Console).
