# canvasapp.io.vn — observed web API (notes for the SanoVids gateway)

Source: the site's public client code (`/static/canvas.js`, `/static/simple-mode.js`) as served on 2026-10-01.
These are **internal endpoints of the canvasapp web app**, not a documented public API. They can change without
notice. Use them only with your own account and, ideally, with the operator's permission. Never hard-code credentials.

**The server validates request shapes strictly.** The first real test (desktop v0.2.0) was refused with
`Invalid canvas payload` because the bridge canvas had one extra key (`title` in a video node's data), a
`{ x, y, zoom }` viewport and non-UUID node ids. Since then every body SanoVids sends is built key for key like the
client's own (function names below are from `canvas.js`) — see `src/providers/canvasapp/mapping.ts` and the strict
fake server in `src/providers/__tests__/canvasapp-e2e.test.ts`.

## Transport & auth
- Base: `https://canvasapp.io.vn/api`. JSON bodies (`Content-Type: application/json`) except uploads (multipart).
- Session: cookie set by the site after login (`POST /api/auth/login {email, password}` or Google
  `GET /api/auth/google/start`). Every request also sends `X-CSRF-Token: <value of cookie canvas_csrf>`.
- `401` → session expired / not logged in. Errors: JSON `{ detail: string }` (a FastAPI validation error may carry a
  list `[{ loc, msg, … }]`). SanoVids shows `detail` with each item's field (`nodes.0.data.title: …`, never the echoed
  `input`) and appends which request was refused and its status, ids and query left out:
  `… [PUT /api/projects/{id}/canvas · HTTP 422]` (`errorFromResponse` / `requestLabel` in `api.ts`).
- `GET /api/auth/state` → `{ authenticated: boolean, topup_enabled, google_login_enabled, simple_mode: {...} }`.
- Cloudflare sits in front; `robots.txt` disallows `/api/` for crawlers. Be gentle: low concurrency (SanoVids: up to 10 jobs, but one job-list read per poll for all of them, submits one at a time, at most 2 API requests + 2 video downloads in flight), polling ≥ 15 s.

## Account
- `GET /api/me` → `{ credits_balance: number, ... }` (1 credit ≈ 1.000đ).
- `GET /api/video-profiles` → `{ profiles: [{ model_profile: 'seedance_2_5'|'minimax_h3', display_name, visible, enabled, can_create, options: { modes, disabled_modes, durations, resolutions, aspect_ratios, pricing } }] }`.
  The client reads it once at boot (`loadVideoProfiles()`); unreadable (anything but 401) → its built-in
  `PROFILE_FALLBACKS`: Seedance on (t2v), MiniMax-H3 locked (`can_create: false`, `disabled_modes: ['transform']`).
  `profileSpec()`: a model missing from the list → its fallback; Seedance used as loaded; MiniMax-H3 merged with its
  fallback (a list narrower than the fallback's → the fallback's; `enabled` / `can_create` not a boolean → false).
  `runVideoNode()` refuses `can_create === false` and a mode in `disabled_modes` (it ignores `enabled`).
  SanoVids reads it before submitting (cached 10 min; after a failed read the fallbacks apply and it is read again a
  minute later) and refuses the same things (`profileSpecOf` / `validateRequest` in `mapping.ts`). The inspector, the
  Run buttons and the run dialog use that same cache and the same rule (`profileIssues`, adapter `settingsLimits()`):
  a read < 10 min old disables what it refuses; fallbacks / an older read only warn. The UI reads it too (TTL-gated,
  "Đọc lại" ≤ every 5 s, a read after a login at once, sharing one request with a submit). VERIFY: whether the endpoint needs a login (SanoVids
  assumes 401 when logged out, like the dev server), whether `visible: false` / `enabled: false` hide or grey a model in
  canvasapp's picker (SanoVids ignores both, like `runVideoNode()`), whether the server itself refuses a duration /
  resolution / ratio outside the lists (only the client is known to), and whether the lists can hold values SanoVids'
  model table lacks (they would not be offered until `core/models.ts` and its pricing learn them).
