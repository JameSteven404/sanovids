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
 │   • API: session.fromPartition('persist:canvasapp').fetch(…)  (Electron 44: Session.fetch)      │
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
| `recover?(req)` | tìm job mà một lần gửi trước của `req.key` có thể đã tạo (trang đóng/tải lại lúc gửi) — **không bao giờ** tạo job. canvasapp: có |
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
   nó — chưa quá 15 s, chưa có `POST` nào sau đó — thì dùng luôn): mọi job đã có trên node lúc đó (của take khác, hoặc
   job người dùng vừa tạo trên trang canvasapp mà chưa nhập) vào `before` của lần gửi, không bao giờ bị nhận nhầm là job
   của nó. Đọc không được → vẫn gửi với lần đọc trước đó (trừ khi cạnh một take còn chưa rõ, xem dưới);
6. ghi trước "đã gửi" (`sent[take.id]`, localStorage `bdp:canvasapp:jobs`) → `POST /api/video-jobs` → `job_id` →
   `remoteId = "<project_id>:<job_id>"` lưu vào take **và** vào sổ `jobs[take.id]` (đồng bộ, ngay khi có câu trả lời).
Các lần submit được xếp hàng nối tiếp (không chen nhau). Take bị huỷ (hoặc cảnh bị xoá) trong lúc chờ/đang tải ảnh →
dừng **trước** `POST`, không bị trừ credit (cảnh bị xoá: take quay lại hàng đợi, chạy tiếp nếu Hoàn tác). Lỗi chắc chắn
(401, 402/400 thiếu credit, 403, 404, 429, sai dữ liệu) → take `failed` với lý do tiếng Việt, không tự gửi lại. Lời báo
kèm `detail` của canvasapp (lỗi kiểm tra dữ liệu ghi cả trường, vd. `nodes.0.data.title: Extra inputs are not permitted`)
và yêu cầu nào bị từ chối, mã HTTP — không có id, query, cookie hay nội dung gửi đi, vd.
`[PUT /api/projects/{id}/canvas · HTTP 422]`. Thiếu credit (402, hoặc 400 mà `detail` nói về số dư) giữ cache ảnh.
`POST` không có câu trả lời rõ (mất mạng, quá giờ, 5xx, 200 mà không có `job_id`) → canvasapp **có thể đã tạo job**:
đợi 15 s, đọc danh sách job tìm đúng job đó (cùng `client_request_id` nếu danh sách có trường này, nếu không thì job
**duy nhất** mới xuất hiện trên node mà lần `POST` đó ghi, không thuộc take nào khác, không phải job đã nhập, chưa có
trong lần đọc danh sách trước `POST`, tạo trong khoảng thời gian của lần `POST` đó (`inPostWindow`: từ 14 h trước tới
14 h 10 phút sau — đúng khoảng mà "Nhập job" giữ cho nó, nên một job không bao giờ vừa là của một lần gửi vừa nhập được)
— và không thể là job của một take khác trên cùng node còn chưa rõ câu trả lời: khi đó "không rõ", không
đoán); đọc lần 2 sau 15 s nữa; không có → gửi lại
**một lần** với **cùng** body và `client_request_id`; vẫn không rõ → take `failed` với `UNKNOWN_SUBMIT_ERROR`
("không rõ đã trừ credit chưa"). `useRuns.retry(takeId)` cho take đó gửi lại **chính take đó** (cùng khoá; tìm job trước).

