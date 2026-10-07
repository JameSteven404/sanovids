# Cổng canvasapp.io.vn → SanoVids (nền tảng, thử nghiệm)

> **Trạng thái:** phần nền (foundation). Mặc định **TẮT** — SanoVids dùng *chế độ Phát triển* (canvasapp giả lập trong app, không mạng, không tốn tiền — §1b).
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
- Nhẹ nhàng với máy chủ: tối đa **10 job** cùng lúc nhưng tiến độ của mọi job được đọc chung **một** lần gọi danh sách
  job, kiểm tra tiến độ **≥ 15 giây/lần** (mặc định 20 s; trang canvasapp tự kiểm tra 60 s/lần), gửi job lần lượt từng
  cái, tải ảnh lên tuần tự và chỉ một lần cho mỗi ảnh; tiến trình chính chỉ cho **2 request API + 2 lượt tải video**
  chạy song song (hai làn riêng: tải video lâu không làm chậm việc kiểm tra tiến độ hay gửi job).
- Đây là **API nội bộ không chính thức** của canvasapp. Chỉ dùng khi đã được bên vận hành canvasapp.io.vn cho phép.

## 1b. Chế độ Phát triển (giả lập canvasapp ngay trong app)
Mặc định take mới chạy ở **chế độ Phát triển**: CHÍNH mã cổng canvasapp (api.ts, adapter.ts, mapping.ts, transport.ts) nói chuyện với một canvasapp.io.vn giả lập trong app (`src/providers/dev/`) — không gọi mạng, credit giả lập ("credit dev"), có đăng nhập / nạp credit qua SePay giả / lịch sử credit, và có thể gây lỗi có chủ đích (mất mạng, mất câu trả lời, 402, 422, 429, job lỗi…) để tìm bug. Xem docs/SPEC-v2.md §11.

Dùng nó như bản tập dượt của mọi luồng trong tài liệu này: **Bảng phát triển** (nút 🐞 trên thanh trên cùng) bật lỗi giả theo từng endpoint (một lần hoặc “giữ”; với “Tải video” còn có ngắt / treo giữa chừng, tải chậm, video > 1 GB và công tắc “Cho tải tiếp video (HTTP Range)”), xem **Nhật ký** từng yêu cầu (JSON, “Copy nhật ký” để báo lỗi), **Kiểm tra nhân vật** của mỗi `POST /api/video-jobs` (upload_ids theo thứ tự = `@image_N` → ảnh trong dự án), và điều khiển job / đơn nạp (hoàn tất, cho lỗi, cho hết hạn; đã thanh toán, đối soát, từ chối). Trang đăng nhập và trang SePay là hai bảng giả lập trong app — không mở trang thật nào. Cùng một bộ luật với máy chủ thật: allowlist của `electron/main.cjs`, giới hạn 2 MB / 20 MB, canvas và body job kiểm tra chặt (`providers/dev/validate.ts`).

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
 │  canvasapp:downloadOpen | downloadRead | downloadClose (video kết quả, từng phần ≤ 4 MiB)       │
 │  canvasapp:checkout (nạp credit: cửa sổ modal trang SePay thật, xem §5b)                      │
 │   • chỉ nhận lời gọi từ app://bdp/…                                                             │
 │   • allowlist method + path (+ query project_id), id chỉ gồm [A-Za-z0-9_-]                     │
 │   • thêm X-CSRF-Token từ cookie canvas_csrf; JSON ≤ 2 MB, ảnh ≤ 20 MB (multipart tự dựng)       │
 │   • 2 request API + 2 lượt tải video song song (hai làn riêng); /api/video-jobs cache 15 s      │
 │   • API: session.fromPartition('persist:canvasapp').fetch(…, redirect 'error': không theo       │
 │     chuyển hướng nào — https → http cũng không)                                                │
 │   • video: net.request (<canvasapp-net-get>), chỉ theo chuyển hướng https                       │
 │   • cửa sổ đăng nhập = trang thật https://canvasapp.io.vn/ trong cùng phân vùng                 │
 └───────────────────────────────────────────────│──────────────────────────────────────────────┘
                                                 ▼
                                   https://canvasapp.io.vn/api/…
