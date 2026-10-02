# canvasapp.io.vn — observed web API (notes for the SanoVids gateway)

Source: the site's public client code (`/static/canvas.js`, `/static/simple-mode.js`) as served on 2026-10-01.
These are **internal endpoints of the canvasapp web app**, not a documented public API. They can change without
notice. Use them only with your own account and, ideally, with the operator's permission. Never hard-code credentials.

## Transport & auth
- Base: `https://canvasapp.io.vn/api`. JSON bodies (`Content-Type: application/json`) except uploads (multipart).
- Session: cookie set by the site after login (`POST /api/auth/login {email, password}` or Google
  `GET /api/auth/google/start`). Every request also sends `X-CSRF-Token: <value of cookie canvas_csrf>`.
- `401` → session expired / not logged in. Errors: JSON `{ detail: string }`.
- `GET /api/auth/state` → `{ authenticated: boolean, topup_enabled, google_login_enabled, simple_mode: {...} }`.
- Cloudflare sits in front; `robots.txt` disallows `/api/` for crawlers. Be gentle: low concurrency, polling ≥ 15 s.

## Account
- `GET /api/me` → `{ credits_balance: number, ... }` (1 credit ≈ 1.000đ).
- `GET /api/video-profiles` → `{ profiles: [{ model_profile: 'seedance_2_5'|'minimax_h3', display_name, visible, enabled, can_create, options: { modes, disabled_modes, durations, resolutions, aspect_ratios, pricing } }] }`.
- `GET /api/credits/history?kind=all&offset=0&limit=20`.

## Images
- `POST /api/uploads/images` multipart field `file` (JPG/PNG/WEBP) → `{ upload_id }`.
- `GET /api/uploads/{upload_id}/preview` → image.

## Canvas projects ("Phiên")
- `GET /api/projects` → `[{ project_id, name }]`; `POST /api/projects` → `{ project_id }`; `PATCH /api/projects/{id} {name}`; `DELETE /api/projects/{id}`.
- `GET /api/projects/{id}` → `{ canvas: { nodes, connections, viewport } }`.
- `PUT /api/projects/{id}/canvas` body `{ nodes, connections, viewport }`:
  - node `images`: `{ id, type:'images', x, y, data:{ upload_ids:[id] } }` (exactly one image per node)
  - node `video`: `{ id, type:'video', x, y, w, h, data:{ model_profile, duration, resolution, aspect_ratio, mode, prompt } }`
  - connection: `{ from, to, target_handle: 'reference'|'first_frame'|'last_frame', order }` (`order` = @image_N order)
  - limits seen in the client: 40 editable nodes, 30 reference images per node, prompt 20.000 chars (H3 t2v/i2v 7.000).

## Video jobs (canvas mode)
- `POST /api/video-jobs` body:
  ```json
  { "project_id": "…", "model_profile": "seedance_2_5", "canvas_node_id": "<video node id>",
    "prompt": "…", "mode": "t2v|i2v|transform", "duration": 15, "resolution": "1080p",
    "generate_audio": true, "upload_ids": ["…"], "aspect_ratio": "16:9",
    "first_frame_upload_id": "… (transform only)", "last_frame_upload_id": "…",
    "client_request_id": "<uuid, idempotency key>" }
  ```
  `upload_ids` = reference images in @image_N order (Seedance, H3 i2v). The client saves the canvas first, so the
  server may expect `canvas_node_id` to exist in the project's canvas.
- `GET /api/video-jobs?project_id=…` → `[job]`. Job fields: `job_id, job_name, canvas_node_id, model_profile, status
  ('queued'|'processing'|'completed'|'failed'|'cancelled'|'expired'), submission_state ('not_submitted'|'submitting'|
  'accepted'), progress (0–100), download_available, error_message, duration, aspect_ratio, created_at, finished_at,
  provider_started_at, provider_finished_at, creation_mode`.
- `GET /api/video-jobs/{job_id}/stream` → the MP4. `GET /api/video-jobs/{job_id}/prompt` → `{ prompt }`.
- `POST /api/video-jobs/{job_id}/download-token` → `{ download_token }`, then `GET /api/download/{token}`.
- `DELETE /api/video-jobs/{job_id}`. The site polls the job list every 60 s.

## Simple mode (pilot, only for eligible accounts)
- `GET/POST /api/simple-projects`, `GET/PUT /api/simple-projects/{id}/state` `{ prompt, images:[{slot, upload_id}] }`.
- `POST /api/simple-video-jobs` (prompt references images by `@image_<slot>` tags — same idea as SanoVids tokens).
- `GET /api/simple-video-jobs?simple_project_id=…&limit=50`.

## Pricing (credits) — identical to SanoVids' `core/models.ts`
- Seedance 2.5: 480p {5:4,10:5,15:10,30:15} · 720p {5:5,10:10,15:15,30:20} · 1080p {5:10,10:15,15:20,30:25}
- MiniMax-H3: 768p {5:4,10:6,15:8} · 2k {5:6,10:8,15:10}
