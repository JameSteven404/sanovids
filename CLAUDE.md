# SanoVids — demo

Node-canvas app for producing AI films scene by scene (replacement concept for canvasapp.io.vn).
Frontend (web + Electron desktop). New takes run in **development mode** by default: the real canvasapp gateway code against an in-app **simulated canvasapp.io.vn** (`src/providers/dev/` — no network, fake "credit dev"); the real canvasapp.io.vn gateway is opt-in in the desktop app. The old mock demo only runs takes saved before.

## Run
- `npm run dev` → http://localhost:5180 (or double-click `start.bat`)
- `npm run typecheck`, `npm test` (vitest), `npm run build`

## Stack
Vite 8 + React 19 + TypeScript 7 (`tsc` is the native compiler) + `@xyflow/react` 12 (React Flow) + zustand 5 + zundo (undo/redo) + lucide-react 1.x + idb-keyval + jszip.

## Architecture (read before editing) — schema v2, see docs/SPEC-v2.md
- `src/core/types.ts` — domain model. `Scene.refs` (ordered asset ids) = reference images → `@image_N`; `Scene.videoRefs` (ordered take ids) = reference videos → `@video_N`. Canvas wires are only a view of these lists. No prompt blocks, no auto references paragraph, no scene→scene continuity link.
- `src/core/compile.ts` — pure: the prompt is sent as written; token helpers (`parseTokens`, `imageSlots`, `tokenForAsset`, `remapTokens`), validation warnings/notes. Character sync rules: a token with no media in the request (`unsentTokens`: past the model cap, mode without refs, or an `@image_?N` placeholder) blocks the run; `remapTokens` keeps typed-ahead numbers only on a pure append of new assets, otherwise turns them into `@image_?N`. The queue sends `take.imageKeysSnapshot` (captured with `promptSnapshot`), never the live refs — see `src/__tests__/characterSync.test.ts`. `src/core/staleTokens.ts`: warnings when renumbering is off. `src/core/migrate.ts` upgrades v1 data. Tests in `src/core/__tests__`, `src/store/__tests__`.
- `src/core/models.ts` — model capabilities (image/video limits), credit pricing, `costOf`, `normalizeSettings`.
- `src/store/project.ts` — undoable project store (zundo). Every refs/videoRefs change renumbers prompt tokens in the same undo step. `LAYOUT`, `ROW_H`, `defaultTakePosition`: one scene per row, its takes to the right.
- `src/store/runs.ts` — takes (= video nodes on the canvas, `take.position`) + the job queue engine (not undoable). `removeTakes` also drops them from every scene's videoRefs.
- `src/providers/` — `index.ts`: registry, `activeProviderId()` ('dev' | 'canvasapp', never 'mock'), `activeGateway()` (api + bridge of the dev or real gateway — balance, login, top-up, history all go through it), `resetDevMode()`. `canvasapp/`: the real gateway (api, adapter, mapping, transport). `dev/`: development mode — `server.ts` (simulated canvasapp, faults, persistence), `bridge.ts` (simulated electron gateway), `prompts.ts` (login / SePay sheets), `log.ts` (request log), `validate.ts` + `routes.ts` (strict rules shared with tests / main.cjs allowlist). See docs/SPEC-v2.md §11.
- `src/store/ui.ts` — selection (scene, asset and take ids), view, dialogs, drag overlay, toasts, `takeDisplay`.
- `src/store/persist.ts` — IndexedDB autosave (+ localStorage emergency backup), project list, export/import `.sanovids.json`. All functions are async. Media blobs: `src/lib/imageStore.ts`.
- `src/actions.ts` — shared commands (linkAssets, linkTakes, ensureAssetToken, createSceneFromTake, deleteSelection, run, copy, zip). UI calls these. Use `undoToastAction()` from the project store for toast undo buttons.
- Edge ids: `ref:<assetId>-><sceneId>`, `first:`/`last:` (H3 frames), `out:<sceneId>-><takeId>`, `vref:<takeId>-><sceneId>` (see `edgeId`/`parseEdgeId`).

## Conventions
- UI text in Vietnamese; model names stay English (Seedance 2.5, MiniMax-H3).
- zustand v5: a selector must return a stable value. Select primitives / existing objects, or wrap derived arrays/objects in `useShallow` (`zustand/react/shallow`). Never `useStore(s => s.list.filter(...))` without `useShallow` — it loops forever.
- Styling: plain CSS files next to components, using tokens from `src/styles/base.css` (`--panel`, `--accent`, `--ref`, …) and shared classes (`.btn`, `.btn-primary`, `.icon-btn`, `.input`, `.select`, `.textarea`, `.badge`, `.chip`, `.kbd`, `.empty`, `.section-title`, `.status-dot.<status>`, `.progress`). Prefix component classes per area: `cv-` canvas, `sb-` sidebar, `in-` inspector, `rq-` runs/queue, `vw-` views, `dg-` dialogs, `tb-` top bar, `tu-` top-up, `dv-` development mode (components/dev). Never use a bare utility name (`progress`, `ok`…) as a modifier class: `.progress` is the global progress bar.
- Shared components: `components/common/Modal.tsx`, `Toasts.tsx`, `Media.tsx` (`MediaImg`, `AssetAvatar`, `AssetChip`).
- Development mode UI (`components/dev/`): `DevPanel.tsx` ("Bảng phát triển", dialog kind 'dev', `actions.openDevPanel(tab)`), `DevSheets.tsx` (simulated login / SePay sheets mounted at the App root above dialogs, `data-top-overlay`), `devModel.ts` (pure texts / fault catalog / log filter / "Kiểm tra nhân vật", tested). User-facing wording: "Phát triển" / "DEV" / "credit dev"; "demo" only for legacy mock takes ("Demo cũ").
- Dark theme only for now. Keep it fast with 100+ scenes: memoize node components, avoid subscribing big components to the whole project.
