# Spec v2 — user feedback round 1 (2026-10-01)

User feedback (Vietnamese, paraphrased):
1. "When I create a video, a video node should come out of that scene node (connected), so I can continue scenes from that video into other nodes."
2. "Prompt blocks and the auto references paragraph are redundant. The prompt itself contains the references, numbered like @image_1."
3. "Improve features and optimize so it runs on the web or as an app."

## 1. Take nodes (video output on the canvas)
- Every take (generation attempt) is a **Take node** on the canvas (`type: 'take'`, `id = take.id`), connected from its scene with an edge `out:<sceneId>-><takeId>` (always drawn in a subtle style when visible by edge mode; highlighted with the scene).
- Default placement: to the right of the scene, a horizontal strip: `x = scene.x + SCENE_W + 56 + i*(TAKE_W + 16)`, `y = scene.y`, i = take index within the scene (oldest first). Positions are stored on the take (`take.position`, runs store, not undoable) once the user drags it; until then computed.
- Take node (~220px wide): 16:9 thumbnail (poster; plays the webm on hover), `S03 · T2`, status (queued/processing with % bar/failed with reason/cancelled), duration·res, ★ toggle, menu (Xem, Chạy lại, Xoá). Source handle on the right (purple-ish `--video`).
- Collapsing: per scene "Thu gọn take" → only the starred (else latest completed) take node is shown, with a "+3" badge; project-wide toggle in the canvas toolbar "Take: Tất cả / Chỉ take chọn".
- Connecting a take to a scene = **video reference**: `scene.videoRefs: string[]` (take ids, ordered) → prompt tokens `@video_1, @video_2…` (Seedance 2.5 up to 10 reference videos, MiniMax-H3 up to 3). Edge id `vref:<takeId>-><sceneId>`.
- Drop a take's wire on empty canvas → ConnectMenu "Tạo cảnh tiếp nối từ video này": new scene placed below the source scene, `videoRefs=[take]`, `refs = source scene refs`, same settings, prompt prefilled `Continue from @video_1: ` (then the user types).
- Deleting a take (runs store) removes it from every scene's videoRefs and renumbers tokens (see §2).
- Only completed takes can be used as video refs (others: connection rejected with toast "Video chưa tạo xong").

## 2. Prompt = exactly what the user writes, with @image_N / @video_N
- REMOVE prompt blocks (data, store actions, sidebar panel, inspector toggles, import detection) and the auto "References…" paragraph and auto-continuity line. Remove scene `continueFrom` and the scene→scene "seq" edges/handles (continuity is now expressed by take → scene video refs).
- Numbering: images numbered 1..N in `scene.refs` order (each image of an asset gets its own number, primary first); videos numbered 1..M in `scene.videoRefs` order.
- The compiled prompt = the scene prompt text unchanged. Legacy `@Tag` mentions (asset tags) are still converted to `@image_N` at compile time for robustness, but the editor inserts `@image_N` directly.
- **Auto-renumbering**: whenever refs/videoRefs change (remove, reorder, insert, asset images added/removed/reordered), rewrite `@image_N`/`@video_N` tokens in the affected scene prompts so each token keeps pointing at the same image/video. Tokens whose image/video was removed become the asset name / "video S03-T2" plain text, and the user gets a toast with Undo. All in the same undo step as the ref change.
- Validation warnings: token number > available count ("@image_5 nhưng chỉ có 3 ảnh"), connected media never mentioned (info, still sent), over model limits, empty prompt, prompt length limit.
- PromptEditor: `@` popup lists (a) connected images with their numbers + thumbnails, (b) connected videos, (c) library assets not yet connected ("Nối & chèn" → connects and inserts the new number), filtered by typed text (matches name/tag/number). A token legend under the textarea: `@image_1 [thumb] Elara`, `@video_1 [thumb] S03·T2`; hovering a legend item highlights the token occurrences. Token highlighting inside the textarea via a backdrop mirror layer (colored `@image_N` teal, `@video_N` purple, invalid red).
- Scene card shows numbered avatars (badge 1,2,3 on each) and video ref thumbs with v1, v2.

## 3. Web + app, optimization
- PWA: `vite-plugin-pwa` (manifest: name "Bàn Dựng Phim", short_name "Bàn Dựng", theme/background `#0f1012`, icons 192/512 + maskable generated from an SVG logo), service worker precaching the app shell (autoUpdate), works offline. "Cài app" button in Settings (beforeinstallprompt) + hint text for Brave/Chrome/Edge.
- Persistence moved from localStorage to IndexedDB (idb-keyval stores `projects`, `runs`) with a one-time migration from the v1 localStorage keys; request `navigator.storage.persist()`. Debounced writes; flush on `visibilitychange: hidden` and `pagehide`.
- Code splitting: `React.lazy` for SceneTable, Storyboard and every dialog; manual chunk for `@xyflow/react` and `jszip`. Keep the initial JS small.
- Production: `npm run build` → `dist/` deployable to any static host; `start.bat` runs the built app via `vite preview` (fast) with a `dev.bat` for development.
- Performance: canvas must stay smooth with 60 scenes × 3 takes (≈240 nodes): memoized nodes, `onlyRenderVisibleElements`, posters as small JPEG thumbnails (generate a 320px thumb per take), video only loaded on hover/viewer.