```

Giao diện nhà cung cấp (`src/providers/types.ts`):

| Hàm | Ý nghĩa |
|---|---|
| `available()` | `{ok, reason?}` — canvasapp: có bridge desktop **và** `/api/auth/state` báo đã đăng nhập |
| `capabilities(model)` | giới hạn (modes, durations, resolutions, ratios — canvasapp: các giá trị của bảng model mà `profileIssues` không từ chối; ảnh/video tối đa, prompt, concurrency, chu kỳ poll) |
| `submit(JobRequest)` | → `{ remoteId }` (lưu trên take: `take.remoteId`) |
| `poll(remoteIds)` | → `[{remoteId, state, progress?, error?}]` |
| `fetchResult(remoteId, { signal, onProgress })` | → `{ video: Blob, poster?: Blob }` (thiếu poster → engine tự cắt khung hình từ video). `signal` dừng tải (huỷ / xoá take, đổi dự án); `onProgress({ received, total })`. Lỗi `too-large` (`isResultTooLarge`): không bao giờ tải được; `too-slow` (`isResultTooSlow`): kết nối quá giới hạn thời gian mà không tải tiếp được — không thử lại; `deferred` (`isResultDeferred`): chưa tải gì, thử lại sau, không tính là một lần hỏng |
| `cancel?(remoteId)` | mock: có. canvasapp: **không** (xem §6) |
| `recover?(req)` | tìm job mà một lần gửi trước của `req.key` có thể đã tạo (trang đóng/tải lại lúc gửi) — **không bao giờ** tạo job. canvasapp: có (lần gửi đó chắc chắn không tạo job → lỗi `deferred` + `notSent`: take về hàng đợi, gửi lại cùng khoá) |
| `settingsLimits?()` | điều cổng đang từ chối theo lần đọc `/api/video-profiles` gần nhất (`source` `'none'` / `'server'` / `'fallback'`, `firm`, `issues(settings)` = `mapping.profileIssues`) — đồng bộ, không gửi gì. mock: không có (không giới hạn) |
| `limitsInfo?()` | đọc lúc nào, lần thử gần nhất ra sao, đang đọc không (Bảng phát triển, ghi chú inspector) |
| `refreshLimits?({force, changed})` | đọc lại cho UI: theo TTL (đang mới / vừa lỗi < 1 phút → không gửi), `force` ("Đọc lại") tối đa mỗi 5 s, `changed` (sau khi đăng nhập / đổi cấu hình trang giả lập) đọc ngay — không giới hạn 5 s, không dùng lần đọc đang bay đã gửi trước đó; dùng chung một yêu cầu với lần đọc của submit; không bao giờ ném lỗi |

Trường mới trên take (tuỳ chọn, tương thích ngược — take cũ không có = demo):
`provider` (`'mock' | 'dev' | 'canvasapp'`), `remoteId`, `charged` (đã trừ credit demo hay chưa → có hoàn khi lỗi/huỷ hay không),
`framesSnapshot` (khung đầu/cuối lúc bấm chạy), `imported` (take **nhập** từ một job tạo trên trang canvasapp — xem §4
"Nhập job": `{ at, jobName, unknown, inferred }`). Khai báo trên `Take` (`core/types.ts`);
`migrateTake` (`core/migrate.ts`) điền giá trị mặc định cho take cũ (và kiểm tra `imported`). `RunTake` (`providers/types.ts`) chỉ còn là tên khác của `Take`.

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
| cảnh của dự án (`sanovidsProjectId` + `sceneId`) | `canvas_node_id = sceneNodeId(projectId, sceneId)` = `canvasNodeId(sceneNodeKey(…))` (UUID, cố định theo cảnh **của dự án**) | node video tồn tại trong canvas "SanoVids bridge". Hai dự án có cùng id cảnh (Nhân bản dự án, nhập cùng một tệp hai lần) có hai node riêng. Node cũ đặt theo riêng `sceneId` (bản trước) vẫn dùng cho job đang chạy trên đó và cho take gửi lại sau khi bản trước mất câu trả lời |
| — | `project_id` | phiên "SanoVids bridge" (tạo một lần bằng `POST` không body rồi `PATCH {name}`, như trang canvasapp; nhớ id) |
| — | `generate_audio: true` | mặc định như trang canvasapp |
| `@video_N` (video tham chiếu) | *không có* | **chưa hỗ trợ** (chưa thấy canvasapp nhận video — `docs/canvasapp-api-notes.md` "Reference videos") → cảnh gửi video bị bỏ qua với lý do rõ ràng (`NO_VIDEO_REFS_REASON`), không tốn credit; video còn sót ở chế độ không gửi video (H3 t2v / transform) không chặn |

### 3.2 Canvas cầu nối (`PUT /api/projects/{id}/canvas`)

Trang canvasapp lưu canvas trước khi tạo job, nên máy chủ yêu cầu `canvas_node_id` có thật — và **kiểm tra chặt
dạng canvas**: bản v0.2.0 bị từ chối "Invalid canvas payload" vì thừa khoá `title`, viewport `{x, y, zoom}` và id
không phải UUID. Canvas tối thiểu giờ dựng **đúng từng khoá** như `canvasPayload()` của trang canvasapp
(chi tiết: `docs/canvasapp-api-notes.md`):

- 1 node `video` / cảnh của một dự án: `{ id: canvasNodeId(khoá node), type: "video", x, y, w: 390, h: 600, data: { model_profile, duration, resolution, aspect_ratio, mode, prompt } }` — đúng 6 khoá trong `data`. Khoá node = `sceneNodeKey(sanovidsProjectId, sceneId)` = `node:<độ dài id dự án>:<id dự án>:<id cảnh>` (đơn ánh, không bao giờ trùng một id cảnh SanoVids tạo ra); mục canvas đã nhớ (`bdp:canvasapp:gateway` › `entries`) được lưu theo khoá này, trong trường `sceneId` như cũ — bản cũ hơn vẫn đọc được và suy ra đúng id node (quay về bản cũ không làm mất node của job đang chạy). Mục do bản trước lưu (khoá = id cảnh trần, "node cũ") vẫn hợp lệ: không chuyển đổi dữ liệu.
- 1 node `images` / ảnh đã tải lên: `{ id: imageNodeId(uploadId, occurrence), type: "images", x, y, data: { upload_ids: [uploadId] } }` (không có `w`/`h`). Ảnh nhân vật dùng ở nhiều cảnh = **một** node ảnh nối tới mọi node video dùng nó (trang canvasapp cho phép); chỉ tách node thứ hai khi một cảnh dùng cùng một ảnh hai lần (hoặc khung đầu = khung cuối).
- connection: `{ from: imageNode, to: videoNode, target_handle: "reference" | "first_frame" | "last_frame", order }`:
  tham chiếu `order = N` (1..N, đúng `@image_N`), `first_frame` 1, `last_frame` 2; H3 chỉ có cạnh tham chiếu khi ở i2v.
- `viewport: { zoom: 1, scrollLeft: 0, scrollTop: 0 }`. Mọi id là UUID (`uuidFromKey`, tất định), toạ độ là số nguyên.
- H3 transform: `aspect_ratio` của node = tỷ lệ chung của hai ảnh khung (như `setTransformFrame()`); hai khung khác tỷ lệ
  hoặc tỷ lệ ngoài danh sách (16:9, 9:16, 1:1, 4:3, 3:4, sai lệch ≤ 2 %) → từ chối trước khi tải ảnh, như trang canvasapp.
- Giới hạn như trang canvasapp: 40 node, **30 ảnh trên cả canvas** (`imageIds()` của trang đếm mọi `upload_ids`, kể cả
  trùng) — thêm 400.000 ký tự prompt. Thứ tự: cảnh đang gửi **luôn đứng đầu** (kể cả khi `usedAt` bằng hoặc cũ hơn, vd.
  đồng hồ máy bị lùi), rồi các cảnh **còn job đang chạy**, rồi các cảnh khác (mới trước cũ sau). Chỉ cảnh **không còn job
  chạy** mới có thể bị bỏ khỏi canvas cho đủ chỗ (`planBridgeCanvas`): job bị huỷ/mất khi node của nó rơi khỏi canvas hay
  không thì chưa rõ (VERIFY), nên node của job đang chạy không bao giờ bị gỡ.
- "Còn chạy" (`runningNodeKeys`): job chưa `completed`/`failed`/`cancelled`/`expired` trong lần đọc danh sách job gần
  nhất (node = `canvas_node_id` của job, nếu thiếu thì node ghi trong sổ `jobs`), cộng các job trong sổ mà lần đọc đó
  chưa thấy (tạo sau lần đọc, hoặc chưa hiện trong danh sách — giữ thêm (3 + 1) chu kỳ poll); mỗi node như vậy giữ mục
  canvas có cùng id node (kể cả node cũ của job gửi từ bản trước). Chỉ đọc danh sách khi thật sự phải bỏ bớt cảnh và lần
  đọc trước đã quá 15 s; không đọc được → coi mọi cảnh là đang chạy (không bỏ cảnh nào).
- **Không đủ chỗ** cho cảnh đang gửi bên cạnh các cảnh đang chạy (vd. 10 cảnh × 4 nhân vật khác nhau: 7 cảnh đã dùng
  28/30 ảnh) → kiểm tra **trước khi** tải ảnh lên; take quay lại **hàng đợi** (lỗi mã `deferred`, chưa gửi gì, không bị
  trừ credit) và engine chờ một chu kỳ poll rồi thử lại, tới khi có job xong.
- Danh sách cảnh của canvas chỉ được nhớ **sau khi** canvasapp nhận `PUT`, và chỉ những cảnh **có trên canvas đó**: cảnh
  bị bỏ cho đủ chỗ (không còn job chạy) bị quên, lần gửi sau của cảnh đó dựng lại — nên số mục đã nhớ không bao giờ quá
  một canvas (≤ 40), dù có bao nhiêu dự án / bản sao chạy. Bị từ chối → thử lại một lần **không có các
  cảnh đã hết job chạy** (một cảnh cũ có thể là thứ bị từ chối, vd. ảnh đã hết hạn); cảnh đang chạy luôn ở lại. Không có
  cảnh nào bỏ được, hoặc vẫn bị từ chối → báo lỗi "Lưu canvas … không bị trừ credit", không nhớ gì, canvas trên
  canvasapp giữ nguyên (node của các job đang chạy vẫn còn).
- `POST` job bị từ chối (400/404, không phải thiếu credit) → quên cache ảnh của take; mục canvas của cảnh chỉ bị quên khi
  cảnh đó không còn take nào đang chạy.
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
(quên phiên cầu nối + cache upload) và chuyển về chế độ Phát triển (giả lập).

**Gửi (submit)** — runs engine chọn take `queued` (≤ 10 take canvasapp đang chạy; **mỗi lần một take**: take sau chỉ
chuyển sang `processing` khi take trước đã có `remoteId`, nên các take phía sau vẫn `queued` thật — huỷ sạch, và nếu
app đóng giữa chừng thì nhiều nhất một take ở trạng thái "không rõ") → `processing` → `submit(req)`:
1. đọc `/api/video-profiles` (như trang canvasapp lúc mở; nhớ 10 phút; đọc hỏng → dùng cấu hình mặc định của trang:
   Seedance chạy, MiniMax-H3 tạm khoá, đọc lại sau 1 phút; 401 → báo đăng nhập) rồi kiểm tra (`validateRequest`): prompt,
   giới hạn ký tự (H3 t2v/i2v 7.000), video tham chiếu, i2v cần ảnh, transform cần 2 khung, `can_create`, chế độ đang
   tạm ngừng (`disabled_modes`), thời lượng / độ phân giải / tỷ lệ có trong cấu hình; H3 transform: hai khung cùng tỷ lệ.
   Bước này chạy **sau** khi tra sổ (`jobs` / `sent`): take gửi lại sau khi mất câu trả lời vẫn tìm thấy job cũ dù model
   nay bị khoá;
2. phiên "SanoVids bridge": dùng id đã nhớ → nếu chưa có thì tìm theo tên → nếu chưa có thì tạo;
3. kiểm tra **mọi** ảnh có trong máy trước (thiếu ảnh → lỗi rõ ràng "Không tìm thấy ảnh tham chiếu @image_N…", chưa tải lên gì, chưa trả gì), rồi tải lên các ảnh chưa có trong cache (tuần tự; chỉ JPG/PNG/WEBP);
4. `PUT …/canvas` (404 → tạo lại phiên một lần; bị từ chối → thử lại một lần không có các cảnh đã hết job chạy, xem
   3.2; không đủ chỗ cạnh các cảnh đang chạy → về hàng đợi, xét ngay trước bước 3). Lỗi ở bước này luôn
   ghi "Lưu canvas cầu nối … không thành công — chưa gửi yêu cầu tạo video, không bị trừ credit.";
5. đọc danh sách job **ngay trước** `POST` (`GET /api/video-jobs?project_id=`; một lần đọc mà cổng sẽ trả từ cache của
   nó — **gửi** chưa quá 15 s, như cache của cổng tính từ lúc gửi, kể cả khi câu trả lời về chậm; chưa có `POST` nào sau
   đó — thì dùng luôn): mọi job có trong lần đọc đó trên node (của take khác,
   hoặc job người dùng tạo trên trang canvasapp mà chưa nhập) vào `before` của lần gửi, không bao giờ bị nhận nhầm là
   job của nó — cùng **mọi** job trên node mà trang đã thấy trong bất kỳ lần đọc nào khác (`knownOn`: một câu trả lời
   chậm hơn, hay từ cache, có thể thấy ít hơn). Cache của main / cầu nối giả lập cũng không bao giờ thay câu trả lời
   của một request gửi sau bằng câu trả lời chậm của một request gửi trước (nó thấy ít hơn). Đọc không được → vẫn gửi với lần đọc được gần nhất (trừ khi cạnh một take còn chưa rõ, xem dưới); chưa
   có lần đọc nào từ khi mở app / đăng nhập → **không gửi** (`LIST_FIRST_TEXT`, chưa trừ credit): không `POST` nào đi
   mà không có `before`. Job tạo trên
   trang **sau** lần đọc mà `before` lấy từ đó (≤ 15 s trước khi gửi lần đọc đó vì cache — tức ≤ 30 s trước `POST` —,
   hoặc từ lần đọc được gần nhất) thì không có trong `before`: nếu câu trả lời của lần gửi này bị mất, take nhận job đó khi `POST` không tới canvasapp (video của job
   đó, không trừ tiền lần hai — và job đó không còn nhập được), hoặc "không rõ" mãi khi `POST` đã tới (cả hai job đều có
   thể là của nó) — xem §4 "Nhập job" bước 4;
6. ghi trước "đã gửi" (`sent[take.id]`, localStorage `bdp:canvasapp:jobs`) và đọc lại để chắc bộ nhớ đã giữ (đầy →
   **không gửi**, `LEDGER_NOT_SAVED_TEXT`, chưa trừ credit: một `POST` không có bản ghi thì sau khi tải lại trang không
   còn gì để tìm, "Chạy lại" sẽ gửi ngay — có thể trả hai lần; lần gửi lại sau khi mất câu trả lời cũng vậy → "không
   rõ". Dữ liệu trang bị chặn hẳn — đọc localStorage đã báo lỗi, vd. trình duyệt chặn dữ liệu trang, khung sandbox —
   thì sổ nằm trong bộ nhớ của trang như mọi thứ khác ở đó (dự án, take cũng không còn sau khi tải lại):
   `browserStorage` → `memoryStorage`, vẫn chỉ gửi khi đã ghi. Bản ghi `sent` **không bao giờ** bị cắt bớt theo số
   lượng: mỗi bản ghi là một take có thể đã bị trừ, chỉ bỏ khi biết câu trả lời; bản ghi đọc lại không có dự án / node
   bị bỏ, giờ không đọc được thành giờ hiện tại một lần như dưới) → `POST /api/video-jobs` → `job_id` →
   `remoteId = "<project_id>:<job_id>"` lưu vào take **và** vào sổ `jobs[take.id]` (đồng bộ, ngay khi có câu trả lời).
Các lần submit được xếp hàng nối tiếp (không chen nhau). Take bị huỷ (hoặc cảnh bị xoá) trong lúc chờ/đang tải ảnh →
dừng **trước** `POST`, không bị trừ credit (cảnh bị xoá: take quay lại hàng đợi, chạy tiếp nếu Hoàn tác). Lỗi chắc chắn
(401, 402/400 thiếu credit, 403, 404, 429, sai dữ liệu) → take `failed` với lý do tiếng Việt, không tự gửi lại — trừ
khi một lần gửi trước của take đó (trước lần submit này, hoặc lần đầu của chính nó) đã mất câu trả lời: lần gửi lại
bị từ chối chắc chắn thì không tạo job, nhưng lần trước vẫn có thể đã trừ → không tìm job, không gửi thêm lần nào, take
vẫn "không rõ" kèm lời canvasapp (`RESEND_REFUSED_TEXT` + vd. "không đủ credit"; `heldBack`, bản ghi `sent` giữ lại với
`endedAt`, "Chạy lại" lại tìm trước). Lời báo
kèm `detail` của canvasapp (lỗi kiểm tra dữ liệu ghi cả trường, vd. `nodes.0.data.title: Extra inputs are not permitted`)
và yêu cầu nào bị từ chối, mã HTTP — không có id, query, cookie hay nội dung gửi đi, vd.
`[PUT /api/projects/{id}/canvas · HTTP 422]`. Thiếu credit (402, hoặc 400 mà `detail` nói về số dư) giữ cache ảnh.
`POST` không có câu trả lời rõ (mất mạng, quá giờ, 5xx, 200 mà không có `job_id`) → canvasapp **có thể đã tạo job**:
đợi 15 s, đọc danh sách job tìm đúng job đó (cùng `client_request_id` nếu danh sách có trường này, nếu không thì job
**duy nhất** mới xuất hiện trên node mà lần `POST` đó ghi (job mà danh sách không nói ở node nào — `canvas_node_id`
thiếu / null, VERIFY — coi như có thể ở mọi node: nằm trong `before` của mọi lần gửi, là ứng viên của mọi lần tìm),
không thuộc take nào khác, không phải job đã nhập (kể cả khi sổ không còn giữ bản ghi của take đó — giữ 2000 bản ghi
mới nhất: job take khác nhận trong lúc câu trả lời chưa rõ, hay ngay trước `POST` mà lần đọc của nó chưa thấy, được ghi
trên bản ghi `sent[key].taken`), chưa có
trong lần đọc danh sách trước `POST` (hay lần đọc nào khác của trang trước đó), không có sau lần đọc chắc chắn đầu
tiên (`covered`, xem dưới). **Giờ tạo (`created_at`) không bao giờ loại job** (trước đây: ngoài khoảng ±14 h, ±27 h khi
không có múi giờ → loại): giờ đó theo đồng hồ của canvasapp, đồng hồ máy có thể lệch cả ngày (tắt giờ tự động, chỉnh
tay — TLS vẫn chạy) → job của chính nó bị loại, lần đọc "không có" gửi lại → trả hai lần. `before` và `covered` đã
giới hạn job đó theo thời gian (giữa lần đọc trước `POST` và lần đọc chắc chắn đầu tiên); khoảng `inPostWindow` chỉ
còn dùng cho bản ghi của bản trước 0.6.0 không có `before`. Model / thời lượng / `creation_mode` mà danh sách ghi khác
yêu cầu (giá trị của job SanoVids tạo là VERIFY: `creation_mode` khác, thời lượng thật của clip, tên model đã chuẩn
hoá…) **không bao giờ** là lý do "không có": job đó vẫn "có thể", chỉ không được nhận (`differsFromRequest` →
"không rõ", không gửi lại); điều danh sách không nói rõ (thiếu, null, không phải số, giờ không đọc được) không nói
gì. Một job mà một lần đọc đã thấy có thể là của nó (`sent[key].seen`) rồi biến mất khỏi danh sách (xoá trên trang
canvasapp, danh sách cắt trang — VERIFY) → từ đó không lần đọc nào nói được "không có" (`'ambiguous'`, "không rõ",
không bao giờ gửi lại)
— và không thể là job của một take khác trên cùng node còn chưa rõ câu trả lời: khi đó "không rõ", không
đoán); đọc lần 2 khi một lần đọc **chắc chắn** thấy job đó nếu có (`listedBy` + thời gian cache của cổng, `coverableAt`:
45 s sau khi câu trả lời / lỗi về qua cache 15 s của main; không bao giờ chờ quá 45 s từ lúc đó — đồng hồ máy bị
chỉnh lùi giữa chừng chỉ làm lần đọc "quá sớm", tức "không rõ", không bao giờ gửi lại); lần đọc đó không có → gửi lại
**một lần** với **cùng** body và `client_request_id` (`before` của lần gửi lại: mọi job đã thấy tới lúc đó, kể cả job
tạo trên trang ngay trước — không bao giờ bị nhận là job của nó; `beforeAt` của lần đọc "không có" đó); lần đọc đó hỏng (dù lần 1 không thấy), hoặc vẫn không rõ → take `failed` với `UNKNOWN_SUBMIT_ERROR`
("không rõ đã trừ credit chưa"). Job **chỉ khớp theo node và giờ** (danh sách không có `client_request_id`) chỉ được
nhận từ một lần đọc **chắc chắn** thấy job của chính `POST` đó nếu có (`shows` ≥ `listedBy`; lần đọc sớm hơn trả
`'later'` — xem tiếp): lần đọc sớm có thể chỉ thấy một job khác vừa tạo trên node đó ở trang canvasapp trong khi job
của nó chưa hiện, nên "một job duy nhất" ở đó chưa nói được gì — lần đọc chắc chắn sẽ thấy cả hai. Và chỉ khi canvasapp
trả **đúng prompt** của yêu cầu cho job ấy (`GET /api/video-jobs/{id}/prompt`, so sau khi cắt khoảng trắng hai đầu; tối
đa `MAX_PROMPT_CHECKS` = 4 job mỗi lần xem; đọc không được → lần xem đó không nói gì): job của một node đã sửa trên
trang không bao giờ thành job của take, và trong hai job có thể là của nó thì job duy nhất có đúng prompt là của nó.
Prompt khác **không bao giờ** loại một job để gửi lại (canvasapp làm gì với prompt là VERIFY): job đó vẫn là "có thể",
tức "không rõ", không gửi thêm. Lần đọc **đầu tiên** chắc chắn thấy job của một `POST` chưa rõ được ghi vào bản ghi
của nó (`sent[key].covered`: các job lần đọc đó liệt kê ở node nó — ghi bởi mọi lần đọc danh sách: poll, tìm job, đọc
trước `POST`, Nhập job; bỏ khi gửi lại): job có sau lần đọc đó **không bao giờ** là của `POST` này (nó không được tìm
như job của take đó nữa, và nhập được ngay). Lúc quyết định, lần tìm job dùng sổ **như lúc đó** (một lần đọc khác — poll
— có thể đã ghi `covered` trong lúc câu trả lời của nó còn trên đường), và một job đã thành của take khác trong lúc đó
(tab khác, Nhập job) không bao giờ được nhận lần nữa (`settleFound` → "không rõ"). `useRuns.retry(takeId)` cho take đó gửi lại **chính take đó** (cùng khoá; tìm job trước).
Sổ `sent` ghi cả `endedAt` = lúc câu trả lời (hoặc lỗi) của `POST` về tới trang; trang tải lại / đóng khi `POST` còn
đang đi thì không có `endedAt` — main vẫn gửi tiếp (60 s mỗi request sau khi có chỗ trong làn 'api', cộng thời gian
chờ chỗ), nên coi như `POST` đó kết thúc muộn nhất 5 phút sau `at` (`POST_IN_FLIGHT_MS`). Job của một `POST` (nếu có)
có trong danh sách chậm nhất `listedBy` = (`endedAt`, hoặc `at` + 5 phút) + 30 s. "Chạy lại" mà lần đọc chưa chắc thấy
tới mốc đó → **chưa gửi lại**: take về hàng đợi và chờ tới lúc một lần đọc gửi đi chắc chắn thấy job đó nếu có
(`coverableAt`; lỗi `deferred` + `retryAfterMs`, `STILL_SENDING_TEXT`, node take "Chờ tới HH:MM"; vẫn "có thể đã trừ",
`submitUnknown`), rồi tự tìm lại đúng lúc đó và chỉ gửi khi chắc chắn chưa có — không bao giờ trả hai lần vì `POST` cũ
còn đang tới canvasapp, không cần bấm lại đúng giờ; huỷ khi đang chờ → vẫn "không rõ". Mọi "lần này chưa gửi lại"
khác của một take đang gửi lại: không đọc được danh sách để tìm job cũ (`LOOKUP_FAILED_TEXT`), không đọc được danh
sách ngay trước `POST` cạnh take chưa rõ (`LIST_NEEDED_AFTER_LOST_TEXT`), lưu canvas cầu nối hỏng
(`CANVAS_NOT_SAVED_AFTER_LOST_TEXT`), không ghi được sổ (`LEDGER_NOT_SAVED_AFTER_LOST_TEXT`), lần gửi lại bị từ chối
chắc chắn (`RESEND_REFUSED_TEXT`) — mang cờ
`heldBack` (`providers/types.isSubmitHeldBack`): engine ghi vào take cả câu "không rõ" lẫn lý do chưa gửi lại
(`runs.heldBackSubmitError`), nên "Chạy lại" không bao giờ trông như hỏng không lý do; thông báo khi bấm chỉ nói "Đang
kiểm tra lại … chỉ gửi lại khi chắc chắn chưa có"; nút "Chạy lại" / "Thử lại" của take như vậy nói "Gửi lại chính take
này …, không tạo take mới" (`runs.rerunTitle`). Giờ trong sổ `sent` muộn hơn giờ máy hiện tại (đồng hồ bị chỉnh lùi
sau khi ghi) được ghi lại thành giờ hiện tại một lần (`unskewed`: không bao giờ sớm hơn sự thật, `beforeAt` và
`covered` ghi theo đồng hồ cũ bị bỏ) — mọi lần chờ dựa vào bản ghi đó từ đây có giới hạn, thay vì chờ tới khi giờ thật
đuổi kịp; lần đọc mà bản ghi `jobs[key]` của một take đã có job còn giữ (`before` / `beforeAt`, xem dưới) cũng bị bỏ
khi ghi theo đồng hồ cũ — nếu không, nó "chắc chắn thấy" tới một giờ chưa tới và loại nhầm job của take khác (rồi take đó
gửi lại: trả hai lần). Câu trả lời danh sách job được giữ lại (cache 15 s của main, 2 s của cầu nối giả lập, cache poll
của adapter) mà ghi giờ **muộn hơn** hiện tại không bao giờ được dùng lại — không biết nó cũ bao nhiêu (trước đây nó
được dùng tới khi đồng hồ đuổi kịp: một lần đọc từ trước khi chỉnh có thể bị coi là lần đọc chắc chắn mới, rồi gửi lại;
poll đứng yên hàng giờ); một lần đọc mà trong lúc chờ câu trả lời đồng hồ bị chỉnh lùi không được coi là thấy gì chắc
chắn (`shows` = −∞) và không dùng làm lần đọc trước `POST`.

Danh sách job **không ghi `canvas_node_id`** (VERIFY): job nào cũng có thể ở node nào, nên mọi `POST` chưa rõ câu trả
lời trong phiên cầu nối là "take kia" của mọi take — đoạn dưới áp dụng cả cho take **khác cảnh**: chờ (`rivalWait`,
`RIVAL_PENDING_ANY_TEXT`), lần đọc ngay trước `POST` phải chắc chắn thấy job của chúng, khi tìm job thì xét chúng như
cùng node (`pendingOf`, `mayBeJobOf`; lần đọc trước `POST` của take khác node cũng loại được job — nó liệt kê mọi job).
Danh sách **trống** (phiên cầu nối mới) hay chưa đọc từ khi mở trang → theo điều danh sách có job gần nhất đã cho
thấy trên máy này (`LIST_SHAPE_KEY`, giữ qua đăng xuất: đó là cách API của canvasapp ghi danh sách, không phải của một
phiên); chưa bao giờ thấy → coi như có ghi node: chỉ take cùng node phải chờ (trước đây: mọi cảnh chờ `POST` chưa rõ
của một cảnh khác — tới 5 phút 45 s sau khi tải lại trang lúc đang gửi, với lý do sai "danh sách không ghi job thuộc
cảnh nào"). Rủi ro còn lại của lựa chọn này chỉ là "không rõ", không bao giờ trả hai lần: danh sách thật sự không ghi
node, hai take khác cảnh cùng mất câu trả lời và canvasapp cho hai job cùng prompt → mỗi take thấy job kia có thể là
của take kia (`contested`) → cả hai "không rõ".

Hai take trên **cùng một node** (hai take của một cảnh trong một dự án, hoặc take gửi lại trên node cũ) mà đều chưa rõ
câu trả lời: job nào cũng có thể là của take kia. Vì thế một take **không được gửi** khi một take khác trên node đó còn
chưa rõ câu trả lời mà lần đọc gửi lúc này chưa chắc thấy job của nó (`rivalWait`: chưa tới `listedBy` + thời gian cache
của cổng — vd. take trước vừa "không rõ" vì trang tải lại khi main còn gửi: tới 5 phút 45 s): lỗi `deferred` kèm
`retryAfterMs` (`RIVAL_PENDING_TEXT`, chưa gửi gì) → engine đưa **riêng take đó** về hàng đợi tới lúc ấy
(`providers/types.submitDeferredFor`), take của cảnh khác vẫn chạy. Take đó giữ lý do và giờ (`store/takeWaits`, không
lưu; xoá khi tới giờ — kể cả khi lúc đó take chưa chạy được vì cảnh đã bị xoá hay bản cập nhật đang giữ lượt gửi —,
khi huỷ / xoá take, khi engine khởi động lại, và với take dev khi "Xoá dữ liệu máy chủ giả lập"): node take hiện "Chờ
tới 14:32" (lý do trong chú thích), hàng đợi ghi "Chờ tới 14:32 — <lý do>", Xem take ghi giờ và lý do — không bao giờ
chỉ "Đang chờ" suốt mấy phút. Canvas hết chỗ (`CANVAS_FULL_TEXT`: `deferred` **không** kèm giờ — không ai biết bao giờ
một job xong) cũng chỉ giữ **riêng take đó** (xét lại sau mỗi chu kỳ poll, 20 s; giả lập 3 s), các take sau nó — vd.
take mới của một cảnh đã có node trên canvas — vẫn chạy; take đó hiện "Đang chờ" kèm lý do, không có giờ (`timed`
false: một giờ chỉ là lần xét lại sau sẽ không bao giờ tới). Lần đọc danh sách job ngay
trước `POST` (bước 5: `before` + `beforeAt` trong sổ `sent`) khi đó là **bắt buộc** và phải chắc chắn thấy job của mọi
take như vậy (lần đọc cache chưa thấy tới đó → đọc lại): đọc không được → **không gửi** (take `failed`, "chưa
gửi … không bị trừ credit"; take đang gửi lại thì vẫn "có thể đã bị trừ" như trước) — trừ khi lần đọc được gần nhất
(lần `before` sẽ dùng) đã chắc chắn thấy job của take kia, nếu có (tới mốc `listedBy` của nó, `covers`): job đó
khi ấy nằm trong `before`, nên một take "không rõ" cũ không bao giờ được thử lại (hoặc đã xoá) không chặn cảnh mãi. Khi tìm job (`findJob`): một take
`POST` **sau** chỉ có thể sở hữu job mà lần đọc ngay trước `POST` của nó chưa thấy — và khi lần đọc đó chắc chắn thấy
job của take `POST` **trước** (`beforeAt` ≥ `listedBy` của nó, điều `rivalWait` bảo đảm), job không có trong lần đọc
đó không bao giờ là của take trước — cả sau khi take sau đã có job: lần đọc đó được giữ trên bản ghi job của nó
(`jobs[key].before` / `beforeAt`, chỉ khi một take chưa rõ trên node đó còn dựa vào nó), nên một job tạo trên trang sau
đó không bao giờ bị take trước nhận (take trước gửi lại đúng là nó, job trên trang vẫn nhập được); một take `POST`
**trước** chỉ có
thể sở hữu job mà lần đọc trước `POST` của take đang tìm chưa thấy dù lần đọc đó chắc chắn thấy mọi job có từ mốc
`listedBy` của `POST` kia (30 s — `SETTLE_MS` — sau khi câu trả lời của nó về; không rõ lúc về vì
trang tải lại giữa chừng → sau 5 phút + 30 s) — job của một `POST` có trong danh sách trong 30 s sau câu trả lời hoặc
không bao giờ, đúng như điều adapter đã dựa vào khi gửi lại. `beforeAt` vì thế là lúc **gửi** lần đọc đó trừ đi thời
gian cổng có thể trả danh sách từ cache của nó (main: 15 s; giả lập: 2 s — `gatewayListCacheMs`), không phải lúc nhận
câu trả lời; cache của main và của cầu nối giả cũng tính 15 s / 2 s từ lúc **gửi** request đã điền cache
(`<canvasapp-job-list-cache>`), không phải lúc câu trả lời về: một câu trả lời cache cũ, kể cả câu trả lời chậm, không
bao giờ được coi là mới hơn thực tế. Không chắc (ví dụ hai bản ghi của bản trước 0.6.0, không ghi giờ đọc) → **không take nào nhận** job đó,
cả hai "không rõ", không gửi lại — kiểm tra trên canvasapp.io.vn. Lần gửi lại (sau lần đọc chắc chắn không thấy) ghi lại
giờ `at` của chính nó.

**Cấu hình model trong inspector và hộp Chạy** — cùng một luật với bước 1 (`mapping.profileIssues`, không viết lại
luật), trên cùng bộ nhớ đệm `/api/video-profiles` của adapter (`settingsLimits()`; tín hiệu `useProviderLimits` trong
`providers/index.ts`). Ba trạng thái:
- `none` (chưa đọc: chưa đăng nhập, chưa hỏi, demo cũ) → không giới hạn gì, bước 1 tự quyết khi gửi;
- `server` đọc trong 10 phút (`firm`) → lựa chọn bị từ chối **tắt hẳn** kèm lý do (không ẩn, **không đổi** cấu hình đã
  lưu của cảnh), nút Chạy của cảnh tắt (`core/runGate` `settingsBlock`), `useRuns.check()` / `enqueue` bỏ qua cảnh đó (không
  tạo take, không gửi gì, không tốn credit); đọc cũ hơn 10 phút → chỉ còn là đoán (như dưới), vì submit sẽ đọc lại;
- `fallback` (đọc hỏng → cấu hình mặc định của trang, MiniMax-H3 khoá) → chỉ đánh dấu "có thể bị từ chối" + cảnh báo
  trong hộp Chạy, không chặn.
Đọc cho UI (`refreshLimits`): khi inspector / hộp Chạy hiện (theo TTL: đang mới → không gửi; sau một lần lỗi hay 401 →
chờ 1 phút), nút "Đọc lại" (ép, tối đa mỗi 5 s; đang có lần đọc chưa ép thì gửi thêm **một** lần sau nó), sau khi đăng
nhập (ô credit, Bảng phát triển) và nút "Đọc lại ngay" của Bảng phát triển (`changed`: đọc ngay dù vừa nhận 401 vài giây
trước, không chờ giới hạn 5 s; đang có lần đọc thì gửi thêm một lần sau nó), và — chỉ khi inspector / hộp Chạy đang mở —
đọc lại 30 s trước khi lần đọc hết `firm`. Đọc hỏng thì **không** có hẹn giờ đọc lại: lần sau là khi inspector / hộp
Chạy hiện lại (sau 1 phút), khi gửi, hoặc khi bấm "Đọc lại". Bất biến: (1) UI và submit dùng chung một yêu cầu đang bay; (2) đọc hỏng không bao giờ thay danh sách còn mới
(< 10 phút) bằng cấu hình mặc định ('kept': bấm "Đọc lại" không làm submit từ chối điều nó vừa nhận), và chỉ lần hỏng mà
một submit đã chờ mới giữ các submit ở cấu hình mặc định trong 1 phút — lần hỏng chỉ UI thấy không làm submit bỏ qua
bước đọc; (3) `reset()` (đăng xuất) bỏ mọi câu trả lời đến muộn; (4) `getProvider` không bao giờ bắn tín hiệu (UI gọi
nó lúc render). `retry(takeId)` của take "không rõ" không đi qua `check()`.

**Theo dõi (poll)** — mỗi nhà cung cấp một lời gọi: canvasapp gom mọi take đang chạy thành **1** `GET /api/video-jobs?project_id=…`,
không sớm hơn 20 s (engine ép tối thiểu 15 s; adapter cache 15 s; main cache 15 s, bỏ cache mỗi lần `POST /api/video-jobs`).
Lỗi khi poll (mạng, 401, 429…) **không** làm hỏng take: engine giữ take đang chạy, nghỉ 1 → 2 → 4 → … tối đa 10 phút, và
đặt `useRuns.providerIssue` để UI báo. Sau 401, đăng nhập lại (đọc được số dư) → hết nghỉ, poll lại ở lượt kế.

**Tải kết quả** — `completed` → `GET /api/video-jobs/{job_id}/stream` → Blob `video/mp4` → engine cắt
poster (≤ 640 px, `providers/poster.ts`) → `putBlob` → take `completed` (+ tự tải về máy nếu bật "Tự tải video").
Video **không** đi qua IPC trong một thông điệp: trang kéo từng phần (`transport.download()` → `canvasapp:downloadOpen`
/ `downloadRead` / `downloadClose`, khối thuần `<canvasapp-downloads>` trong `electron/main.cjs`); `canvasapp:request`
từ chối đường `/stream` (`matchCanvasappRequest` — trang, preload và main luôn đi cùng nhau trong app.asar nên không còn
"bản desktop cũ" nào cần lệnh nhị phân một lần). Main tự đọc thân HTTP, mỗi lần đọc trả ≤ 4 MiB (hoặc phần đã về sau
1 giây trên mạng chậm), chỉ đọc mạng khi trang đang chờ một phần; trang ghép các phần thành một Blob (không chép lại).
Mỗi kết nối giữ **một** chỗ của làn tải video (2 chỗ) từ lúc mở tới lúc kết thúc. Giới hạn: ≤ 1 GB (báo trước bằng
Content-Length → từ chối ngay, không đọc; vượt khi đang đọc → dừng); 60 giây không nhận thêm byte nào → dừng; 5 phút chờ
phần đầu câu trả lời; **60 phút cho một kết nối** (`too-slow`: tải tiếp được → nối tiếp trên kết nối mới, chỗ trong làn
nhường cho lượt đang chờ; không tải tiếp được → take `failed` ngay với lời nhắn đã trừ credit, không tải lại từ đầu 5 lần);
trang ngừng đọc 30 giây (tải lại / treo) → dừng. Trang tải lại / chuyển trang / renderer sập / cửa sổ đóng / đăng xuất →
mọi lượt tải của trang đó dừng ngay, trả chỗ trong làn. Mã lượt tải (UUID) do trang chọn nên huỷ được cả khi lượt tải
còn **chờ chỗ**. Trang chỉ gửi một đường dẫn trong allowlist (không URL, không header, không validator). Main gửi GET
qua `net.request` (khối `<canvasapp-net-get>`, `redirect: 'manual'`): chuyển hướng chỉ được theo tới **https** — yêu cầu
tới một địa chỉ http **không bao giờ được gửi** (lỗi `not-allowed`, lần thử sau như mọi lượt tải hỏng). `session.fetch`
không dùng được cho việc này: nó theo mọi chuyển hướng, kể cả https → http, và câu trả lời không cho biết địa chỉ cuối.
Vì vậy các lời gọi API (`canvasapp:request`, mang `X-CSRF-Token`, prompt, mã upload, đơn nạp) gửi với `redirect: 'error'`:
route API của canvasapp không chuyển hướng; nếu có thì lời gọi hỏng như lỗi mạng (`network` — với `POST` tạo job: "có thể
đã tạo", tìm job trước, không bao giờ coi là "chưa trừ tiền"), không bao giờ gửi lại sang địa chỉ khác.
**Tải tiếp (Range)**: chỉ khi canvasapp gửi ETag mạnh (hoặc Last-Modified) cho đúng video đó — main giữ nó 10 phút kể từ
khi kết nối cuối của video đó kết thúc (lượt tải dài hơn 10 phút vẫn tải tiếp được) và gửi `Range: bytes=N-` +
`If-Range`; trả 206 đúng chỗ **và** mang đúng validator đã gửi → ghép tiếp (206 mang validator khác / không có: máy chủ bỏ
qua If-Range, có thể là phần sau của một file khác cùng cỡ → `bad-range`); trả 200 (video đã đổi) → bỏ phần cũ, tải từ đầu;
416 / 206 lệch chỗ / validator khác → tải lại từ đầu. Một lượt tải chỉ được bắt đầu lại từ đầu **một** lần (kể cả 200 cho
yêu cầu tải tiếp: máy chủ luôn trả từ đầu thì lượt đó hỏng, không vòng lặp). Mở lại để tải tiếp mà chưa tới được canvasapp
(Wi-Fi chưa có lại, `ERR_NETWORK_CHANGED`…) → giữ phần đã nhận, chờ 2, 5, 10, 20, 30 giây rồi mở lại (`RESUME_RETRY_MS`);
sau đó mới hỏng. Không có validator, hoặc thân bị nén (Content-Encoding) → không bao giờ ghép: lượt tải hỏng, engine tải
lại từ đầu ở lần thử sau. Kích thước cuối phải đúng kích thước canvasapp báo; không báo kích thước thì chỉ nhận khi thân
kết thúc tự nhiên — một lượt tải bị cắt (đăng xuất, đóng) **không bao giờ** thành video "xong".
Tiến độ: take hiện "Đang tải về 45%" (hoặc "Đang tải về 12,3 MB" khi không biết kích thước) thay vì "Đang tạo 99%"
(`store/takeTransfers.ts`) — trên node, trong Xem take (vòng tiến độ + "Video đã tạo xong — đang tải về …") và ở hàng
đợi ("tải 45%").
Tải hỏng (mạng, phiên…) → take **vẫn** "đang tạo 99%" và thử lại sau 30 s, 1, 2, 5 phút; hỏng cả 5 lần → `failed` với lời
nhắn "đã tạo xong, đã trừ credit — tải trực tiếp trên canvasapp, chạy lại sẽ trừ thêm". Video > 1 GB, hoặc kết nối quá
60 phút mà không tải tiếp được → `failed` ngay với lời nhắn đó (không thử lại 5 lần cho cùng một kết cục). "Đang tải quá
nhiều video cùng lúc" (16 lượt mở / chờ) → thử lại sau 15 giây, không tính là một lần hỏng. Xoá take, đổi dự án → lượt
tải dừng ngay (không tính là hỏng). **Huỷ** khi job đã xong trên canvasapp (đang tải về, hoặc chờ thử tải lại —
`runs.remoteVideoReady`) → `actions.cancelTake` **hỏi trước**: video đã tạo xong và đã trừ credit, huỷ sẽ bỏ video này
trong SanoVids (vẫn tải được trên canvasapp.io.vn), chạy lại cảnh sẽ trừ thêm; không đồng ý → tải tiếp như cũ. Thông báo
sau khi huỷ nói đúng điều đó (không còn "job vẫn chạy ở đó"). **Xoá** take đó (phím Delete, nút thùng rác của node / Xem
take kể cả sau hai lần bấm) cũng **hỏi trước** như vậy (`deletePlan.checkTakeDelete` `paidPending`; take nhập thì không
hỏi: "Nhập job" đưa job về lại được).
`download-token` **không** dùng: main đã gửi cookie phiên canvasapp với `GET /stream`; token chỉ là phương án dự phòng
nếu `/stream` không tải trọn được (khi đó: allowlist riêng, che token trong `requestLabel` và nhật ký).

**Mở lại app / đổi dự án** — take canvasapp đang `processing` có `remoteId` được giữ nguyên và **tiếp tục poll** (không gửi
lại = không trả tiền hai lần). Take đang gửi dở (chưa có `remoteId` trên take — trang đóng/tải lại lúc gửi, hoặc lưu
chậm) → `provider.recover()`: lấy `jobs[take.id]` trong sổ, hoặc đợi lần gửi còn đang chạy, hoặc (có `sent[take.id]`) tìm
job trong danh sách như trên — ngay, rồi (lần đọc hỏng, "không có" hay một job chỉ khớp theo node và giờ mà chưa chắc
thấy job đó: `shows` < `listedBy`) thêm một lần nữa khi một lần đọc chắc chắn thấy job đó nếu có — chờ tới lúc đó, kể cả
tới 5 phút 45 giây sau `POST` khi trang đóng / tải lại lúc main còn gửi nó (`POST_IN_FLIGHT_MS` + 45 s): take vẫn "đang
gửi" trong lúc chờ (chỉ giữ lượt gửi của take **cùng node** — mọi node khi danh sách không ghi node, `rivalsOf`), không
bao giờ "không rõ" vì một job còn có thể tới. Tìm thấy → poll tiếp. Lần đọc chắc chắn đó **không có** job nào có thể là
của nó **và** danh sách được đọc lần đầu đủ sớm sau mốc job đó phải hiện (`sent[key].coveredAt` ≤ `listedBy` +
`NOT_MADE_FRESH_MS` = 5 phút: một job tạo ra rồi bị xoá trên trang trước khi SanoVids kịp đọc danh sách trong chừng đó
thời gian thì không tính tới) → lần gửi đó chắc chắn không tạo job (cùng luật với lần gửi lại tự động sau khi mất câu
trả lời): `recover()` báo `deferred` + `notSent` (`NOT_MADE_TEXT`) → take về hàng đợi và được gửi lại như mọi take,
**cùng khoá** (bản ghi `sent` còn đó: tìm trước một lần nữa) — không còn "không rõ" cho một yêu cầu chắc chắn chưa tạo
gì. Danh sách chỉ được đọc lần đầu lâu sau đó (app đóng nhiều giờ / nhiều ngày, máy ngủ): job của nó có thể đã bị xoá
trên trang (hoặc trôi khỏi danh sách cắt trang) mà SanoVids chưa từng thấy → **không** tự gửi lại (trước đây: tự gửi lại,
trả hai lần) → "không rõ"; take mà một lần tải lại để `queued` dù yêu cầu của nó đã đi (lưu chậm) cũng vậy — chỉ
"Chạy lại" (`JobRequest.resend`, take có `submitUnknown`) gửi lại sau một lần đọc chắc chắn không thấy, dù lâu bao
nhiêu. Không biết được (lần đọc hỏng, nhiều job có thể là của nó) → `failed` với `UNKNOWN_SUBMIT_ERROR`. Take bị **huỷ**
khi đang gửi (đang `processing` chưa có `remoteId`: lần gửi hay lần tìm lại còn chạy, ở tab này hay tab khác, có thể tới
5 phút 45 s sau khi tải lại trang) — hoặc khi adapter còn giữ một yêu cầu của nó (`mayHaveBilled`: vd. take một lần tải
lại để `queued`) — giữ "không rõ" **ngay lúc huỷ** (`submitUnknown`; trước đây chỉ khi lần gửi kết thúc, nên bấm "Thử
lại" ngay sau "Huỷ" tạo take mới, khoá mới, trong khi yêu cầu đầu có thể vẫn tạo job: trả hai lần): "Thử lại" / "Chạy
lại" gửi lại chính take đó, tìm job trước, không bao giờ thành take mới trả thêm. Nỗi ngờ đó mất khi lần gửi của nó kết
thúc mà adapter không còn yêu cầu nào của khoá đó có thể bị trừ (dừng trước `POST`, bị từ chối chắc chắn), hoặc có
`remoteId`. Lần gửi đó đã kết thúc trong trang này mà chắc chắn không
gửi gì tính tiền (bị hoãn, bị từ chối, dừng trước `POST` — vd. trong lúc đang mở dự án khác, hoặc trang tải lại dự án vì
tab khác lưu): adapter nhớ lỗi đó (`notSent`, chỉ trong bộ nhớ: không có bản ghi `sent` thì không có `POST` nào có thể
bị trừ) và `recover()` trả lại đúng lỗi đó (`providers/types.isRecoverNotSent`) → take về hàng đợi với phần chờ còn
lại, hoặc `failed` với đúng lý do (vd. không đủ credit) — không bao giờ "không rõ" cho một yêu cầu chưa từng gửi. Take
đang được tìm lại không gửi gì nên **không** giữ lượt gửi của nhà cung cấp: take khác (cảnh khác) chạy tiếp ngay, không
chờ nó. Bản thân `recover()` **không bao giờ** `POST`. Đổi sang dự án khác lúc đang gửi không huỷ lần gửi đó (node của nó vẫn là node của dự án đã gửi —
`JobRequest` dựng ngay lúc gửi); `remoteId` về khi dự án đó đã đóng được engine giữ trên máy (`runs.lateRemoteIds`,
localStorage `bdp:runs:late-remote-ids`, theo id take, ≤ 200) và trả lại cho take khi dự án được mở lại (`loadRuns`) — take
không bao giờ chỉ dựa vào sổ `jobs` của adapter (giữ `MAX_JOB_RECORDS` = 2000 bản ghi mới nhất) để tìm lại job đã trả
tiền; mở lại dự án → take tiếp tục với job đó (hoặc tìm lại job như trên). Lần đọc ngay trước `POST` mà thấy một job
mang `client_request_id` của chính take (danh sách có trường này) → đó là job của nó dù sổ không còn bản ghi: không gửi. Take của một dự án không bao giờ nhận nhầm job của bản
sao (node khác nhau), và hai take còn "không rõ" trên cùng một node không bao giờ nhận job của nhau (xem trên).

**Nhập job từ canvasapp (đồng bộ ngược)** — người dùng có thể bấm "Tạo video" ngay trên trang canvasapp.io.vn, trên node
của một cảnh trong phiên "SanoVids bridge". Nút **Nhập job** (Hàng đợi; Cài đặt › Nhà cung cấp video khi đã đăng nhập;
Bảng phát triển — nơi này luôn đọc canvasapp giả lập) đưa các job đó vào dự án đang mở thành take của đúng cảnh (`siteJobActions.ts`, luật thuần trong
`providers/canvasapp/siteJobs.ts`, adapter `scanSiteJobs` / `siteJobPrompts` / `claimSiteJobs`):
1. **Chỉ đọc** (chỉ `GET`, không bao giờ trừ credit): id phiên đã nhớ, nếu chưa có thì tìm theo tên (`GET /api/projects`
   — không tạo, không nhớ); `GET /api/video-jobs?project_id=` (luôn đọc lại — cache 15 s của main vẫn áp dụng, job vừa
   tạo có thể chưa hiện); `GET /api/projects/{id}` (canvas đã lưu, chỉ khi có job nhập được); sau khi chọn: `GET
   /api/video-jobs/{id}/prompt` từng job một, tối đa **20 job** mỗi lần.
2. Job nhập được = job canvas (`creation_mode` trống / `canvas`), mã job hợp lệ, `canvas_node_id` là node của một cảnh
   trong dự án đang mở (`sceneNodeId`, hoặc node cũ theo id cảnh), chưa kết thúc lỗi / huỷ / hết hạn (job xong mà
   `download_available: false` quá 1 giờ thì bỏ — `finished_at` không có múi giờ thì lệch tới 27 giờ ở máy này: chỉ bỏ khi
   chắc chắn đã quá, còn lại mời trong 1 giờ kể từ lần quét đầu tiên thấy nó như vậy, `siteJobs.mayStillDownload`), model
   SanoVids có. `created_at` không có múi giờ **không bao giờ** được đổi như giờ của máy này: hộp Nhập job hiện đúng như
   canvasapp ghi, kèm "(giờ canvasapp)", và take nhập lấy giờ lúc nhập (`SiteJobCandidate.createdAt` chỉ là thời điểm
   thật — `zonedTime`; dùng cho giờ tạo của take, Xem take và tên file `{date}` / `{time}`). **Không bao giờ** nhập: job đã là take của dự án;
   job SanoVids tạo (sổ `jobs`, hoặc `client_request_id` của một take khi danh sách có trường này); job mà một lần `POST`
   còn chưa rõ câu trả lời (sổ `sent`) **có thể** đã tạo (`sentMayOwn`: cùng `client_request_id` nếu danh sách có, nếu
   không thì cùng node, không có trong lần đọc trước `POST` — **dù canvasapp ghi giờ tạo nào** (trước đây: chỉ trong
   ±14 h / ±27 h quanh lần gửi — đồng hồ máy lệch cả ngày thì job của chính nó nhập được thành take khác, rồi take kia
   gửi lại: trả hai lần) — take đó phải tự tìm ra job của nó, không bao giờ thành take mới). Job tạo **sau** lần đọc đầu tiên chắc chắn thấy job của lần gửi đó (`sent[key].covered`, xem "Gửi") thì
   không phải của nó: không bị giữ, nhập được ngay. Job như vậy bị giữ **không thời hạn** (tới khi take đó tìm ra job của nó — "Chạy lại"); dòng "Không nhập
   được" không hứa mốc hay khoảng giờ nào; take đó đã xoá thì
   không bao giờ tìm lại nữa → job đó không nhập được (tải video trên canvasapp.io.vn) — không tự nhả: một take chưa kịp
   lưu ở tab / cửa sổ khác cũng chưa có trong danh sách take, nhả nhầm thì lần gửi lại của nó có thể trả tiền hai lần. Sổ được đọc lại từ localStorage mỗi lần dùng và gộp theo từng bản ghi (`ledgerNow`): ở bản web chế độ Phát
   triển, một tab khác (dự án khác, hoặc Nhập job) ghi vào cùng sổ không xoá bản ghi của tab này.
3. Take nhập sinh ra ở trạng thái **`processing` có sẵn `remoteId`** (`useRuns.importTakes`, đồng bộ): engine chỉ theo
   dõi + tải video (poster, tự tải, lưu vào Thư mục như mọi take), **không bao giờ gửi**; không chiếm chỗ trong 10 job
   gửi cùng lúc (vẫn được tính trong "Cập nhật khi xong"). `charged: false`, `provider` = cổng đã quét. Ghi vào sổ
   **`imported[take.id]`** của adapter đang chạy take (`gatewayProvider` = instance trong registry) — kiểm tra lại ngay
   lúc ghi: khoá đã có job / đã gửi, job SanoVids tạo, job đã nhập (trừ khi chọn nhập lại), cùng một job hai lần, job mà
   một `POST` chưa rõ có thể sở hữu → bỏ. Khoá có trong `imported` không bao giờ được `POST` (`submit` / `recover` trả
   luôn job đó). Đổi sang dự án khác trong lúc đọc prompt → không nhập, không ghi gì ("Đã mở dự án khác — chưa nhập gì.").
   Cảnh bị xoá, job đã có trong dự án → bỏ qua. 401 khi đọc prompt → không nhập gì (nút Đăng nhập rồi quét lại).
4. Tìm job của câu trả lời bị mất (`findJob`, danh sách không có `client_request_id`): **mọi** job đã nhập (sổ
   `imported`) bị loại — job nhập trước lần `POST` đó đã có trong danh sách trước khi gửi; job nhập sau đó đã qua
   `sentMayOwn` với chính bản ghi `sent` này (bước 2), tức tạo ngoài khoảng của lần gửi, nên không thể là job của nó →
   không bao giờ nhận nhầm (hai take cùng một job), không làm take "không rõ" mãi. Job tạo trên trang mà **chưa nhập**:
   job có từ trước lần `POST` nằm trong `before` (đọc danh sách ngay trước `POST`, bước 5 của "Gửi", và mọi lần đọc
   khác của trang) nên không bao giờ bị nhận là job của nó; job tạo sau lần đọc đầu tiên chắc chắn thấy job của lần gửi
   đó cũng không (`covered`) — vẫn nhập được. Lần đọc đó tới muộn (app đóng lâu sau khi mất câu trả lời) thì job tạo
   trên node trong khoảng đó bị giữ cho take kia (có thể là của nó) tới khi take đó tìm ra job của mình: cùng prompt →
   take đó nhận (cùng yêu cầu, trả một lần); prompt khác → take đó "không rõ", job đó không nhập được (tải video trên
   canvasapp.io.vn) — bất tiện, không bao giờ trả hai lần. Trường hợp còn lại (hiếm, không tránh được khi danh sách không có `client_request_id` — VERIFY): job tạo
   trên trang cùng node (mọi node, nếu danh sách không ghi `canvas_node_id`) mà chưa lần đọc nào của trang thấy trước
   `POST` (từ lần đọc ngay trước `POST` — cổng còn trả danh sách từ cache: lần đọc gửi ≤ 15 s trước, nên tới 30 s trước
   `POST`; hoặc lần đọc được gần nhất; với lần gửi lại sau khi mất câu trả lời: lần đọc "không có" ngay trước nó) tới lần
   đọc đầu tiên chắc chắn thấy job của nó (≈ 45 s sau câu trả lời / lỗi; tới 5 phút 45 s khi trang tải lại lúc main còn gửi;
   lâu hơn nếu danh sách không đọc được), rồi câu trả lời bị mất → canvasapp cho job đó **đúng prompt** của take (node như
   SanoVids để lại; prompt khác → không bao giờ nhận, xem "Gửi"): take "không rõ" khi `POST` đã tới canvasapp (hai job
   cùng có thể là của nó), hoặc, nếu `POST` không tới, nhận job đó — cùng prompt, cùng node, model / thời lượng như danh
   sách ghi, trả tiền một lần (người dùng đã bấm trên trang). Không bao giờ trả tiền hai lần.
5. Danh sách job **không** cho biết độ phân giải, chế độ (trừ Seedance chỉ có t2v), prompt, ảnh. Prompt lấy từ
   `/prompt` (trống / không đọc được / dài hơn 20.000 ký tự → **không rõ**). Phần còn lại chỉ được **đoán** (`inferred`,
   hiện "≈") khi node trên canvas đã lưu (hoặc mục SanoVids đã nhớ của node đó) có cùng prompt, model, thời lượng, tỷ lệ
   với job; ảnh tham chiếu đoán được khi mọi upload của node ứng với ảnh trong máy (cache upload) và một nhân vật của dự
   án. Không đoán được → **không rõ** (`unknown`, giá trị giữ chỗ, hiện "?"). Node có thể đã đổi từ lúc tạo job (ví dụ chỉ
   đổi độ phân giải rồi SanoVids ghi đè lại) nên giá trị đoán **không bao giờ** được coi là chắc chắn: chi phí "≈ 20
   credit" (không rõ độ phân giải / thời lượng → "—"); "Khôi phục prompt này" tắt khi không rõ prompt hoặc ảnh tham
   chiếu, và chỉ khôi phục cấu hình chắc chắn — trường đoán / không rõ giữ giá trị của cảnh (thông báo nói rõ "không rõ"
   hay "chỉ đoán được"); model của take không có giá trị đó của cảnh → đặt mặc định của model đó (`restorePlan.defaulted`,
   thông báo "đặt … mặc định của <model> (…; giá trị của cảnh không có ở model này) — hãy kiểm tra"); ảnh tham chiếu và chế độ đi cùng nhau (`importedTake.restorePlan`): job gửi ảnh tham chiếu →
   khôi phục ảnh đoán theo node **cùng** chế độ cần cho chúng (kể cả chế độ đoán, thông báo ghi "đoán"); job không gửi
   ảnh (MiniMax-H3 Text → Video / Khung đầu → cuối, có thể chỉ đoán) → cảnh giữ ảnh tham chiếu của nó (không bao giờ
   xoá trắng); @video của cảnh luôn giữ (canvasapp không gửi video tham chiếu); khung hình không khôi phục (như mọi
   take). Xem take so sánh với cảnh chỉ trên những gì chắc chắn ("Take nhập — không đủ dữ liệu để so với cảnh").
6. "Chạy lại" / "Thử lại" một take nhập → hộp xác nhận chi phí → **take MỚI** (khoá mới, cấu hình hiện tại của cảnh).
   "Bỏ nhập" (nút trên thông báo) xoá các take vừa nhập (chỉ hỏi khi một take đang là @video); job vẫn còn trên trang, lần
   quét sau hiện lại với nhãn "đã nhập trước" (không tick sẵn). Hiển thị: chip **nhập** trên node / hàng đợi, dòng
   "Nguồn" trong Xem take, "?" / "≈" ở mọi chỗ ghi cấu hình (`components/runs/importedTake.ts`).
Lời khuyên: nhập **trước** khi chạy lại cảnh đó trong SanoVids (lần `PUT` canvas sau của SanoVids ghi đè node đã sửa trên
trang, mất gợi ý cấu hình; và không có job nào của trang chưa nhập nằm cạnh lần gửi đó); đóng tab phiên "SanoVids bridge" trên trình duyệt trước khi chạy cảnh trong SanoVids (trang tự
lưu canvas có thể gỡ node SanoVids vừa thêm → job bị từ chối, không trừ credit).

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
| Giới hạn tần suất, Cloudflare | ≤ 2 request API + ≤ 2 lượt tải video song song, ≤ 10 job, một lần đọc danh sách job mỗi chu kỳ poll (≥ 15 s) cho mọi job + một lần ngay trước mỗi `POST /api/video-jobs`, cache danh sách job; 429 → nghỉ dần. Không có cơ chế vượt Cloudflare: nếu bị chặn thì dừng |
| CSRF / Origin | gửi `X-CSRF-Token` từ cookie (lời gọi API không theo chuyển hướng nào: token không bao giờ đi sang địa chỉ khác, kể cả http); **không** giả `Origin`. Nếu máy chủ bắt buộc `Origin` = canvasapp → nhận 403 → cần bên vận hành hỗ trợ |
| Trả tiền hai lần | `client_request_id = clientRequestIdFor(take.id)` (UUID cố định theo take); sổ `jobs`/`sent`/`imported` (localStorage `bdp:canvasapp:jobs`, giữ cả khi đăng xuất); khoá đã có job (kể cả job nhập) không bao giờ `POST` lại; take nhập không bao giờ được gửi, "Chạy lại" tạo take mới; nhập không bao giờ nhận job mà một lần gửi chưa rõ có thể sở hữu; câu trả lời mất → tìm job trong danh sách trước, chỉ gửi lại 1 lần cùng khoá (cùng node như lần đầu) và chỉ sau một lần đọc chắc chắn thấy job đó nếu có (`listedBy` + cache của cổng); giờ tạo (`created_at`, đồng hồ của canvasapp) không bao giờ loại job, model / thời lượng / `creation_mode` danh sách ghi khác yêu cầu chỉ làm job đó không được nhận ("không rõ"), không bao giờ là "không có"; job một lần đọc đã thấy có thể là của nó mà biến mất khỏi danh sách (xoá trên trang, cắt trang) → "không rõ", không gửi lại; tự gửi lại (sau mất câu trả lời, `recover()`, take lưu chậm) chỉ khi danh sách được đọc đủ sớm sau mốc job phải hiện (`NOT_MADE_FRESH_MS`), không thì chỉ "Chạy lại"; không `POST` nào đi khi chưa có lần đọc danh sách (`before`) hoặc khi bộ nhớ không giữ được bản ghi `sent` của nó; vẫn không rõ → `UNKNOWN_SUBMIT_ERROR`, không tự gửi; huỷ trước `POST` → không gửi; mỗi dự án một node cho mỗi cảnh; đọc danh sách job ngay trước mỗi `POST` (job đã có trên node — của take khác hay tạo trên trang mà chưa nhập —, và mọi job trang đã thấy trong lần đọc khác, không bao giờ là job của lần gửi đó; lần gửi lại sau mất câu trả lời cũng vậy; lần đọc đó thấy job mang khoá của take → không gửi); job có thể là của một take khác còn chưa rõ trên cùng node → không nhận (cạnh take như vậy: chưa có lần đọc nào chắc chắn thấy job của nó → take đó chờ trong hàng đợi, `rivalWait`; đọc không được → không gửi); `POST` có thể còn đang tới canvasapp (trang tải lại khi main còn gửi: `endedAt` / `listedBy`) → "Chạy lại" chưa gửi lại, take khác không nhận job của nó; câu trả lời cache của cổng (tính từ lúc gửi request) không bao giờ được coi là mới hơn thực tế — và không bao giờ được dùng khi ghi giờ muộn hơn hiện tại (đồng hồ bị chỉnh lùi); job chỉ khớp theo node và giờ chỉ được nhận từ lần đọc chắc chắn thấy job của chính lần gửi đó, khi canvasapp trả đúng prompt của nó cho job ấy, và không bao giờ là job có sau lần đọc chắc chắn đầu tiên (`covered`); danh sách không ghi node (danh sách trống: theo lần có job gần nhất, giữ trên máy) → mọi lần gửi chưa rõ trong phiên là "take kia" của nhau; huỷ một take đang gửi → giữ "không rõ" ngay ("Thử lại" = chính take đó, không bao giờ take mới); `remoteId` về khi dự án đã đóng → engine giữ và trả lại khi mở dự án; sổ đọc lại từ localStorage mỗi lần dùng (nhiều tab). Test: `providers/__tests__/canvasapp-e2e.test.ts`, `canvasapp-adapter.test.ts`, `dev-e2e.test.ts`, và mô phỏng lỗi ngẫu nhiên có hạt giống `canvasappFuzz.ts` (`canvasapp-fuzz-1…4.test.ts`, xem dòng dưới) |
| Bất biến được kiểm bằng mô phỏng (`canvasappFuzz.ts`, chạy chia 4 tệp `canvasapp-fuzz-1…4.test.ts` song song) | adapter + engine thật, mô hình main (khối `<canvasapp-routes>` / `<canvasapp-lanes>` / `<canvasapp-job-list-cache>` chạy nguyên văn, hết giờ 60 s, request vẫn đi sau khi trang đã tải lại), máy chủ giả nghiêm ngặt; mỗi hạt giống một kịch bản: dedupe tắt / bật (hoặc 409), danh sách có / không `client_request_id`, `canvas_node_id`, model / thời lượng — hay ghi giá trị khác cho job SanoVids tạo (`creation_mode` 'api', thời lượng thật của clip, tên model hiển thị), danh sách chỉ giữ vài job mới nhất (cắt trang), `created_at` có múi giờ / không múi giờ ở múi khác / giây Unix / mili giây / không đọc được / thiếu, đồng hồ máy chủ lệch tới ba ngày; 1–3 dự án (cả bản sao cùng id cảnh), job tạo / xoá trên trang + Nhập job, sổ chỉ giữ vài chục bản ghi job, lỗi ngẫu nhiên (không tới máy chủ, đã xử lý nhưng mất câu trả lời, chậm quá 60 s, 5xx / 429 / 402, đọc danh sách hỏng / từ cache, tải lại trang ở bất kỳ lúc nào, huỷ — cả take đang gửi rồi "Thử lại" ngay —, "Chạy lại", take mới cho take hỏng / đã huỷ, đổi dự án, đăng xuất / đăng nhập, chỉnh lùi đồng hồ, bộ nhớ đầy), rồi mạng lành và "Chạy lại" mọi take "không rõ". Kiểm: không khoá nào có hai job, kể cả job đã xoá (dedupe tắt); không take nào báo "chưa trừ" (hỏng / huỷ, không "không rõ", không `remoteId`) mà canvasapp có job của nó; không job nào là của hai take, job nhập không bao giờ là job của take SanoVids; `remoteId` của take SanoVids mang đúng `client_request_id` của nó (ngoài rủi ro còn lại (1), chỉ khi job đó chưa lần đọc nào trước `POST` cuối thấy); hết hàng đợi / "đang gửi"; "không rõ" chỉ khi thật sự không phân biệt được (job khác không loại được, job của nó bị danh sách ghi khác yêu cầu, job có thể là của nó đã biến mất, take kia có thể sở hữu); không lỗi chưa bắt, không hẹn giờ sót. `npm test` chạy 80 hạt giống (20 mỗi tệp, ~2 s mỗi tệp); `SANOVIDS_FUZZ_SEEDS=5000` chạy nhiều hơn, `SANOVIDS_FUZZ_SEED=n` in toàn bộ diễn biến của một hạt giống; dòng tổng kết chỉ in khi tự chọn hạt giống |
| Rủi ro còn lại (cần VERIFY trên canvasapp thật) | (1) Danh sách job không có `client_request_id`: một job tạo trên trang từ đúng node đó (mọi node nếu danh sách không ghi `canvas_node_id`) với **cùng prompt** (và model / thời lượng, nếu danh sách ghi) trong khoảng từ lần đọc trước `POST` tới lần đọc chắc chắn đầu tiên, khi `POST` của take không tới canvasapp → take nhận job đó (cùng yêu cầu, trả một lần, không bao giờ trả hai lần); khi `POST` có tới → "không rõ". (2) Cược `SETTLE_MS`: job của một `POST` có trong danh sách chậm nhất 30 s sau khi câu trả lời / lỗi về (hoặc sau 5 phút nếu trang tải lại lúc gửi); canvasapp tạo job muộn hơn thế → lần đọc "không có" có thể gửi lại. (3) Đồng hồ máy bị chỉnh **tới** (nhảy về sau) trong vài chục giây sau khi mất câu trả lời làm các mốc thời gian đến sớm như (2). Chỉnh lùi: an toàn (chờ lâu hơn, hai take cùng node có thể "không rõ"). (4) `GET …/prompt` phải trả prompt như đã gửi (cắt khoảng trắng hai đầu): nếu canvasapp đổi prompt, job tìm theo node và giờ không bao giờ được nhận ("không rõ", không bao giờ gửi lại). (5) Bộ nhớ đầy rồi tải lại trang: điều trang biết mà chưa ghi được (`covered`, `seen`) bị mất — rơi về (1). (6) Job của một lần gửi mất câu trả lời bị xoá trên trang canvasapp (hoặc trôi khỏi danh sách cắt trang) **trước khi** SanoVids kịp đọc danh sách thấy nó, trong `NOT_MADE_FRESH_MS` (5 phút) sau mốc nó phải hiện: không phân biệt được với "không có" → gửi lại. (7) Take "không rõ" mà danh sách chỉ được đọc lần đầu lâu sau lần gửi (app đóng): job tạo trên node trong khoảng đó, prompt khác, bị giữ cho take đó (không nhập được, take vẫn "không rõ") — tải video trên canvasapp.io.vn; không bao giờ trả hai lần. (8) Sổ `jobs` giữ 2000 bản ghi mới nhất: app đóng / sập trong ≤ 3 s sau khi một take vừa có job (take trên đĩa còn "đang gửi"), mở lại vào dự án khác, rồi hơn 2000 job khác trước khi mở lại dự án đó, và danh sách không ghi `client_request_id` → take đó "không rõ", "Chạy lại" khi đó gửi lại (trả hai lần). Đổi dự án lúc đang gửi thì không (engine giữ `remoteId`: `lateRemoteIds`) |
| 401 (hết phiên) | submit: take `failed` "Chưa đăng nhập…" (không tốn credit); poll: take giữ nguyên, `providerIssue` báo đăng nhập lại, poll tự tiếp tục sau khi đăng nhập |
| Huỷ | canvasapp không có API huỷ rõ ràng (`DELETE` có thể không hoàn tiền) → huỷ trong SanoVids **chỉ ngừng theo dõi**; job vẫn chạy và tính tiền trên canvasapp |
| Google chặn đăng nhập trong cửa sổ nhúng | dùng email/mật khẩu trên trang canvasapp; không giả User-Agent |
| Video lớn qua IPC | Tải về: từng phần ≤ 4 MiB (`canvasapp:downloadOpen/Read/Close`), ≤ 1 GB, dừng sau 60 s không có dữ liệu, tải tiếp bằng Range khi canvasapp cho (xem §4 "Tải kết quả"). GET qua `net.request` (chỉ theo chuyển hướng https); luồng thân (`IncomingMessage` của Electron qua Node `Readable.toWeb`) chỉ xin thêm dữ liệu từ mạng khi được đọc — chưa kiểm chứng trên bản build: RAM của main khi trang đọc chậm (VERIFY, §9). **Còn lại**: lưu video lớn ra đĩa (tự tải, nút Thư mục, "Hỏi nơi lưu") vẫn gửi cả file qua IPC một lần (`files:saveAs` / `files:writeToFolder`, ≤ 1 GB) — cần làm từng phần như trên |
| Người dùng dùng phiên "SanoVids bridge" trên canvasapp | **Chạy** một node ở đó thì được — job nhập vào SanoVids bằng "Nhập job" (§4). **Sửa** node thì bị ghi đè ở lần gửi sau của SanoVids: nhập job trước khi chạy lại cảnh đó trong SanoVids. Đóng tab phiên này trước khi chạy cảnh trong SanoVids: trang tự lưu canvas có thể gỡ node SanoVids vừa thêm → job bị từ chối (không trừ credit) |

## 7. Bật thử

1. Chạy bản desktop: `npm run desktop` (hoặc cài `SanoVids-Setup-*.exe`).
2. Mở Cài đặt › **Nâng cao** (mục cổng là `GatewaySection`, `src/components/dialogs/GatewaySection.tsx`).
3. Cài đặt › Nâng cao › **Cổng canvasapp.io.vn** › **Đăng nhập canvasapp** → đăng nhập trên trang canvasapp → cửa sổ tự đóng, thấy số credit.
4. Chọn **canvasapp.io.vn** ở "Nhà cung cấp video cho take mới". Từ giờ take **mới** đi qua canvasapp; take đang chạy giữ nơi đã gửi.
5. Muốn quay lại: chọn **Phát triển (giả lập)** hoặc **Đăng xuất**.

## 8. Còn phải làm (TODO)

- [x] Lead: mount `GatewaySection` trong `SettingsDialog` (khối của `GROUPS`); `canvasapp?: CanvasappBridge` trong `DesktopInfo` (`lib/pwa.ts`).
- [x] Lead: `provider`, `remoteId`, `charged`, `framesSnapshot` nằm trên `Take` (`core/types.ts`) + giá trị mặc định trong `migrateTake` (`core/migrate.ts`).
- [x] UI: nhãn nhà cung cấp trên take node / hàng đợi (`PROVIDER_LABEL`, `providerOf`); hộp xác nhận chạy (`RunConfirmDialog`) ghi đúng loại credit (dev / canvasapp / demo cũ) và chỉ demo cũ bị chặn vì thiếu credit demo; `useRuns.providerIssue` hiện ở thanh trên cùng, hàng đợi và mục cổng trong Cài đặt.
- [x] Đọc `/api/video-profiles` trước khi gửi (adapter, nhớ 10 phút) và từ chối điều trang canvasapp không chạy.
- [x] Dùng `/api/video-profiles` (cùng luật với submit, `settingsLimits()` của adapter) để giới hạn lựa chọn model / chế độ /
  thời lượng / độ phân giải / tỉ lệ trong inspector (một cảnh và nhiều cảnh), nút Chạy và hộp Chạy — xem §4 "Cấu hình
  model trong inspector". `capabilities()` dùng cùng luật đó. Còn cần thử trên máy chủ thật: `/api/video-profiles` có
  cần đăng nhập không, `visible` / `enabled` có làm trang ẩn / làm mờ model không, máy chủ có tự từ chối thời lượng /
  độ phân giải / tỉ lệ ngoài danh sách không, và danh sách có thể có giá trị SanoVids chưa biết (4K, 20 s, 21:9) không.
- [x] Node video theo cảnh **của dự án**: `JobRequest.sanovidsProjectId` + `sceneId` → `sceneNodeKey` → `canvasNodeId` (trước đây chỉ theo `sceneId`: hai dự án có cùng id cảnh — nhân bản / nhập cùng tệp hai lần — dùng chung một node, và khi danh sách job không có `client_request_id`, take "không rõ" của dự án này có thể nhận nhầm job của dự án kia rồi take kia gửi lại → trả tiền hai lần nếu máy chủ không dedupe). Không chuyển đổi dữ liệu: job đang chạy / take gửi dở từ bản trước giữ node cũ, gửi lại cũng trên node cũ; bản cũ hơn vẫn đọc được mục mới. Thêm: mục canvas đã nhớ chỉ gồm các cảnh có trên canvas (≤ 40); khi tìm job của câu trả lời bị mất, không nhận job mà một take khác còn chưa rõ trên cùng node có thể sở hữu (trước khi `POST` cạnh take như vậy: đọc lại danh sách job, đọc không được → không gửi), và bỏ qua job đã có trong lần đọc danh sách trước `POST`. Test: `canvasapp-mapping`, `canvasapp-adapter`, `canvasapp-e2e` ("projects sharing scene ids"), `dev-e2e` ("a duplicated project", "a lost answer next to a duplicated project" — lỗi `lost-response` / `network` + công tắc dedupe của máy chủ giả lập); Bảng phát triển › Job & đơn nạp ghi node của mỗi job ("node S03" / "node cũ S03" / "node khác").
- [ ] VERIFY với máy chủ thật: dạng phản hồi `POST /api/video-jobs`; máy chủ có dedupe `client_request_id` không; `/stream` có chuyển hướng không; API của canvasapp có trả 3xx không (hết phiên, chưa đăng nhập, host chuẩn, dấu `/` cuối) — SanoVids không theo chuyển hướng nào ở API (`redirect: 'error'`): một 3xx như vậy thành lỗi `network` chứ không phải 401, nên lời nhắc đăng nhập không hiện. (Đã đối chiếu với `canvas.js`: `order` bắt đầu từ 1; `GET /api/projects` trả mảng; dạng canvas / body job — xem `docs/canvasapp-api-notes.md`.)
- [ ] VERIFY (chống trả tiền hai lần): job trong `GET /api/video-jobs` có trường `client_request_id` không (có → khớp chính xác); `created_at` có múi giờ không; mã lỗi khi thiếu credit (400 hay 402) và `detail`; hai take của **cùng một cảnh** chạy song song trên cùng `canvas_node_id` có bị từ chối không; job có bị huỷ/xoá khi node của nó rơi khỏi canvas cầu nối (giới hạn 40 node) không — từ v0.2.5 node của job đang chạy không bao giờ bị gỡ (take mới chờ trong hàng đợi khi hết chỗ), nên nếu không bị huỷ thì có thể nới quy tắc này cho chạy được nhiều cảnh nhiều ảnh hơn; danh sách job có trường `canvas_node_id` không (không có → dùng node ghi trong sổ `jobs`, chỉ có với job tạo từ v0.2.5); danh sách job có bị cắt trang (job đang chạy cũ có biến mất không).
  Thêm: danh sách ghi `client_request_id` cho **mọi** job hay chỉ một số (chỉ một số → job không ghi khoá vẫn được xét
  theo node và giờ); `GET /api/video-jobs/{id}/prompt` trả **đúng** prompt đã gửi (đã cắt khoảng trắng hai đầu) — từ
  nay job tìm theo node và giờ chỉ được nhận khi prompt khớp; job có trong danh sách chậm nhất 30 s sau khi câu trả lời
  / lỗi của `POST` về (`SETTLE_MS`, mọi quy tắc "không có → gửi lại" dựa vào nó).
- [x] Mô phỏng lỗi ngẫu nhiên có hạt giống (`providers/__tests__/canvasappFuzz.ts`, chạy qua `canvasapp-fuzz-1…4.test.ts`, §6): adapter + engine thật,
  mô hình main, máy chủ giả nghiêm ngặt, hàng nghìn kịch bản. Đã tìm và sửa: (1) job chỉ khớp theo node và giờ được nhận
  từ lần đọc **quá sớm** — trang tải lại lúc main còn gửi, một job tạo trên trang vừa hiện, job của chính take chưa hiện
  → take nhận job của trang (giờ: chỉ từ lần đọc chắc chắn, và chỉ khi prompt khớp); (2) danh sách không ghi
  `canvas_node_id`: take khác cảnh không được coi là "take kia" → hai take nhận nhầm job của nhau, take kia gửi lại (trả
  hai lần); (3) job tạo trên trang **sau** lần đọc đã chắc chắn thấy job của một lần gửi chưa rõ vẫn bị nhận cho nó (và
  bị giữ không cho nhập 14 giờ) — giờ ghi `covered`, kể cả khi lần đọc khác ghi trong lúc câu trả lời đang về; (4) đồng hồ
  chỉnh lùi: cache danh sách job của main / cầu nối giả lập / poll dùng tiếp câu trả lời ghi giờ "tương lai" (lần đọc cũ
  coi như chắc chắn → gửi lại; poll đứng yên hàng giờ), lần đọc mà bản ghi job đã có giữ lại không được ghi lại theo
  giờ mới (loại nhầm job của take khác → gửi lại); (5) danh sách chỉ ghi khoá cho một số job: "có khoá mà không thấy khoá
  của mình" thành "không có" → gửi lại; (6) một job vừa thành của take khác (tab khác, Nhập job) trong lúc tìm vẫn có
  thể bị nhận lần nữa. Thêm: `recover()` chờ tới khi một lần đọc chắc chắn thấy job (không "không rõ" sớm), không có →
  take về hàng đợi, gửi lại cùng khoá. Mỗi lỗi có test riêng (`canvasapp-adapter.test.ts` "what the seeded
  fault-injection simulation found", `gatewayLanes`, `dev-server`, `canvasapp-siteJobs`).
  Vòng xem xét sau đó (mô phỏng được mở rộng tới đó: đồng hồ lệch tới ba ngày, giá trị lạ trong danh sách, xoá job trên
  trang, danh sách cắt trang, huỷ khi đang gửi rồi "Thử lại", sổ chỉ giữ vài chục bản ghi, bất biến "take báo chưa trừ
  mà có job"): (7) giờ tạo ngoài ±14 h / ±27 h loại job của chính nó → "không có" → gửi lại; nay giờ không bao giờ loại
  job (Nhập job cũng không nhả job đó); (8) `creation_mode` / thời lượng / model khác yêu cầu → "không có" → gửi lại; nay
  chỉ làm job đó không được nhận; (9) lần gửi lại tự động giữ `before` của lần đầu → job tạo trên trang ngay trước đó
  bị nhận (hoặc làm job thật "không rõ"); nay `before` là mọi job đã thấy; (10) `recover()` tự gửi lại một bản ghi cũ bao
  lâu cũng được, cả khi job đã bị xoá → trả hai lần; nay chỉ khi danh sách được đọc đủ sớm (`NOT_MADE_FRESH_MS`), job đã
  thấy rồi biến mất → "không rõ"; (11) "Huỷ" lúc đang gửi rồi "Thử lại" ngay → take mới, khoá mới → trả hai lần; nay
  "không rõ" ngay lúc huỷ (`mayHaveBilled`); (12) danh sách trống làm mọi cảnh chờ tới 5 phút 45 s với lý do sai; (13)
  sổ `jobs` cắt ở 500 → take của dự án đóng lâu "không rõ" rồi gửi lại; nay 2000 + `lateRemoteIds`, và lần đọc trước
  `POST` thấy job mang khoá của take thì không gửi; (14) cache của main / cầu nối giả lập để câu trả lời chậm của request
  gửi trước đè câu trả lời của request gửi sau; (15) sổ bỏ bản ghi job của take khác (cắt theo số lượng) → job đó lại
  thành "có thể" của một lần gửi chưa rõ đi với lần đọc cũ → take nhận job của take khác (một job hai take); nay ghi trên
  bản ghi `sent` (`taken`). Test: `canvasapp-adapter` "R8…", `runs-engine` "review: …",
  `canvasapp-e2e` "review: …", `gatewayLanes`, `dev-server`.
- [x] UI: nút "Chạy lại" của take `UNKNOWN_SUBMIT_ERROR` gọi `useRuns.getState().retry(take.id)` (gửi lại CHÍNH take đó, cùng khoá, hỏi xác nhận trước) thay vì tạo take mới: `actions.rerunTake` (take node, hàng đợi, xem take).
- [ ] Video tham chiếu `@video_N`: tìm cách canvasapp nhận video (nếu có) rồi mở `maxRefVideos`.
  - **Chưa mở — chưa có bằng chứng canvasapp nhận video tham chiếu**: mọi dạng yêu cầu đã ghi nhận chỉ có ảnh (xem
    `docs/canvasapp-api-notes.md` "Reference videos (@video_N) — not observed", kèm danh sách hàm `canvas.js` cần ghi
    lại). Không mở khi chưa có dạng yêu cầu thật: một body lạ bị 422 (không mất tiền), nhưng một job được nhận mà bỏ
    qua video thì vẫn bị trừ credit cho một video sai. Cần: các hàm trong danh sách đó + xác nhận của bên vận hành.
  - Đã làm (0.6.0): một nguồn duy nhất cho cổng `@video` — `capabilities().maxRefVideos` (canvasapp và chế độ Phát
    triển: `CANVASAPP_MAX_REF_VIDEOS = 0`, `providers/capabilities.ts`); quy tắc chặn chạy dùng chung
    `core/runGate.ts` `runBlockReason` cho `useRuns.check()` và mọi nút Chạy một cảnh — thẻ cảnh trên canvas, hai nút
    Chạy trong inspector (trên đầu + mục Take), thẻ Storyboard, hàng Bảng cảnh (`runs/shared.useSceneRunBlock`); nút
    chạy cả vùng chọn chỉ mở hộp xác nhận, hộp này bỏ qua cảnh bị chặn kèm đúng lý do đó (trước
    đây thẻ / inspector chặn mọi cảnh có `videoRefs`, kể cả H3 t2v / transform không gửi video mà hộp xác nhận vẫn
    chạy; lý do trong chế độ Phát triển ghi "Cổng canvasapp chưa…"). Chỉ tính video thật sự gửi (`compiled.videos`);
    vượt mức của cổng → từ chối, không bao giờ cắt bớt. `validateRequest` vẫn từ chối mọi `req.videos` (không theo
    cap). Test: `core/__tests__/runGate.test.ts`, `runs-engine`, `canvasapp-adapter`, `canvasapp-e2e` / `dev-e2e`
    ("reference videos": không một request nào, không trừ credit).
  - Khi đã có dạng thật, cần sửa: `api.ts` (`CanvasNode` / `target_handle` / `VideoJobBody`, hàm tải video nếu là
    upload); `mapping.ts` (`InputShape` / `slotsOf` / `planBridgeCanvas` đếm node mới vào giới hạn 40 node,
    `toVideoJobBody` thêm khoá đúng thứ tự, `validateRequest` đổi từ chối chung thành kiểm tra giới hạn / chế độ);
    `adapter.ts` (`CANVASAPP_MAX_REF_VIDEOS` hoặc theo profile; kiểm tra blob của mọi video tham chiếu trước khi tải
    lên / `PUT` — cả trên đường gửi lại take "không rõ", vốn không qua `check()` —, cache tải lên theo take, MIME:
    take dev là WebM từ `lib/mockProvider.ts`, take thật là MP4); **chỉ nhận take tham chiếu của đúng cổng đang gửi**
    (`providerOf(take)` = `'canvasapp'`, không bao giờ take `'dev'` / `'mock'` — video giả không được lên canvasapp;
    nếu theo job id thì cùng tài khoản và phiên bridge), `buildRequest` (`store/runs.ts`) mang thêm `remoteId` nếu cần;
    `electron/main.cjs` `<canvasapp-routes>` + MIME của `multipartBody` + giới hạn kích thước riêng ("Ảnh lớn hơn
    20 MB" chỉ cho ảnh); chế độ Phát triển: `dev/routes.ts` (test đối chiếu), `dev/validate.ts`, `dev/server.ts`
    (upload, job, nhãn `@video_N` trong video giả), `devModel.characterCheck` + "Kiểm tra nhân vật", một lỗi giả lập
    cho endpoint mới; các chỗ còn đọc giới hạn của MODELS thay vì của cổng (nối / đếm / đánh số: `PromptEditor`,
    `SceneInspector` "N/10 video", `CanvasView` khi nối dây, `store/project.ts` `linkTakes`, `compile.ts`
    `videos` / `unsentTokens`, `runs.ts` `buildRequest`) — hoặc giữ `refVideosProblem` là lời từ chối (không cắt bớt);
    test `canvasapp-mapping` (bộ khoá), `canvasapp-e2e` (máy chủ giả chặt), `dev-server`, `dev-e2e`; lần thử thật đầu
    tiên theo kiểu `docs/TEST-REAL-CREDITS.md`, cấu hình rẻ nhất (Seedance 480p 5 s = 4 credit).
- [x] Tải video lớn: không gửi cả video qua IPC một lần — trang kéo từng phần ≤ 4 MiB từ main (`canvasapp:downloadOpen` /
  `downloadRead` / `downloadClose`, khối thuần `<canvasapp-downloads>` của `electron/main.cjs` + bản TS
  `providers/dev/downloads.ts`, chạy song song trong `gatewayDownloads.test.ts`), giữ một chỗ trong làn tải từ đầu tới
  cuối mỗi kết nối, dừng sau 60 s không có dữ liệu, 60 phút mỗi kết nối (`too-slow`), ≤ 1 GB, tiến độ "Đang tải về …%",
  huỷ / đổi dự án dừng tải ngay (huỷ một video đã xong thì hỏi trước), tải tiếp bằng Range + If-Range chỉ khi có
  validator và 206 phải mang đúng validator đó, mở lại khi mạng chưa có lại thì chờ rồi thử lại (giữ phần đã nhận),
  GET qua `net.request` chỉ theo chuyển hướng https (`<canvasapp-net-get>`), `canvasapp:request` không nhận `/stream`.
  Chọn cách này thay vì ghi file tạm trong main (phải phục vụ file ngoài `dist/` qua `app://bdp`, dọn đĩa, không giả lập
  được trên web); `download-token` không cần (xem §4). Chế độ Phát triển chạy đúng luật đó (lỗi giả "Mất mạng giữa
  chừng", "Tải video bị treo", "Tải video chậm", "Tải video rất chậm" (giới hạn 2 phút mỗi kết nối ở chế độ Phát triển),
  "Tải video bị chuyển sang http", "Video quá lớn", công tắc "Cho tải tiếp video (HTTP Range)"; tải chậm chia phần
  ~250 ms nên kể cả 1 KB/giây không bị dừng vì 10 giây không có dữ liệu). Test: `gatewayDownloads`,
  `canvasapp-download`, `canvasapp-e2e`, `dev-server`, `dev-e2e`, `runs-engine`, `creditText`, `hardeningRules`,
  `devModel`. Còn VERIFY trên máy chủ thật: `/stream` có Content-Length, Accept-Ranges, ETag / Last-Modified, có nén không,
  có chuyển hướng (CDN, luôn https?) không, kích thước video thường gặp; RAM của main khi trang đọc chậm (luồng của
  `net.request` chỉ xin thêm dữ liệu khi được đọc). (Chỉ phần tải về — việc lưu ra đĩa là mục riêng bên dưới.)
