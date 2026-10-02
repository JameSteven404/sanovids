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
 │  canvasapp:checkout (nạp credit: cửa sổ modal trang SePay thật, xem §5b)                      │
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
| `recover?(req)` | tìm job mà một lần gửi trước của `req.key` có thể đã tạo (trang đóng/tải lại lúc gửi) — **không bao giờ** tạo job. canvasapp: có |

Trường mới trên take (tuỳ chọn, tương thích ngược — take cũ không có = demo):
`provider` (`'mock' | 'canvasapp'`), `remoteId`, `charged` (đã trừ credit demo hay chưa → có hoàn khi lỗi/huỷ hay không),
`framesSnapshot` (khung đầu/cuối lúc bấm chạy). Hiện khai báo ở `providers/types.ts` (`RunTake`); nên chuyển vào
`core/types.ts` + `migrateTake` (xem TODO).

## 3. Ánh xạ dữ liệu

### 3.1 SanoVids → `POST /api/video-jobs`

| SanoVids (`JobRequest`, dựng từ snapshot của take) | canvasapp | Ghi chú |
|---|---|---|
| `take.id` | `client_request_id = clientRequestIdFor(take.id)` (UUID, cố định theo take) | khoá idempotency: gửi lại cùng take luôn cùng khoá, không được tạo job thứ hai (**VERIFY** server tôn trọng). Sổ `jobs`/`sent` vẫn theo `take.id` |
| `settings.model` `seedance_2_5` / `minimax_h3` | `model_profile` | trùng tên |
| `settings.mode` `t2v` / `i2v` / `transform` | `mode` | trùng tên |
| `settings.duration` | `duration` (số) | |
| `settings.resolution` | `resolution` (chữ thường) | `480p/720p/1080p`, `768p/2k` |
| `settings.ratio` | `aspect_ratio` | không gửi với H3 transform (như trang canvasapp) |
| `promptSnapshot` (prompt đã biên dịch) | `prompt` | giữ nguyên `@image_N`, chỉ bỏ khoảng trắng hai đầu (như `runVideoNode()`); `promptSnapshot` không đổi |
| ảnh `@image_1…N` (thứ tự `scene.refs`, mỗi ảnh của nhân vật một số) | `upload_ids[]` **đúng thứ tự N** | Seedance và H3 i2v; H3 t2v gửi `upload_ids: []`. Ảnh tải lên `/api/uploads/images` một lần, cache theo `imageId` |
| khung đầu / cuối (H3 transform, ảnh chính của asset) | `first_frame_upload_id` / `last_frame_upload_id` | transform: **không** có `upload_ids`, **không** có `aspect_ratio` |
| cảnh (`sceneId`) | `canvas_node_id = canvasNodeId(sceneId)` (UUID, cố định theo cảnh) | node video tồn tại trong canvas "SanoVids bridge" |
| — | `project_id` | phiên "SanoVids bridge" (tạo một lần bằng `POST` không body rồi `PATCH {name}`, như trang canvasapp; nhớ id) |
| — | `generate_audio: true` | mặc định như trang canvasapp |
| `@video_N` (video tham chiếu) | *không có* | **chưa hỗ trợ** → cảnh bị bỏ qua với lý do rõ ràng, không tốn credit |

### 3.2 Canvas cầu nối (`PUT /api/projects/{id}/canvas`)

Trang canvasapp lưu canvas trước khi tạo job, nên máy chủ yêu cầu `canvas_node_id` có thật — và **kiểm tra chặt
dạng canvas**: bản v0.2.0 bị từ chối "Invalid canvas payload" vì thừa khoá `title`, viewport `{x, y, zoom}` và id
không phải UUID. Canvas tối thiểu giờ dựng **đúng từng khoá** như `canvasPayload()` của trang canvasapp
(chi tiết: `docs/canvasapp-api-notes.md`):

- 1 node `video` / cảnh: `{ id: canvasNodeId(sceneId), type: "video", x, y, w: 390, h: 600, data: { model_profile, duration, resolution, aspect_ratio, mode, prompt } }` — đúng 6 khoá trong `data`.
- 1 node `images` / ảnh đã tải lên: `{ id: imageNodeId(uploadId, occurrence), type: "images", x, y, data: { upload_ids: [uploadId] } }` (không có `w`/`h`). Ảnh nhân vật dùng ở nhiều cảnh = **một** node ảnh nối tới mọi node video dùng nó (trang canvasapp cho phép); chỉ tách node thứ hai khi một cảnh dùng cùng một ảnh hai lần (hoặc khung đầu = khung cuối).
- connection: `{ from: imageNode, to: videoNode, target_handle: "reference" | "first_frame" | "last_frame", order }`:
  tham chiếu `order = N` (1..N, đúng `@image_N`), `first_frame` 1, `last_frame` 2; H3 chỉ có cạnh tham chiếu khi ở i2v.
