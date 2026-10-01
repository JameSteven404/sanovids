# Bàn Dựng Phim — demo

Node-canvas app for producing AI films scene by scene (replacement concept for canvasapp.io.vn).
Demo phase: frontend only, runs locally, **mock video provider** (no network, no real cost).

## Run
- `npm run dev` → http://localhost:5180 (or double-click `start.bat`)
- `npm run typecheck`, `npm test` (vitest), `npm run build`

## Stack
Vite 8 + React 19 + TypeScript 7 (`tsc` is the native compiler) + `@xyflow/react` 12 (React Flow) + zustand 5 + zundo (undo/redo) + lucide-react 1.x + idb-keyval + jszip.

## Architecture (read before editing) — schema v2, see docs/SPEC-v2.md
- `src/core/types.ts` — domain model. `Scene.refs` (ordered asset ids) = reference images → `@image_N`; `Scene.videoRefs` (ordered take ids) = reference videos → `@video_N`. Canvas wires are only a view of these lists. No prompt blocks, no auto references paragraph, no scene→scene continuity link.
- `src/core/compile.ts` — pure: the prompt is sent as written; token helpers (`parseTokens`, `imageSlots`, `tokenForAsset`, `remapTokens`), validation warnings/notes. `src/core/migrate.ts` upgrades v1 data. Tests in `src/core/__tests__`, `src/store/__tests__`.
- `src/core/models.ts` — model capabilities (image/video limits), credit pricing, `costOf`, `normalizeSettings`.
- `src/store/project.ts` — undoable project store (zundo). Every refs/videoRefs change renumbers prompt tokens in the same undo step. `LAYOUT`, `ROW_H`, `defaultTakePosition`: one scene per row, its takes to the right.
- `src/store/runs.ts` — takes (= video nodes on the canvas, `take.position`) + mock job queue (not undoable). `removeTakes` also drops them from every scene's videoRefs.
- `src/store/ui.ts` — selection (scene, asset and take ids), view, dialogs, drag overlay, toasts, `takeDisplay`.
- `src/store/persist.ts` — IndexedDB autosave (+ localStorage emergency backup), project list, export/import `.bdp.json`. All functions are async. Media blobs: `src/lib/imageStore.ts`.
- `src/actions.ts` — shared commands (linkAssets, linkTakes, ensureAssetToken, createSceneFromTake, deleteSelection, run, copy, zip). UI calls these. Use `undoToastAction()` from the project store for toast undo buttons.
- Edge ids: `ref:<assetId>-><sceneId>`, `first:`/`last:` (H3 frames), `out:<sceneId>-><takeId>`, `vref:<takeId>-><sceneId>` (see `edgeId`/`parseEdgeId`).

## Conventions
- UI text in Vietnamese; model names stay English (Seedance 2.5, MiniMax-H3).
- zustand v5: a selector must return a stable value. Select primitives / existing objects, or wrap derived arrays/objects in `useShallow` (`zustand/react/shallow`). Never `useStore(s => s.list.filter(...))` without `useShallow` — it loops forever.
- Styling: plain CSS files next to components, using tokens from `src/styles/base.css` (`--panel`, `--accent`, `--ref`, …) and shared classes (`.btn`, `.btn-primary`, `.icon-btn`, `.input`, `.select`, `.textarea`, `.badge`, `.chip`, `.kbd`, `.empty`, `.section-title`, `.status-dot.<status>`, `.progress`). Prefix component classes per area: `cv-` canvas, `sb-` sidebar, `in-` inspector, `rq-` runs/queue, `vw-` views, `dg-` dialogs, `tb-` top bar.
- Shared components: `components/common/Modal.tsx`, `Toasts.tsx`, `Media.tsx` (`MediaImg`, `AssetAvatar`, `AssetChip`).
- Dark theme only for now. Keep it fast with 100+ scenes: memoize node components, avoid subscribing big components to the whole project.