Hai take trên **cùng một node** (hai take của một cảnh trong một dự án, hoặc take gửi lại trên node cũ) mà đều chưa rõ
câu trả lời: job nào cũng có thể là của take kia. Lần đọc danh sách job ngay trước `POST` (bước 5: `before` + `beforeAt`
trong sổ `sent`) khi đó là **bắt buộc**: đọc không được → **không gửi** (take `failed`, "chưa
gửi … không bị trừ credit"; take đang gửi lại thì vẫn "có thể đã bị trừ" như trước). Khi tìm job (`findJob`): một take
`POST` **sau** chỉ có thể sở hữu job mà lần đọc ngay trước `POST` của nó chưa thấy; một take `POST` **trước** chỉ có
thể sở hữu job mà lần đọc trước `POST` của take đang tìm chưa thấy dù lần đọc đó chắc chắn thấy mọi job có từ ≥ 30 s
(`SETTLE_MS` = tổng hai lần đợi) sau `POST` kia — job của một `POST` có trong danh sách trong 30 s hoặc không bao giờ,
đúng như điều adapter đã dựa vào khi gửi lại. `beforeAt` vì thế là lúc **gửi** lần đọc đó trừ đi thời gian cổng có thể
trả danh sách từ cache của nó (main: 15 s; giả lập: 2 s — `gatewayListCacheMs`), không phải lúc nhận câu trả lời: một
câu trả lời cache cũ không bao giờ được coi là mới hơn thực tế. Không chắc (ví dụ hai bản ghi của bản trước 0.6.0, không ghi giờ đọc) → **không take nào nhận** job đó,
cả hai "không rõ", không gửi lại — kiểm tra trên canvasapp.io.vn. Lần gửi lại (sau 2 lần đọc không thấy) ghi lại giờ
`at` của chính nó.

**Cấu hình model trong inspector và hộp Chạy** — cùng một luật với bước 1 (`mapping.profileIssues`, không viết lại
luật), trên cùng bộ nhớ đệm `/api/video-profiles` của adapter (`settingsLimits()`; tín hiệu `useProviderLimits` trong
`providers/index.ts`). Ba trạng thái:
- `none` (chưa đọc: chưa đăng nhập, chưa hỏi, demo cũ) → không giới hạn gì, bước 1 tự quyết khi gửi;
- `server` đọc trong 10 phút (`firm`) → lựa chọn bị từ chối **tắt hẳn** kèm lý do (không ẩn, **không đổi** cấu hình đã
  lưu của cảnh), nút Chạy của cảnh tắt (`core/runRules` `settingsBlock`), `useRuns.check()` / `enqueue` bỏ qua cảnh đó (không
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
sau khi huỷ nói đúng điều đó (không còn "job vẫn chạy ở đó").
`download-token` **không** dùng: main đã gửi cookie phiên canvasapp với `GET /stream`; token chỉ là phương án dự phòng
nếu `/stream` không tải trọn được (khi đó: allowlist riêng, che token trong `requestLabel` và nhật ký).

**Mở lại app / đổi dự án** — take canvasapp đang `processing` có `remoteId` được giữ nguyên và **tiếp tục poll** (không gửi
lại = không trả tiền hai lần). Take đang gửi dở (chưa có `remoteId` trên take — trang đóng/tải lại lúc gửi, hoặc lưu
chậm) → `provider.recover()`: lấy `jobs[take.id]` trong sổ, hoặc đợi lần gửi còn đang chạy, hoặc (có `sent[take.id]`) tìm
job trong danh sách như trên. Tìm thấy → poll tiếp; không thấy → `failed` với `UNKNOWN_SUBMIT_ERROR`. **Không bao giờ**
tự `POST` lại. Đổi sang dự án khác lúc đang gửi không huỷ lần gửi đó (node của nó vẫn là node của dự án đã gửi —
`JobRequest` dựng ngay lúc gửi); mở lại dự án → take tìm lại job. Take của một dự án không bao giờ nhận nhầm job của bản
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
   `download_available: false` quá 1 giờ thì bỏ), model SanoVids có. **Không bao giờ** nhập: job đã là take của dự án;
   job SanoVids tạo (sổ `jobs`, hoặc `client_request_id` của một take khi danh sách có trường này); job mà một lần `POST`
   còn chưa rõ câu trả lời (sổ `sent`) **có thể** đã tạo (`sentMayOwn`: cùng `client_request_id` nếu danh sách có, nếu
   không thì cùng node, không có trong lần đọc trước `POST`, tạo trong khoảng của lần gửi `inPostWindow` (14 giờ trước →
   14 giờ 10 phút sau) — take đó phải tự tìm ra job của nó, không bao giờ thành take mới).
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
   job có từ trước lần `POST` nằm trong `before` (đọc danh sách ngay trước `POST`, bước 5 của "Gửi") nên không bao giờ
   bị nhận là job của nó; job tạo sau khi lần gửi đã quá khoảng `inPostWindow` cũng không (`findJob` dùng đúng khoảng của
   `sentMayOwn`) — vẫn nhập được. Trường hợp còn lại (hiếm): job tạo trên trang cùng node chỉ vài giây trước `POST`
   (cổng còn trả danh sách từ cache ≤ 15 s) hoặc lúc danh sách không đọc được ngay trước `POST`, rồi câu trả lời bị mất →
   take có thể "không rõ" (hai job cùng có thể là của nó) hoặc, nếu `POST` không tới canvasapp, nhận job đó. Không bao giờ
   trả tiền hai lần.
5. Danh sách job **không** cho biết độ phân giải, chế độ (trừ Seedance chỉ có t2v), prompt, ảnh. Prompt lấy từ
   `/prompt` (trống / không đọc được / dài hơn 20.000 ký tự → **không rõ**). Phần còn lại chỉ được **đoán** (`inferred`,
   hiện "≈") khi node trên canvas đã lưu (hoặc mục SanoVids đã nhớ của node đó) có cùng prompt, model, thời lượng, tỷ lệ
   với job; ảnh tham chiếu đoán được khi mọi upload của node ứng với ảnh trong máy (cache upload) và một nhân vật của dự
   án. Không đoán được → **không rõ** (`unknown`, giá trị giữ chỗ, hiện "?"). Node có thể đã đổi từ lúc tạo job (ví dụ chỉ
   đổi độ phân giải rồi SanoVids ghi đè lại) nên giá trị đoán **không bao giờ** được coi là chắc chắn: chi phí "≈ 20
   credit" (không rõ độ phân giải / thời lượng → "—"); "Khôi phục prompt này" tắt khi không rõ prompt hoặc ảnh tham
   chiếu, và chỉ khôi phục cấu hình chắc chắn — trường đoán / không rõ giữ giá trị của cảnh (thông báo nói rõ "không rõ"
   hay "chỉ đoán được"); ảnh tham chiếu và chế độ đi cùng nhau (`importedTake.restorePlan`): job gửi ảnh tham chiếu →
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
| CSRF / Origin | gửi `X-CSRF-Token` từ cookie; **không** giả `Origin`. Nếu máy chủ bắt buộc `Origin` = canvasapp → nhận 403 → cần bên vận hành hỗ trợ |
| Trả tiền hai lần | `client_request_id = clientRequestIdFor(take.id)` (UUID cố định theo take); sổ `jobs`/`sent`/`imported` (localStorage `bdp:canvasapp:jobs`, giữ cả khi đăng xuất); khoá đã có job (kể cả job nhập) không bao giờ `POST` lại; take nhập không bao giờ được gửi, "Chạy lại" tạo take mới; nhập không bao giờ nhận job mà một lần gửi chưa rõ có thể sở hữu; câu trả lời mất → tìm job trong danh sách trước, chỉ gửi lại 1 lần cùng khoá (cùng node như lần đầu); vẫn không rõ → `UNKNOWN_SUBMIT_ERROR`, không tự gửi; huỷ trước `POST` → không gửi; mỗi dự án một node cho mỗi cảnh; đọc danh sách job ngay trước mỗi `POST` (job đã có trên node — của take khác hay tạo trên trang mà chưa nhập — không bao giờ là job của lần gửi đó); job có thể là của một take khác còn chưa rõ trên cùng node → không nhận (cạnh take như vậy: đọc không được → không gửi); câu trả lời cache của cổng không bao giờ được coi là mới hơn thực tế. Test: `providers/__tests__/canvasapp-e2e.test.ts`, `canvasapp-adapter.test.ts`, `dev-e2e.test.ts` |
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
- [ ] VERIFY với máy chủ thật: dạng phản hồi `POST /api/video-jobs`; máy chủ có dedupe `client_request_id` không; `/stream` có chuyển hướng không. (Đã đối chiếu với `canvas.js`: `order` bắt đầu từ 1; `GET /api/projects` trả mảng; dạng canvas / body job — xem `docs/canvasapp-api-notes.md`.)
- [ ] VERIFY (chống trả tiền hai lần): job trong `GET /api/video-jobs` có trường `client_request_id` không (có → khớp chính xác); `created_at` có múi giờ không; mã lỗi khi thiếu credit (400 hay 402) và `detail`; hai take của **cùng một cảnh** chạy song song trên cùng `canvas_node_id` có bị từ chối không; job có bị huỷ/xoá khi node của nó rơi khỏi canvas cầu nối (giới hạn 40 node) không — từ v0.2.5 node của job đang chạy không bao giờ bị gỡ (take mới chờ trong hàng đợi khi hết chỗ), nên nếu không bị huỷ thì có thể nới quy tắc này cho chạy được nhiều cảnh nhiều ảnh hơn; danh sách job có trường `canvas_node_id` không (không có → dùng node ghi trong sổ `jobs`, chỉ có với job tạo từ v0.2.5); danh sách job có bị cắt trang (job đang chạy cũ có biến mất không).
- [x] UI: nút "Chạy lại" của take `UNKNOWN_SUBMIT_ERROR` gọi `useRuns.getState().retry(take.id)` (gửi lại CHÍNH take đó, cùng khoá, hỏi xác nhận trước) thay vì tạo take mới: `actions.rerunTake` (take node, hàng đợi, xem take).
- [ ] Video tham chiếu `@video_N`: tìm cách canvasapp nhận video (nếu có) rồi mở `maxRefVideos`.
  - **Chưa mở — chưa có bằng chứng canvasapp nhận video tham chiếu**: mọi dạng yêu cầu đã ghi nhận chỉ có ảnh (xem
    `docs/canvasapp-api-notes.md` "Reference videos (@video_N) — not observed", kèm danh sách hàm `canvas.js` cần ghi
    lại). Không mở khi chưa có dạng yêu cầu thật: một body lạ bị 422 (không mất tiền), nhưng một job được nhận mà bỏ
    qua video thì vẫn bị trừ credit cho một video sai. Cần: các hàm trong danh sách đó + xác nhận của bên vận hành.
  - Đã làm (0.6.0): một nguồn duy nhất cho cổng `@video` — `capabilities().maxRefVideos` (canvasapp và chế độ Phát
    triển: `CANVASAPP_MAX_REF_VIDEOS = 0`, `providers/capabilities.ts`); quy tắc chặn chạy dùng chung
    `core/runRules.ts` `runBlockReason` (`core/runGate.ts` chỉ giữ cách gọi của các nút) cho `useRuns.check()` và mọi nút Chạy một cảnh — thẻ cảnh trên canvas, hai nút
    Chạy trong inspector (trên đầu + mục Take), thẻ Storyboard, hàng Bảng cảnh (`runs/shared.useSceneRunBlock`); nút
    chạy cả vùng chọn chỉ mở hộp xác nhận, hộp này bỏ qua cảnh bị chặn kèm đúng lý do đó (trước
    đây thẻ / inspector chặn mọi cảnh có `videoRefs`, kể cả H3 t2v / transform không gửi video mà hộp xác nhận vẫn
    chạy; lý do trong chế độ Phát triển ghi "Cổng canvasapp chưa…"). Chỉ tính video thật sự gửi (`compiled.videos`);
    vượt mức của cổng → từ chối, không bao giờ cắt bớt. `validateRequest` vẫn từ chối mọi `req.videos` (không theo
    cap). Test: `core/__tests__/runRules.test.ts`, `runGate.test.ts`, `runs-engine`, `canvasapp-adapter`, `canvasapp-e2e` / `dev-e2e`
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
  `net.request` chỉ xin thêm dữ liệu khi được đọc). Việc tiếp: lưu video lớn ra đĩa theo từng phần (`files:*`).