- `viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 }`. Mọi id là UUID (`uuidFromKey`, tất định), toạ độ là số nguyên.
- H3 transform: `aspect_ratio` của node = tỷ lệ chung của hai ảnh khung (như `setTransformFrame()`); hai khung khác tỷ lệ
  hoặc tỷ lệ ngoài danh sách (16:9, 9:16, 1:1, 4:3, 3:4, sai lệch ≤ 2 %) → từ chối trước khi tải ảnh, như trang canvasapp.
- Giới hạn như trang canvasapp: 40 node, **30 ảnh trên cả canvas** (`imageIds()` của trang đếm mọi `upload_ids`, kể cả
  trùng) — thêm 400.000 ký tự prompt: giữ các cảnh gửi gần nhất, bỏ cảnh cũ không còn vừa (cảnh mới nhất luôn giữ).
- Danh sách cảnh của canvas chỉ được nhớ **sau khi** canvasapp nhận `PUT`. Bị từ chối → thử lại một lần với riêng cảnh
  đang gửi (một cảnh cũ có thể là thứ bị từ chối, vd. ảnh đã hết hạn); vẫn bị từ chối → báo lỗi, không nhớ gì.
- Test: `canvasapp-mapping.test.ts` so khớp `Object.keys` từng phần; máy chủ giả trong `canvasapp-e2e.test.ts` từ chối
  mọi canvas / body lệch dạng và chạy nguyên khối `<canvasapp-routes>` của `electron/main.cjs`.

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
1. đọc `/api/video-profiles` (như trang canvasapp lúc mở; nhớ 10 phút; đọc hỏng → dùng cấu hình mặc định của trang:
   Seedance chạy, MiniMax-H3 tạm khoá, đọc lại sau 1 phút; 401 → báo đăng nhập) rồi kiểm tra (`validateRequest`): prompt,
   giới hạn ký tự (H3 t2v/i2v 7.000), video tham chiếu, i2v cần ảnh, transform cần 2 khung, `can_create`, chế độ đang
   tạm ngừng (`disabled_modes`), thời lượng / độ phân giải / tỷ lệ có trong cấu hình; H3 transform: hai khung cùng tỷ lệ;
2. phiên "SanoVids bridge": dùng id đã nhớ → nếu chưa có thì tìm theo tên → nếu chưa có thì tạo;
3. kiểm tra **mọi** ảnh có trong máy trước (thiếu ảnh → lỗi rõ ràng "Không tìm thấy ảnh tham chiếu @image_N…", chưa tải lên gì, chưa trả gì), rồi tải lên các ảnh chưa có trong cache (tuần tự; chỉ JPG/PNG/WEBP);
4. `PUT …/canvas` (404 → tạo lại phiên một lần; bị từ chối → thử lại một lần với riêng cảnh này). Lỗi ở bước này luôn
   ghi "Lưu canvas cầu nối … không thành công — chưa gửi yêu cầu tạo video, không bị trừ credit.";
5. ghi trước "đã gửi" (`sent[take.id]`, localStorage `bdp:canvasapp:jobs`) → `POST /api/video-jobs` → `job_id` →
   `remoteId = "<project_id>:<job_id>"` lưu vào take **và** vào sổ `jobs[take.id]` (đồng bộ, ngay khi có câu trả lời).
