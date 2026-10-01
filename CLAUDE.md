# Bàn Dựng Phim — demo

Node-canvas app for producing AI films scene by scene (replacement concept for canvasapp.io.vn).
Demo phase: frontend only, runs locally, **mock video provider** (no network, no real cost).

## Run
- `npm run dev` → http://localhost:5180 (or double-click `start.bat`)
- `npm run typecheck`, `npm test` (vitest), `npm run build`

## Stack
Vite 8 + React 19 + TypeScript 7 (`tsc` is the native compiler) + `@xyflow/react` 12 (React Flow) + zustand 5 + zundo (undo/redo) + lucide-react 1.x + idb-keyval + jszip.

## Architecture (read before editing)
- `src/core/types.ts` — domain model. `Scene.refs` (ordered asset ids) IS the connection data; canvas wires are only a view of it.
- `src/core/compile.ts` — pure prompt compiler: blocks + scene prompt + auto "References" paragraph, `@Tag` → `@image_N`. Covered by tests in `src/core/__tests__`.
- `src/core/models.ts` — model capabilities (Seedance 2.5, MiniMax-H3), credit pricing, `costOf`, `normalizeSettings`.
- `src/store/project.ts` — undoable project store (zundo). All authoring mutations live here. Text edits are coalesced into one undo step.
- `src/store/runs.ts` — takes + mock job queue engine (not undoable). `src/lib/mockProvider.ts` renders poster/webm.
- `src/store/ui.ts` — selection, view, dialogs, drag overlay, toasts (not undoable).
- `src/store/persist.ts` — localStorage autosave, project list, export/import `.bdp.json`. Media blobs in IndexedDB (`src/lib/imageStore.ts`).
- `src/actions.ts` — shared commands (connect, delete, duplicate, run, copy prompt, zip). UI calls these.
- Edge ids: `ref:<assetId>-><sceneId>`, `seq:<prevSceneId>-><sceneId>`, `first:<assetId>-><sceneId>`, `last:...` (see `edgeId`/`parseEdgeId`).

## Conventions
- UI text in Vietnamese; model names stay English (Seedance 2.5, MiniMax-H3).
- zustand v5: a selector must return a stable value. Select primitives / existing objects, or wrap derived arrays/objects in `useShallow` (`zustand/react/shallow`). Never `useStore(s => s.list.filter(...))` without `useShallow` — it loops forever.
- Styling: plain CSS files next to components, using tokens from `src/styles/base.css` (`--panel`, `--accent`, `--ref`, …) and shared classes (`.btn`, `.btn-primary`, `.icon-btn`, `.input`, `.select`, `.textarea`, `.badge`, `.chip`, `.kbd`, `.empty`, `.section-title`, `.status-dot.<status>`, `.progress`). Prefix component classes per area: `cv-` canvas, `sb-` sidebar, `in-` inspector, `rq-` runs/queue, `vw-` views, `dg-` dialogs, `tb-` top bar.
- Shared components: `components/common/Modal.tsx`, `Toasts.tsx`, `Media.tsx` (`MediaImg`, `AssetAvatar`, `AssetChip`).
- Dark theme only for now. Keep it fast with 100+ scenes: memoize node components, avoid subscribing big components to the whole project.