- [x] Đồng bộ ngược: nhập các job đã tạo trên canvasapp (trong phiên bridge) thành take — "Nhập job" (§4): chỉ đọc
  (`GET`), take nhập sinh ra `processing` có `remoteId` (chỉ theo dõi + tải, không bao giờ gửi, "Chạy lại" = take mới),
  sổ `imported` (không bao giờ `POST` khoá đó; `findJob` loại mọi job đã nhập, job chưa nhập có từ trước lần gửi — đọc
  danh sách ngay trước mỗi `POST` — và job ngoài khoảng `inPostWindow` của lần gửi), không nhập job mà một lần gửi chưa
  rõ có thể sở hữu (kiểm tra cả lúc quét và lúc ghi), dự án được ghim, tối đa 20 job / lần, cấu hình chỉ "đoán" (≈) theo
  node có prompt khớp, không rõ (?) thì không tính chi phí / không khôi phục. Chế độ Phát triển: Bảng phát triển › Job &
  đơn nạp › "Tạo job như trên trang canvasapp" (sửa node trước nếu muốn) + nút "Nhập" ở job chưa có take. Test:
  `canvasapp-siteJobs`, `canvasapp-adapter`, `canvasapp-e2e`, `dev-server`, `dev-e2e`, `runs-engine`, `importedTake`,
  `importJobsModel`, `migrate`, `devModel`. Còn VERIFY trên máy chủ thật: mọi job trong `GET /api/video-jobs` có
  `canvas_node_id` không (không có → không nhập được gì); danh sách có `client_request_id` / `mode` / `resolution` /
  `upload_ids` / số credit không (có → nhập chính xác, không cần đoán); danh sách có cắt trang không, `creation_mode` của
  job canvas / simple là gì; `created_at` có múi giờ không (cửa sổ ±14 giờ); `GET /api/projects/{id}` trả `{ canvas: {
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
3. **Đăng nhập** — bấm "Đăng nhập canvasapp": cửa sổ trang thật canvasapp mở ra; đăng nhập; cửa sổ tự đóng; Cài đặt hiện "Đã đăng nhập" + số credit đúng như trên canvasapp.
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