Các lần submit được xếp hàng nối tiếp (không chen nhau). Take bị huỷ (hoặc cảnh bị xoá) trong lúc chờ/đang tải ảnh →
dừng **trước** `POST`, không bị trừ credit (cảnh bị xoá: take quay lại hàng đợi, chạy tiếp nếu Hoàn tác). Lỗi chắc chắn
(401, 402/400 thiếu credit, 403, 404, 429, sai dữ liệu) → take `failed` với lý do tiếng Việt, không tự gửi lại. Lời báo
kèm `detail` của canvasapp (lỗi kiểm tra dữ liệu ghi cả trường, vd. `nodes.0.data.title: Extra inputs are not permitted`)
và yêu cầu nào bị từ chối, mã HTTP — không có id, query, cookie hay nội dung gửi đi, vd.
`[PUT /api/projects/{id}/canvas · HTTP 422]`. Thiếu credit (402, hoặc 400 mà `detail` nói về số dư) giữ cache ảnh.
`POST` không có câu trả lời rõ (mất mạng, quá giờ, 5xx, 200 mà không có `job_id`) → canvasapp **có thể đã tạo job**:
đợi 15 s, đọc danh sách job tìm đúng job đó (cùng `client_request_id` nếu danh sách có trường này, nếu không thì job
**duy nhất** mới xuất hiện trên node của cảnh, không thuộc take nào khác); đọc lần 2 sau 15 s nữa; không có → gửi lại
**một lần** với **cùng** body và `client_request_id`; vẫn không rõ → take `failed` với `UNKNOWN_SUBMIT_ERROR`
("không rõ đã trừ credit chưa"). `useRuns.retry(takeId)` cho take đó gửi lại **chính take đó** (cùng khoá; tìm job trước).

**Theo dõi (poll)** — mỗi nhà cung cấp một lời gọi: canvasapp gom mọi take đang chạy thành **1** `GET /api/video-jobs?project_id=…`,
không sớm hơn 20 s (engine ép tối thiểu 15 s; adapter cache 15 s; main cache 15 s, bỏ cache mỗi lần `POST /api/video-jobs`).
Lỗi khi poll (mạng, 401, 429…) **không** làm hỏng take: engine giữ take đang chạy, nghỉ 1 → 2 → 4 → … tối đa 10 phút, và
đặt `useRuns.providerIssue` để UI báo. Sau 401, đăng nhập lại (đọc được số dư) → hết nghỉ, poll lại ở lượt kế.

**Tải kết quả** — `completed` → `GET /api/video-jobs/{job_id}/stream` (nhị phân qua IPC) → Blob `video/mp4` → engine cắt
poster (≤ 640 px, `providers/poster.ts`) → `putBlob` → take `completed` (+ tự tải về máy nếu bật "Tự tải video").
Tải hỏng (mạng, phiên…) → take **vẫn** "đang tạo 99%" và thử lại sau 30 s, 1, 2, 5 phút; hỏng cả 5 lần → `failed` với lời
nhắn "đã tạo xong, đã trừ credit — tải trực tiếp trên canvasapp, chạy lại sẽ trừ thêm".

**Mở lại app / đổi dự án** — take canvasapp đang `processing` có `remoteId` được giữ nguyên và **tiếp tục poll** (không gửi
lại = không trả tiền hai lần). Take đang gửi dở (chưa có `remoteId` trên take — trang đóng/tải lại lúc gửi, hoặc lưu
chậm) → `provider.recover()`: lấy `jobs[take.id]` trong sổ, hoặc đợi lần gửi còn đang chạy, hoặc (có `sent[take.id]`) tìm
job trong danh sách như trên. Tìm thấy → poll tiếp; không thấy → `failed` với `UNKNOWN_SUBMIT_ERROR`. **Không bao giờ**
tự `POST` lại. Đổi sang dự án khác lúc đang gửi không huỷ lần gửi đó; mở lại dự án → take tìm lại job.

## 5. Credit

- Take canvasapp **không** trừ credit demo của SanoVids (`charged: false`) và không được "hoàn" khi lỗi — tiền thật nằm ở
  tài khoản canvasapp (hiện ở Cài đặt, từ `GET /api/me` → `credits_balance`; 1 credit ≈ 1.000đ).
- Bảng giá trong `core/models.ts` trùng với canvasapp nên ước tính trong hộp xác nhận vẫn đúng.

## 5b. Nạp credit (top-up tài khoản canvasapp của chính người dùng) — SPEC-v2 §10

SanoVids **không** có hệ thống credit riêng: "Nạp credit" chỉ mở đúng luồng nạp tiền của canvasapp.io.vn, trong app.

Quy tắc an toàn (bắt buộc):

- SanoVids **không bao giờ** thấy, hỏi hay gõ thông tin ngân hàng/thẻ. Người dùng tự trả trên **trang thật của SePay**
  (quét QR bằng app ngân hàng). SanoVids không chèn script, không điền gì, không bấm gì trên trang thanh toán.