- `GET /api/credits/history?kind=all&offset=0&limit=20`.

## Images
- `POST /api/uploads/images` multipart, one field `file` (JPG/PNG/WEBP; the client sends the picked `File`, so the
  part carries its filename and type) → `{ upload_id }` (`uploadCanvasFile()`). SanoVids names the part
  `<imageId>.<jpg|png|webp>`.
- `GET /api/uploads/{upload_id}/preview` → image.

## Ids
- Every id the client invents is a UUID: `newId()` = `crypto.randomUUID()` (fallback: the same 8-4-4-4-12 v4
  pattern). That covers canvas node ids (`createVideoNode()`, image nodes in the upload handler, result nodes) and
  `client_request_id`. Project / upload / job ids come from the server.
- SanoVids (`mapping.ts`) derives them deterministically with `uuidFromKey(text)` (128-bit cyrb128 hash printed as an
  RFC 4122 v4 UUID: lowercase, version nibble 4, variant 8–b):
  - video node id = `canvasNodeId(sceneNodeKey(projectId, sceneId))` (`sceneNodeId`) — stable per scene OF A SanoVids
    PROJECT (the `canvas_node_id` of that scene's jobs): projects sharing scene ids (a duplicated / re-imported
    project) get their own nodes. Key = `node:<length of projectId>:<projectId>:<sceneId>`; builds before that used
    the bare scene id (`canvasNodeId(sceneId)`, same hash): those "legacy" nodes stay valid for the jobs sent on them;
  - image node id = `imageNodeId(uploadId, occurrence)` — one image node per upload, shared by every video node that
    uses it; occurrence > 0 only when one video node takes the same upload twice (the client keeps one edge per image
    node and target; first and last frame must be two different image nodes);
  - `client_request_id` = `clientRequestIdFor(take id)` — stable per take, so a retry of the same take always sends
    the same key. The local job ledger (`bdp:canvasapp:jobs`) stays keyed by the take id. A lost answer is matched in
    the job list by the UUID, or by the bare take id that v0.2.0 sent.
  - Node ids are never stored: bridge entries are keyed by the node key (a bare scene id for older entries) and the
    id is derived each time; entries saved by v0.2.0 (`sv_<sceneId>` era) are rebuilt with UUIDs.

## Canvas projects ("Phiên")
- `GET /api/projects` → `[{ project_id, name }]` (`refreshProjectPicker()`).
- `POST /api/projects` **without a body** → `{ project_id }` (`boot()`, `#newProject`); the name is set afterwards with
  `PATCH /api/projects/{id} { name }` (`#renameProject`). SanoVids does the same for "SanoVids bridge" (a failed
  rename is ignored: the id is remembered locally).