- [ ] Lưu video lớn ra đĩa theo từng phần: tự tải, nút Thư mục và "Hỏi nơi lưu" vẫn gửi cả file qua IPC một lần
  (`files:saveAs` / `files:writeToFolder`, ≤ 1 GB) — cần làm từng phần như phần tải về (§6 "Video lớn qua IPC").
- [x] Đồng bộ ngược: nhập các job đã tạo trên canvasapp (trong phiên bridge) thành take — "Nhập job" (§4): chỉ đọc
  (`GET`), take nhập sinh ra `processing` có `remoteId` (chỉ theo dõi + tải, không bao giờ gửi, "Chạy lại" = take mới),
  sổ `imported` (không bao giờ `POST` khoá đó; `findJob` loại mọi job đã nhập, job chưa nhập có từ trước lần gửi — đọc
  danh sách ngay trước mỗi `POST` — và job tạo sau lần đọc chắc chắn đầu tiên, `covered`), không nhập job mà một lần gửi chưa
  rõ có thể sở hữu (kiểm tra cả lúc quét và lúc ghi), dự án được ghim, tối đa 20 job / lần, cấu hình chỉ "đoán" (≈) theo
  node có prompt khớp, không rõ (?) thì không tính chi phí / không khôi phục. Chế độ Phát triển: Bảng phát triển › Job &
  đơn nạp › "Tạo job như trên trang canvasapp" (sửa node trước nếu muốn) + nút "Nhập" ở job tạo trên trang, chưa lỗi /
  huỷ / hết hạn, trên node của dự án đang mở (`devModel.mayOfferImport`). Test:
  `canvasapp-siteJobs`, `canvasapp-adapter`, `canvasapp-e2e`, `dev-server`, `dev-e2e`, `runs-engine`, `importedTake`,
  `importJobsModel`, `migrate`, `devModel`. Còn VERIFY trên máy chủ thật: mọi job trong `GET /api/video-jobs` có
  `canvas_node_id` không (không có → không nhập được gì); danh sách có `client_request_id` / `mode` / `resolution` /
  `upload_ids` / số credit không (có → nhập chính xác, không cần đoán); danh sách có cắt trang không (cắt trang: job bị đẩy ra trước khi SanoVids kịp thấy không phân biệt được với "không
  có", §6 (6)), `creation_mode` của job canvas / simple là gì — và của job SanoVids gửi, thời lượng / model ghi đúng như
  gửi không (khác thì job của chính take không bao giờ được nhận theo node và giờ: "không rõ"); `created_at` có múi giờ không (hộp Nhập job hiện giờ không múi giờ đúng như canvasapp ghi; giờ không bao giờ loại job
  của một lần gửi — thử trước ở chế độ Phát triển: Hành vi máy chủ › "Giờ trong danh sách job không có múi giờ",
  `DevConfig.naiveTimes`); `GET /api/projects/{id}` trả `{ canvas: {
  nodes, connections } }` và giữ nguyên dữ liệu node như đã `PUT` không; job H3 transform có `aspect_ratio: null` trong
  danh sách không; `GET …/prompt` trả prompt đã trim như lúc gửi, cho job tạo trên trang và job đã hết hạn không; `GET
  …/stream` có tải được job tạo trên trang không; có thể có nhiều phiên tên "SanoVids bridge" không (nhập chỉ đọc phiên
  đã nhớ, hoặc phiên đầu tiên trùng tên).
- [ ] Khi có API chính thức / token từ bên vận hành: thay `transport.ts` (vd. HTTP + API key do người dùng nhập, lưu bằng `safeStorage`), giữ nguyên `adapter`/`mapping`.

## 9. Kế hoạch thử thủ công (cho người dùng)

> Bản rút gọn, tốn ít credit nhất (8 credit) cho lần tự kiểm tra cuối: **docs/TEST-REAL-CREDITS.md**.

Chuẩn bị: tài khoản canvasapp có ít credit (≥ 30), bản desktop mới build, một dự án SanoVids có 2–3 cảnh ngắn (5 s, độ phân giải thấp nhất để rẻ).

1. **Mặc định an toàn** — mở Cài đặt: "Phát triển (giả lập)" đang chọn. Chạy 1 cảnh → video giả (nhãn DEV) từ canvasapp giả lập, credit dev bị trừ, không gọi mạng.
2. **Bản web** — mở bản web: nút "canvasapp.io.vn" bị khoá, có dòng giải thích chỉ dùng trong bản desktop.
3. **Đăng nhập** — bấm "Đăng nhập canvasapp": cửa sổ trang thật canvasapp mở ra; đăng nhập; cửa sổ tự đóng; Cài đặt hiện "Đã đăng nhập" + số credit đúng như trên canvasapp. Trước khi đăng nhập (và sau bước 10, hết phiên): Cài đặt phải hiện "Chưa đăng nhập" / lời nhắc đăng nhập, **không** phải "canvasapp.io.vn chuyển hướng yêu cầu…" — nếu thấy câu đó, API trả 3xx (ghi lại route nào, §8 VERIFY).
4. **Đóng giữa chừng** — Đăng xuất, bấm Đăng nhập rồi đóng cửa sổ khi chưa đăng nhập → trạng thái "Chưa đăng nhập", không lỗi.
5. **Một video t2v** — chọn canvasapp.io.vn; cảnh Seedance 2.5, 5 s, 480p, không ảnh. Chạy → take "đang tạo", % cập nhật khoảng 20 s/lần. Trên canvasapp.io.vn thấy phiên "SanoVids bridge" và job mới. Khi xong: take có poster + video MP4 phát được, nút "Tải video" lưu file .mp4. Credit canvasapp giảm đúng giá; credit dev (giả lập) **không** đổi.
6. **Ảnh tham chiếu** — cảnh có 2 nhân vật (`@image_1`, `@image_2`). Chạy → trên canvasapp, job có 2 ảnh đúng thứ tự. Chạy lại lần 2 → ảnh **không** bị tải lên lại (xem phiên bridge chỉ có 2 upload).
7. **Nhiều job cùng lúc** — chạy 3 cảnh: cả 3 take cùng "đang tạo" (tối đa 10 job cùng lúc; từ job thứ 11 trở đi thì chờ trong hàng đợi). Tiến độ vẫn cập nhật khoảng 20 s/lần.
8. **Tắt app khi đang tạo** — trong lúc job chạy, đóng SanoVids, mở lại → take vẫn "đang tạo" và hoàn thành; trên canvasapp **không** có job trùng.
9. **Video tham chiếu** — cảnh Seedance có video tham chiếu (`@video_1`): mọi nút Chạy của cảnh đó tắt (thẻ cảnh, cả hai nút trong inspector, thẻ Storyboard, hàng Bảng cảnh; di chuột lên nút để xem lý do), hộp xác nhận bỏ qua cảnh với lý do "Cổng canvasapp (cả chế độ Phát triển) chưa hỗ trợ video tham chiếu (@video) — bỏ video tham chiếu khỏi cảnh để chạy", không tốn credit. Bỏ video tham chiếu (nút × trong inspector hoặc cắt dây) thì chạy được; chỉ xoá chữ `@video_1` thì chưa. Cảnh MiniMax-H3 t2v còn sót video tham chiếu (không có `@video`) vẫn chạy, không gửi video.
10. **Hết phiên** — Đăng xuất trong lúc có take đang chạy → Cài đặt hiện cảnh báo đăng nhập lại; take không bị đánh lỗi; đăng nhập lại → take tiếp tục và hoàn thành.
11. **Huỷ** — huỷ take đang chạy: SanoVids ghi "Đã huỷ"; ghi nhận job trên canvasapp vẫn chạy (đúng như cảnh báo).
12. **Quay lại chế độ Phát triển** — chọn Phát triển (giả lập) → take mới chạy trên canvasapp giả lập, không gọi mạng.
13. **Huỷ lúc đang gửi** — chạy 2 cảnh có ảnh, huỷ take thứ hai ngay (khi take đầu còn đang tải ảnh) → trên canvasapp chỉ có 1 job; take huỷ ghi "không bị trừ credit".
14. **Rút mạng lúc bấm chạy** — tắt Wi-Fi ngay sau khi bấm chạy, bật lại sau ~20 s → take tự tìm lại/gửi lại; trên canvasapp chỉ có **1** job cho take đó.
15. **Cấu hình model theo canvasapp** (không tốn credit) — đã đăng nhập, chọn một cảnh: inspector đọc `/api/video-profiles`.
    Nếu canvasapp đang khoá MiniMax-H3 (hoặc tắt một chế độ): lựa chọn đó hiện "· canvasapp đang tắt", không chọn được;
    cảnh đang dùng nó có ghi chú đỏ, nút Chạy tắt, hộp Chạy ghi "Bỏ qua: …". Bấm **Đọc lại** → thông báo đã đọc lại.
    Ghi lại: khi chưa đăng nhập, `/api/video-profiles` trả 401 hay vẫn đọc được; model `visible: false` / `enabled: false`
    trên trang canvasapp có bị ẩn / làm mờ không. Thử trước trong chế độ Phát triển: Bảng phát triển › Trạng thái › Model.

16. **Rút mạng giữa lúc tải video** (không tốn thêm credit) — cảnh dài / độ phân giải cao để video lớn; khi take hiện "Đang tải về …%", tắt Wi-Fi ~20 giây rồi bật lại → take vẫn "đang tạo/tải", không bị đánh lỗi, rồi xong (tải tiếp hoặc tải lại từ đầu); trên canvasapp vẫn chỉ **1** job. Ghi lại kích thước file, thời gian tải và (nếu xem được) tiêu đề trả lời của `/stream` (`Content-Length`, `Accept-Ranges`, `ETag`, `Content-Encoding`, có chuyển hướng không).
17. **Mạng chậm / huỷ khi đang tải** — trong lúc "Đang tải về …%": bấm Huỷ → SanoVids **hỏi trước** (video đã tạo xong, đã trừ credit, huỷ sẽ bỏ video trong SanoVids); không đồng ý → vẫn tải tiếp tới xong; đồng ý → take "Đã huỷ" ngay, thông báo nói video vẫn tải được trên canvasapp.io.vn (tải về ở đó để không mất), take khác tải được ngay sau. Mở Task Manager xem RAM của SanoVids khi tải một video lớn (≥ 300 MB nếu có) — ghi lại (kiểm tra main có đệm cả video không). Sau đó lưu video đó bằng nút Thư mục và "Hỏi nơi lưu" — ghi lại nếu lỗi (lưu vẫn gửi cả file qua IPC một lần).

18. **Nhập job** (4 credit, tuỳ chọn) — sau bước 5: trên canvasapp.io.vn mở phiên "SanoVids bridge", bấm **Tạo video** trên node
    của cảnh đó (không sửa gì). Trong SanoVids: Hàng đợi › **Nhập job** → job hiện dưới đúng cảnh (đợi ~15 giây rồi "Quét
    lại" nếu chưa thấy) → **Nhập 1 job** → take mới có chip "nhập", cấu hình "≈480P", tự tải video khi xong; credit canvasapp
    chỉ giảm một lần (lúc tạo trên trang). Quét lại → "Không có job mới nào". Bấm **Chạy lại** trên take nhập → hộp xác nhận
    chi phí (take mới). Ghi lại: danh sách job có `canvas_node_id` / `client_request_id` không, `created_at` có múi giờ không
    (DevTools › Network nếu xem được).

Tự động (không mạng, không tốn tiền): `npx vitest run src/providers/__tests__/canvasapp-e2e.test.ts` chạy toàn bộ luồng thật
(engine → adapter → transport → cầu nối giả lập canvasapp) cho các trường hợp trên.

Ghi lại mọi lỗi kèm thông báo hiển thị (và, nếu có, mã lỗi trong DevTools: `Ctrl+Shift+I` → Console).