- Chỉ mở URL thanh toán **do chính canvasapp trả về**, và chỉ khi URL là `https://` + host `sepay.vn` / `*.sepay.vn`
  (kiểm tra 2 lần: renderer `core/topup.ts checkoutUrlAllowed` và main `checkoutUrlAllowed` bản CJS — main không tin renderer).
- Không bao giờ tự xác nhận: "đã nhận tiền" chỉ khi canvasapp trả `status` = `paid` / `reconciled`.
- Test chỉ dùng transport/bridge giả, không gọi API thật.

Các mảnh:

| Mảnh | Nội dung |
|---|---|
| `src/core/topup.ts` (thuần, có test) | `TOPUP_PRESETS` 30k/50k/100k/200k; `validateTopupAmount` (số nguyên VND, 10.000–10.000.000, bội 1.000; nhận "50.000", "50,000", "50k", "1,5tr"); `creditsForAmount`; `formatVnd`; `mapTopupStatus` → `{ phase, label, final }`; `checkoutUrlAllowed`; `parsePaymentReturn`; `TOPUP_ORDER_TTL_MS` (10 phút), `TOPUP_POLL_MS` (2 s), `TOPUP_HISTORY_KINDS` |
| `api.ts` | `authState()` (`topup_enabled === true` mới mở nạp), `createTopup(amountVnd)` → `{ checkout_url, fields, order_id }`, `getTopup(orderId)` → `{ status, amount_vnd, … }`, `creditHistory({ kind, offset, limit })` → `{ balance, items, next_offset }`. Lỗi như mọi endpoint khác (401 → `login-required`) |
| `transport.ts` | `openCheckout({ checkoutUrl, fields })` → `{ result, orderId, blockedHost }`; từ chối trước khi gọi bridge nếu URL không phải SePay (`forbidden`), không có bridge (`unavailable`), bản desktop cũ chưa có `checkout` (`unsupported`), đang có cửa sổ thanh toán (`busy`) |
| `electron/main.cjs` | allowlist thêm `POST /api/payments/topups`, `GET /api/payments/topups/:id` (id `[A-Za-z0-9_-]`), `GET /api/credits/history` (chỉ query `kind` ∈ all/topup/video/refund/adjustment, `offset`, `limit` là số, mỗi khoá 1 lần). IPC `canvasapp:checkout` |
| `electron/preload.cjs` | `bdpDesktop.canvasapp.checkout({ checkoutUrl, fields })` |

Luồng:

```
Dialog "Nạp credit" ── authState(): đã đăng nhập + topup_enabled? ── không → nút khoá + giải thích
   │ validateTopupAmount("50k") → 50.000đ = 50 credit
   ▼
api.createTopup(50000) ──► POST /api/payments/topups {amount_vnd}  ──► { checkout_url, fields }
   │ checkoutUrlAllowed(checkout_url)? (không → báo, KHÔNG mở)
   ▼
openCheckout() ─IPC─► main: kiểm tra lại URL + fields ─► 1 cửa sổ modal "Thanh toán nạp credit"
                       (parent = cửa sổ chính, partition persist:canvasapp, sandbox, contextIsolation, không preload)
                       trang data: cục bộ tự POST form (mọi tên/giá trị được escape HTML; CSP: chỉ 1 script theo hash,
                       form-action chỉ *.sepay.vn + canvasapp) ─► trang SePay thật → người dùng tự quét QR
   ◄─ { result, orderId } khi cửa sổ quay về https://canvasapp.io.vn/…?payment=success|cancel|error&topup_order=<id>
      (chặn ở will-navigate/will-redirect, không tải trang canvasapp, đóng cửa sổ)
      | { result:'closed', orderId:null } người dùng đóng cửa sổ
      | { result:'timeout' } sau 15 phút (SanoVids đóng cửa sổ)
   ▼
poll api.getTopup(orderId) mỗi 3 s (đến hết hạn đơn 10 phút + 30 s; lỗi đọc → giãn dần, 5 lần liền / 401 → dừng, "Thử lại") → mapTopupStatus:
   pending → "Đang chờ thanh toán…" · paid/reconciled → "Đã nhận tiền ✓" → refreshRealCredits({ force: true })
   reconcile_required → "đang đối soát" (dừng poll, xem Lịch sử) · expired · rejected
```