## 4. Resizable side panels (done in the app shell)
- `components/common/PanelResizer.tsx`: drag the border between a side panel and the center to resize (left 200–520px, right 300–680px, center ≥ 360px), double-click resets, arrow keys ±16px (Shift ±64), dragging ~90px past the minimum collapses the panel. Widths persist in localStorage (`bdp:pref:leftW` / `bdp:pref:rightW`) and live in the CSS variables `--left-w` / `--right-w` on `.app`. Components must not hardcode panel widths.

## 5. Desktop app (.exe) — Electron + electron-builder
- `electron/main.cjs`: one BrowserWindow (min 1100×700, dark background `#0f1012`, title "Bàn Dựng Phim", no default menu bar; keep DevTools on Ctrl+Shift+I), loads the built app through a privileged custom protocol `app://bdp/` (standard + secure + supportFetchAPI + corsEnabled, registered before ready) that serves files from `dist/` — so IndexedDB/localStorage get a stable origin and data persists between launches. External links open in the default browser. Single-instance lock.
- Vite `base: './'` so the build works from the custom protocol and any static host. The service worker (PWA) is NOT registered inside Electron (`navigator.userAgent` contains "Electron" or `window.bdpDesktop`), only on http(s).
- `electron/preload.cjs` exposes `window.bdpDesktop = { version }` (contextIsolation on, nodeIntegration off).
- electron-builder (config in package.json "build"): appId `vn.bandungphim.app`, productName "Bàn Dựng Phim", files `dist/**` + `electron/**`, icon `build/icon.png` (512×512, generated), Windows targets **nsis** (assisted installer: choose directory, desktop + start-menu shortcuts, Vietnamese + English installer languages, artifactName `Ban-Dung-Phim-Setup-${version}.exe`) and **portable** (`Ban-Dung-Phim-Portable-${version}.exe`). Output dir `release/` (git-ignored).
- Scripts: `npm run desktop` (build + run Electron locally), `npm run dist:win` (build + both .exe). Unsigned: document the SmartScreen "More info → Run anyway" step in README.

## 6. Big download button (user request, like canvasapp's "Tải MP4")
- Every Take node gets a full-width primary button at the bottom: "⬇ Tải video" (completed) → downloads the video blob as `S03_T2 - <scene title>.<ext>` plus `S03_T2 - <scene title>.txt` with the prompt that was sent (canvasapp saved .mp4 + .txt the same way). While queued/processing the button is disabled and shows the progress ("Đang tạo 42%"); failed → "Chạy lại"; cancelled → "Chạy lại".
- Same big button in the TakeViewer footer and in the Storyboard player.
- "Tải tất cả take ★" (top bar menu / storyboard header): one .zip with the chosen take of every scene, named `S01_T2 - title.webm` in scene order, plus `prompts.txt`.
- Optional (Settings): "Tự tải video khi xong" toggle + folder picker (File System Access API `showDirectoryPicker`, remembered in IndexedDB; fallback = browser Downloads).

## 7. Round 3 requests (2026-10-01)
- **App name: "SanoVids"** (package `sanovids`, appId `com.sanovids.app`, exe `SanoVids-Setup-<v>.exe` / `SanoVids-Portable-<v>.exe`, data folder `%APPDATA%\SanoVids`, export files `.sanovids.json` — old `.bdp.json` still import). Top bar brand shows "SanoVids". IndexedDB database names stay unchanged (keeps existing data).
- **Square avatars everywhere** (no circles for characters): `AssetAvatar` is square now; every area must drop `border-radius: 50%` on asset/character thumbnails (keep circles only for status dots, spinners, handles, kbd-like pills).
- **Resizable nodes**: scene cards, take (video) nodes and asset nodes get React Flow `NodeResizer` (visible on selection/hover, min/max from `NODE_SIZE` in store/project.ts). Sizes persist: scenes/assets via `project.setNodeSizes(sizes, positions?)` (one undo step; positions when resizing from left/top edges), takes via `runs.setTakeSizes`. Double-click a resize handle → back to default (null). Content adapts: scene card shows more prompt lines and more avatars when taller/wider; take node poster grows (keeps 16:9, controls stay at the bottom with the big download button); asset node image grows. Auto-placed takes start right of the scene's actual width (`defaultTakePosition(pos, i, sceneW, takeW)`).

## 8. Reference images shown in full (2026-10-02)
User: "ảnh tham chiếu ném vào có thể hiển thị đầy đủ tấm ảnh tùy kích thước của ảnh để nắm rõ nội dung".
- Shared building blocks (done): `lib/imageMeta.ts` (`useImageSize`, `aspectOf`), `components/common/Media.tsx` `FullImage` (whole picture, object-fit contain, box takes the image's aspect ratio or fills its parent when `fill`), `components/common/ImageLightbox.tsx` + `actions.viewImages(ids, index, title)` / `actions.viewAssetImages(assetId)` (full-screen viewer, ←/→, Esc).
- Canvas asset node: shows the primary image in full at its own aspect ratio; the node's default size follows the image (default width ~200px, height = image + name/meta rows, within NODE_SIZE.asset); when the user resized it, the image letterboxes inside. "+N ảnh" badge for more images. A zoom button / click on the image opens the viewer.
- Library cards: full image (contain) at its aspect (clamped), cards packed in a 2-column masonry so tall and wide images both fit; zoom button on hover opens the viewer. AssetDialog image grid uses FullImage + viewer.
- Small square avatars stay square (user preference) but hovering an avatar (scene card, inspector reference rows, prompt legend chips) shows a floating full-image preview (max ~260px), and clicking a reference thumbnail in the inspector opens the viewer. AssetInspector's big image uses FullImage + viewer.