- `DELETE /api/projects/{id}` (not used by SanoVids).
- `GET /api/projects/{id}` → `{ canvas: { nodes, connections, viewport } }` (`loadProject()`).
- `PUT /api/projects/{id}/canvas` — body exactly as `canvasPayload()` builds it, **no other key anywhere**:
  ```json
  { "nodes": [
      { "id": "<uuid>", "type": "video", "x": 890, "y": 60, "w": 390, "h": 600,
        "data": { "model_profile": "seedance_2_5", "duration": 30, "resolution": "480p",
                  "aspect_ratio": "16:9", "mode": "t2v", "prompt": "…" } },
      { "id": "<uuid>", "type": "images", "x": 60, "y": 60, "data": { "upload_ids": ["<upload_id>"] } } ],
    "connections": [ { "from": "<image node id>", "to": "<video node id>", "target_handle": "reference", "order": 1 } ],
    "viewport": { "zoom": 1, "scrollLeft": 0, "scrollTop": 0 } }
  ```
  - nodes: every non-`result` node as `{ id, type, x: Number, y: Number, [w], [h], data }`; `w`/`h` only when the node
    has them — video nodes do (`createVideoNode()`: 390 × 600; resize range 340–900 × 470–1200), image nodes do not.
  - video `data` = exactly `{ model_profile, duration, resolution, aspect_ratio, mode, prompt }`: `resolution`
    lower-cased (`'1080p'`, `'768p'`, `'2k'`); `aspect_ratio` = the ratio, or `null` for an H3 `transform` node without
    one (every other mode falls back to `'16:9'`); `mode` defaults to `'t2v'`; `prompt` as typed (not trimmed).
  - image `data` = exactly `{ upload_ids: [...] }` (one upload per node in practice).
  - connection = exactly `{ from, to, target_handle, order }` (`normalizeConnections()`):
    `reference` edges `order` 1..N in @image_N order (renumbered `index + 1`, at most 30 per node; reference edges
    into an H3 node exist only when its mode is `i2v`); `first_frame` order 1 and `last_frame` order 2, only into an
    H3 `transform` node (`setTransformFrame()`). All reference edges come first, then the frame edges.
  - `viewport` = exactly `{ zoom, scrollLeft, scrollTop }` (**not** `{ x, y }`).
  - limits seen in the client: 40 editable nodes (`MAX_CANVAS_NODES`), 30 reference images per node **and 30 image
    uploads on the whole canvas** (`MAX_REFERENCE_IMAGES`: `imageIds()` counts every image node's `upload_ids`,
    duplicates too, and the upload handler refuses to go past it), prompt 20.000 chars (H3 t2v/i2v 7.000), counted on
    the trimmed prompt. Whether the server enforces the same limits is not known: SanoVids stays within them.
  - H3 `transform`: the node's `aspect_ratio` is the ratio both frame pictures share (`setTransformFrame()` /
    `transformInputState()`; `ratioFromDimensions()`: nearest of 16:9, 9:16, 1:1, 4:3, 3:4 within 2 %); the client
    will not run it when the frames differ in ratio or have an unsupported one. SanoVids reads both pictures' sizes
    before uploading and refuses the same cases.
  - SanoVids' bridge canvas (`bridgeCanvas()`): one video node per scene of a project, one image node per upload
    (shared), newest scenes first, older ones left out past 40 nodes, 30 image uploads or 400.000 prompt characters
    (keeps the PUT far below the desktop gateway's 2 MB JSON cap); nodes of running jobs are never left out. Its scene
    entries are remembered only once canvasapp accepted the PUT, and only those on that canvas; a refused PUT is tried
    once more without the scenes whose jobs have ended (an older scene may be what is refused).

## Video jobs (canvas mode)
- `POST /api/video-jobs` — body as `runVideoNode()` builds it. Always, in this order:
  `project_id, model_profile, canvas_node_id, prompt (trimmed), mode, duration, resolution, generate_audio: true`; then
  by node kind:

  | node | extra keys |
  |---|---|
  | Seedance (any mode), H3 `i2v` | `upload_ids` (reference uploads in @image_N order = connection order) + `aspect_ratio` (`'16:9'` fallback) |
  | H3 `transform` | `first_frame_upload_id` + `last_frame_upload_id` — **no** `upload_ids`, **no** `aspect_ratio` |
  | H3 `t2v` | `upload_ids: []` + `aspect_ratio` |

  and last `client_request_id` (a UUID). Example (Seedance, one reference):
  ```json
  { "project_id": "…", "model_profile": "seedance_2_5", "canvas_node_id": "<video node uuid>",
    "prompt": "@image_1 …", "mode": "t2v", "duration": 30, "resolution": "480p", "generate_audio": true,
    "upload_ids": ["<upload_id>"], "aspect_ratio": "16:9", "client_request_id": "<uuid>" }
  ```
  - The client saves the canvas (`saveCanvas()`, a PUT) right before the POST, so `canvas_node_id` exists in the
    project's canvas. SanoVids does the same.
  - Idempotency (`pendingJobRequest()`): the client keeps one `client_request_id` per (project, node, body
    fingerprint) in `sessionStorage` and reuses it when the same body is sent again; it is dropped after an answer
    (kept on network errors / 5xx / 401). Response: `{ job_id, … }`.
- `GET /api/video-jobs?project_id=…` → `[job]` (`loadJobs()`; the canvas page keeps only jobs without
  `creation_mode` or with `creation_mode === 'canvas'`). Job fields: `job_id, job_name, canvas_node_id, model_profile,
  status ('queued'|'processing'|'completed'|'failed'|'cancelled'|'expired'), submission_state ('not_submitted'|
  'submitting'|'accepted'), progress (0–100), download_available, error_message, duration, aspect_ratio, created_at,
  finished_at, provider_started_at, provider_finished_at, creation_mode`.
- `GET /api/video-jobs/{job_id}/stream` → the MP4; `GET /api/video-jobs/{job_id}/prompt` → `{ prompt }`
  (`runDownloadTask()`, both plain GETs).
- `POST /api/video-jobs/{job_id}/download-token` → `{ download_token }`, then `GET /api/download/{token}`.
- `DELETE /api/video-jobs/{job_id}`. The site polls the job list every 60 s.

## Desktop gateway allowlist (electron/main.cjs)
Every path/method above that SanoVids uses is in `CANVASAPP_ROUTES` (block `<canvasapp-routes>`, run as-is by the
e2e test so a request outside it fails the tests): `GET/POST /api/projects`, `GET/PATCH /api/projects/{id}`,
`PUT /api/projects/{id}/canvas`, `POST /api/uploads/images` (multipart), `GET/POST /api/video-jobs`
(`?project_id=` only), `GET /api/video-jobs/{id}/prompt|stream`, `DELETE /api/video-jobs/{id}`, plus `/api/me`,
`/api/auth/state`, `/api/video-profiles`, top-up and credit history. JSON bodies ≤ 2 MB, uploads ≤ 20 MB, path ids
`[A-Za-z0-9_-]{1,80}` (UUIDs fit).
Videos (`GET /api/video-jobs/{id}/stream`, the only `binary` route) are pulled by the page in pieces through
`canvasapp:downloadOpen / downloadRead / downloadClose` (block `<canvasapp-downloads>`) — `canvasapp:request` refuses
that route (`matchCanvasappRequest`): no video ever comes in one IPC message. The page sends a download id it chose
(UUID), the allowlisted path and a byte to continue from — never a URL, header or validator. Main sends the GET through
`net.request` (block `<canvasapp-net-get>`, canvasapp partition, `redirect: 'manual'`): a redirect is followed only to
an https URL — a request to http is never sent (`session.fetch` would follow it and never say where it ended). Headers:
`Accept: video/mp4,*/*`, and `Range: bytes=N-` + `If-Range: <ETag | Last-Modified>` only to continue a video whose
strong validator it got from canvasapp (kept 10 min after the last connection for that path ended). It refuses an
announced size over 1 GB, a 206 that does not start where asked (or of unknown size), a 206 to a resume that does not
carry the validator If-Range named (a server ignoring If-Range could send the rest of another file) and a 416 to a
resume (`bad-range` → the page starts over once). A `Content-Encoding` body has no usable length or offsets: no length
check, no resume. Limits: pieces ≤ 4 MiB, 60 s without a byte, 5 min until the headers, 60 min per connection
(`too-slow`: continued on a new connection when it can resume, else the take fails at once — paid, where to get it),
30 s without a read from the page, 16 downloads open or waiting, one slot of the 'download' lane (2) per connection
from open to end. `download-token` is not used (still refused by the allowlist).
VERIFY on the live site: Content-Length, Accept-Ranges, ETag / Last-Modified, compression, redirects of `/stream`.

## Simple mode (pilot, only for eligible accounts)
- `GET/POST /api/simple-projects`, `GET/PUT /api/simple-projects/{id}/state` `{ prompt, images:[{slot, upload_id}] }`.
- `POST /api/simple-video-jobs` (prompt references images by `@image_<slot>` tags — same idea as SanoVids tokens).
- `GET /api/simple-video-jobs?simple_project_id=…&limit=50`.

## Reference videos (@video_N) — not observed
The client code these notes come from has **no video input anywhere**. These notes are a summary, not a copy (no
`canvas.js` is kept in the repo), so this is strong evidence, not proof — "not observed", not "impossible":
- the only upload is `POST /api/uploads/images` (JPG/PNG/WEBP); no other `/api/uploads/` path is recorded;
- saved node types are `video` and `images` (`result` nodes are client-only and never saved, so no saved edge can
  start from a finished job);
- connections start at an image node, with `target_handle` `reference` / `first_frame` / `last_frame` only;
- job bodies carry `upload_ids` or the two `*_frame_upload_id` keys, nothing else per node kind;
- `/api/video-profiles` options (`modes, disabled_modes, durations, resolutions, aspect_ratios, pricing`) have no
  video key; the only per-node media cap is `MAX_REFERENCE_IMAGES`;
- simple mode stores `images:[{slot, upload_id}]` and tags `@image_<slot>` only.

The server refuses unknown keys, so guessing is not an option: a wrong key is a 422 (no charge), but a key the server
accepts and ignores would bill a video made without its reference. SanoVids therefore sends no video and refuses a
scene that would send one **before uploading or billing anything**, at three layers: `capabilities().maxRefVideos`
= `CANVASAPP_MAX_REF_VIDEOS` = 0 (`providers/capabilities.ts`, read by store/runs `check()` and every one-scene
Run button through `core/runGate.ts`), `validateRequest` in `mapping.ts` (refuses any `req.videos`, whatever the cap),
and the strict dev / e2e validators (`providers/dev/validate.ts`: node types, handles and job keys). Development mode
refuses it the same way (same adapter); it simulates no video endpoint, so no test passes against an invented shape.

**What to capture before opening it** (functions of `canvas.js` / `simple-mode.js`, exact names and key order):
1. `uploadCanvasFile()` and every `/api/uploads/` path: any video upload — path, multipart field, `accept=` / MIME
   list, size and duration limits, response key.
2. Node factories besides `createVideoNode()` and the image upload handler: a node type holding a video, its exact
   `data` keys, `w` / `h`. Can a `result` node (a finished job) be the `from` end of an edge into a video node?
3. `normalizeConnections()`: every `target_handle` value, how `order` is numbered for a video handle, any cap next to
   `MAX_REFERENCE_IMAGES` (per node and per canvas), and where video edges sit relative to reference / frame edges.
4. `runVideoNode()`: every body key per model / mode, in order. Is a reference video sent as an upload id or as a job
   id, and for which `model_profile` / `mode`?
5. `canvasPayload()`: is such a node / edge saved, and in what shape?
6. `loadVideoProfiles()` / `PROFILE_FALLBACKS` / `profileSpec()`: any reference-video option (limit, modes) and
   whether `pricing` changes when videos are attached.
7. The tag the client inserts for a video (`@video_N` or another form SanoVids would have to map).
8. `simple-mode.js` `PUT /api/simple-projects/{id}/state`: any `videos` array.
9. If videos go by job id: must the job be in the same project / account, and what happens when it is `expired` or
   deleted (`DELETE /api/video-jobs/{id}`)?
10. The operator: do Seedance 2.5 / MiniMax-H3 on canvasapp take reference videos at all, and may SanoVids use them?

What changes once the shape is known is listed in `docs/GATEWAY-CANVASAPP.md` §8.

## Pricing (credits) — identical to SanoVids' `core/models.ts`
- Seedance 2.5: 480p {5:4,10:5,15:10,30:15} · 720p {5:5,10:10,15:15,30:20} · 1080p {5:10,10:15,15:20,30:25}
- MiniMax-H3: 768p {5:4,10:6,15:8} · 2k {5:6,10:8,15:10}