Chính sách điều hướng của cửa sổ thanh toán (khung chính): cho phép `https://sepay.vn`, `https://*.sepay.vn` và
`https://canvasapp.io.vn`; URL quay về có `payment` + `topup_order` → kết thúc. Mọi thứ khác (trang khác, `http:`,
deep link app ngân hàng `xxx://`) → **chặn** và ghi `blockedHost` (chỉ tên host, không bao giờ cả URL). `window.open` →
không mở trong app; chỉ link `https` của SePay / canvasapp được mở bằng trình duyệt mặc định (link khác: chặn, ghi
`blockedHost`). Không `<webview>`. Tiêu đề cửa sổ giữ nguyên "Thanh toán nạp credit". Luật điều hướng nằm trong khối
`// <checkout-rules>` của `main.cjs` (`classifyCheckoutNavigation`, `checkoutExternalAllowed`) và được test chạy nguyên văn.

Quyền web trong partition `persist:canvasapp` (Electron mặc định cho **mọi** quyền): cửa sổ thanh toán chỉ được ghi
clipboard (nút "sao chép" số tài khoản / nội dung CK trên SePay); cửa sổ đăng nhập không được camera/mic, vị trí,
thông báo, chụp màn hình, `openExternal`, MIDI, HID/USB/serial…; không thiết bị nào được cấp (`setDevicePermissionHandler`
→ false); Web Bluetooth luôn huỷ chọn thiết bị.

**VERIFY** khi dùng thật lần đầu (tài khoản thật, nạp 10.000đ):

- [ ] `checkout_url` thật có host thuộc `sepay.vn` không (nếu khác → SanoVids từ chối; cập nhật `CHECKOUT_HOST_SUFFIX` ở **cả** `core/topup.ts` và `main.cjs` sau khi xác nhận là của SePay).
- [ ] `fields` chỉ gồm chuỗi/số, tên field nằm trong `[A-Za-z0-9_.[\]-]` (nếu không → `bad-response`).
- [ ] SePay có nhận POST từ trang `data:` (header `Origin: null`) không. Nếu bị từ chối: chuyển sang `webContents.loadURL(checkoutUrl, { postData })` — **không** giả `Origin`.
- [ ] Trang SePay có điều hướng khung chính sang host khác (cổng NAPAS/ngân hàng…) không → xem `blockedHost` trong kết quả; chỉ mở rộng allowlist sau khi xác nhận.
- [ ] URL quay về đúng dạng `https://canvasapp.io.vn/...?payment=…&topup_order=…`.
- [ ] Phản hồi `POST /api/payments/topups` có kèm mã đơn không (khoá nào: `order_id` / `topup_order` / `id`) — để vẫn poll được khi người dùng đóng cửa sổ sau khi đã trả.
- [ ] Dạng thật của `GET /api/payments/topups/{id}` và `GET /api/credits/history` (tên trường `delta`, `amount_vnd`, `next_offset`).
- [ ] Credit hiển thị trong SanoVids tăng đúng sau `paid` (so với trang canvasapp).

Thử thủ công thêm (§9): 13. Bản web: "Nạp credit" khoá kèm giải thích. 14. Nạp 10.000đ: cửa sổ SePay mở, quét QR, cửa sổ tự
đóng, "Đã nhận tiền ✓", số credit tăng 10. 15. Mở cửa sổ rồi đóng ngay → "đã huỷ/đóng", không trừ gì. 16. Bấm huỷ trên
SePay → kết quả `cancel`. 17. Để quá 10 phút → `expired`. 18. Lịch sử credit: lọc Nạp / Tạo video, "Xem thêm".

## 6. Giới hạn & rủi ro

| Rủi ro | Cách xử lý hiện tại |
|---|---|
| API nội bộ, có thể đổi bất cứ lúc nào | mọi giả định gom ở `mapping.ts`/`api.ts`, có test; lỗi định dạng → `bad-response` rõ ràng |
| Điều khoản sử dụng / quyền của bên vận hành | cảnh báo trong Cài đặt; tắt mặc định; **xin phép trước khi dùng**. Nếu canvasapp có API chính thức, thay `transport.ts` + `api.ts` |
| Giới hạn tần suất, Cloudflare | ≤ 2 request song song, ≤ 2 job, poll ≥ 15 s, cache danh sách job; 429 → nghỉ dần. Không có cơ chế vượt Cloudflare: nếu bị chặn thì dừng |
| CSRF / Origin | gửi `X-CSRF-Token` từ cookie; **không** giả `Origin`. Nếu máy chủ bắt buộc `Origin` = canvasapp → nhận 403 → cần bên vận hành hỗ trợ |
| Trả tiền hai lần | `client_request_id = clientRequestIdFor(take.id)` (UUID cố định theo take); sổ `jobs`/`sent` (localStorage `bdp:canvasapp:jobs`, giữ cả khi đăng xuất); khoá đã có job không bao giờ `POST` lại; câu trả lời mất → tìm job trong danh sách trước, chỉ gửi lại 1 lần cùng khoá; vẫn không rõ → `UNKNOWN_SUBMIT_ERROR`, không tự gửi; huỷ trước `POST` → không gửi. Test: `providers/__tests__/canvasapp-e2e.test.ts` |
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
- [x] Đọc `/api/video-profiles` trước khi gửi (adapter, nhớ 10 phút) và từ chối điều trang canvasapp không chạy.
- [ ] Dùng `capabilities()` (đã theo `/api/video-profiles` sau lần đọc đầu) để giới hạn lựa chọn model/mode trong inspector.
- [ ] Node video của cảnh lấy id từ riêng `sceneId`: hai dự án SanoVids có cùng id cảnh (nhân bản / nhập cùng tệp hai lần) dùng chung một node trên canvas cầu nối. Chưa ảnh hưởng tiền (mỗi take có `client_request_id` riêng); khi cần, đưa id dự án vào `JobRequest` và vào `canvasNodeId`.
- [ ] VERIFY với máy chủ thật: dạng phản hồi `POST /api/video-jobs`; máy chủ có dedupe `client_request_id` không; `/stream` có chuyển hướng không. (Đã đối chiếu với `canvas.js`: `order` bắt đầu từ 1; `GET /api/projects` trả mảng; dạng canvas / body job — xem `docs/canvasapp-api-notes.md`.)
- [ ] VERIFY (chống trả tiền hai lần): job trong `GET /api/video-jobs` có trường `client_request_id` không (có → khớp chính xác); `created_at` có múi giờ không; mã lỗi khi thiếu credit (400 hay 402) và `detail`; hai take của **cùng một cảnh** chạy song song trên cùng `canvas_node_id` có bị từ chối không; job có bị huỷ/xoá khi node của nó rơi khỏi canvas cầu nối (giới hạn 40 node) không; danh sách job có bị cắt trang (job đang chạy cũ có biến mất không).
- [ ] UI: nút "Chạy lại" của take `UNKNOWN_SUBMIT_ERROR` nên gọi `useRuns.getState().retry(take.id)` (gửi lại CHÍNH take đó, cùng khoá) thay vì tạo take mới.
- [ ] Video tham chiếu `@video_N`: tìm cách canvasapp nhận video (nếu có) rồi mở `maxRefVideos`.
- [ ] Tải video lớn: stream thẳng ra file trong main thay vì bytes qua IPC; dùng `download-token` nếu cần.
- [ ] Đồng bộ ngược: nhập các job đã tạo trên canvasapp (trong phiên bridge) thành take.
- [ ] Khi có API chính thức / token từ bên vận hành: thay `transport.ts` (vd. HTTP + API key do người dùng nhập, lưu bằng `safeStorage`), giữ nguyên `adapter`/`mapping`.

## 9. Kế hoạch thử thủ công (cho người dùng)

> Bản rút gọn, tốn ít credit nhất (8 credit) cho lần tự kiểm tra cuối: **docs/TEST-REAL-CREDITS.md**.

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
13. **Huỷ lúc đang gửi** — chạy 2 cảnh có ảnh, huỷ take thứ hai ngay (khi take đầu còn đang tải ảnh) → trên canvasapp chỉ có 1 job; take huỷ ghi "không bị trừ credit".
14. **Rút mạng lúc bấm chạy** — tắt Wi-Fi ngay sau khi bấm chạy, bật lại sau ~20 s → take tự tìm lại/gửi lại; trên canvasapp chỉ có **1** job cho take đó.

Tự động (không mạng, không tốn tiền): `npx vitest run src/providers/__tests__/canvasapp-e2e.test.ts` chạy toàn bộ luồng thật
(engine → adapter → transport → cầu nối giả lập canvasapp) cho các trường hợp trên.

Ghi lại mọi lỗi kèm thông báo hiển thị (và, nếu có, mã lỗi trong DevTools: `Ctrl+Shift+I` → Console).
