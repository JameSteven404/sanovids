# UI spec — demo v0.1

Goal of the demo: let the user test the **canvas board**, the **new ways of connecting**, and the **scene-production workflow** (characters reused across many scenes, shared prompt blocks, presets, batch runs, takes). Real usage this is designed from: 12 images, 26 scenes, 100 wires; two character images wired by hand 24× each; prompts of 2.3k–6.2k chars built from 6–8 copy-pasted paragraphs (style, audio, originality, references, continuity, constraints); presets "30s/480p draft" and "15s/1080p final"; every scene "continues from the previous scene".

Layout: `TopBar` (52px) / `Sidebar` left (272px) / center view (Canvas | Bảng cảnh | Storyboard) with `QueueDrawer` docked at the bottom of the center / `Inspector` right (392px). Dialogs are rendered by `App.tsx` from `useUI().dialog`.

Vocabulary (Vietnamese UI): Cảnh (scene, code S01), Nhân vật / Bối cảnh / Đạo cụ (asset kinds character/location/prop; "style" = Phong cách), Thư viện (library), Khối prompt (prompt block), Preset, Take (T1, T2…), Hàng đợi (queue), Nối (connect), Bỏ nối (disconnect), Chạy (run), Nháp / Final.

---------------------------------------------------------------------------------------------------

## A. Canvas — `components/canvas/*`, `hooks/useShortcuts.ts`

Files: `CanvasView.tsx` (exports `CanvasView`, wraps its own `ReactFlowProvider`), `SceneNode.tsx`, `AssetNode.tsx`, `edges.tsx` (custom edges), `CanvasToolbar.tsx`, `ConnectMenu.tsx`, `canvas.css`, plus `hooks/useShortcuts.ts` (exports `useShortcuts`, mounted once in App).

Data flow (important for correctness/perf):
- Nodes are DERIVED from `useProject().project`: one `scene` node per scene (`id = scene.id`), one `asset` node per asset with `position !== null` (`id = asset.id`). Position = `useUI().dragPos[id] ?? entity.position`. Include `measured: useUI().measured[id]` and `selected: selectedIds.includes(id)`. Keep `data` objects referentially stable per id (cache by id) so memoized node components don't re-render needlessly; node components read their entity from the store by id.
- `onNodesChange`: `dimensions` → `ui.setMeasured`; `position` with `dragging: true` → `ui.setDragPos`; drag end → `project.setPositions(...)` for all moved nodes (one undo step) then `ui.clearDragPos(ids)`; `select` → `ui.select` (mirror RF selection; keep it in sync both ways). Ignore `remove` changes (deletion goes through `actions.deleteSelection`, set `deleteKeyCode={null}`).
- Edges are DERIVED: `ref:<assetId>-><sceneId>` for each scene.refs entry whose asset is on canvas; `seq:<prev>-><scene>` for continueFrom; `first:`/`last:` for H3 transform frames. Edge visibility by `ui.edgeMode`: `hidden` → only edges of the hovered node; `selected` (default) → edges touching selected or hovered nodes, plus selected edges; `all` → all. Selected edges via `onEdgesChange` select → `ui.setSelectedEdges`.
- Edge styling: ref edges teal `--ref` (or the asset's color at 70% when highlighted), seq edges dashed grey `--seq` with arrow, first/last green/purple. Custom edge component shows a small round "×" button at the midpoint when hovered or selected → cuts that link (use `useProject` deleteItems / removeRef / setContinueFrom(null) / setFrame null). Bezier paths. When many edges converge on a scene, they must target the scene's left handle area but should not all meet at one pixel: spread target Y by ref index (use a `refs` target handle per index is NOT required — instead compute targetY offset in the custom edge from the ref index: `targetY + (index - (n-1)/2) * 6`, clamped).
- Interaction modes (`ui.interaction`): `hand` (default): left-drag on empty canvas pans, Shift+drag box-selects. `select`: left-drag box-selects, Space or middle mouse pans. Wheel = zoom (zoomOnScroll), Ctrl+wheel also zoom; trackpad pinch works. `minZoom 0.1`, `maxZoom 2`. Snap to grid 16px (`snapToGrid`). `onlyRenderVisibleElements`.
- Background: dots `--border`. MiniMap (toggle `ui.showMinimap`) bottom-right, node color = scene status color / asset color. Controls component not needed (toolbar has zoom).

SceneNode (compact card, ~280px wide, auto height ~180–220):
- Header: `S07` badge (accent), editable title (double-click → inline input; empty title shows "Chưa đặt tên" faint), model short name badge, status dot of the latest take.
- Ref row: avatars of refs (AssetAvatar 24px, overlapping slightly), max 6 then "+N"; each avatar hover → tooltip "@Tag · @image_N"; small "×" on hover removes ref. If no refs: faint "Kéo nhân vật vào đây".
- Prompt excerpt: 2 lines, mentions highlighted (`@Elara` in teal). Empty prompt → "Chưa có prompt" faint.
- Footer: settings label (`15s · 1080P · 16:9`), preset name if any, cost `20 cr`, warning icon if compile has warnings (tooltip lists them), Run button (▶, accent; disabled + tooltip reason when not runnable; calls `actions.requestRun([id])`).
- Takes strip: `<TakeStrip sceneId={id} size="sm" />` (from runs area) at the bottom when the scene has takes.
- Handles: target handle left (teal, "ref"), source handle right (grey, "seq" = continuity / next scene). For H3 `transform` mode also show two target handles on the left-bottom labeled ĐẦU (green, id `first`) and CUỐI (purple, id `last`).
- LOD: when zoom < 0.55 render a "far" version: big `S07`, title, status color bar, starred-take poster thumbnail if any; no text/handles detail. Read zoom with `useStore(s => s.transform[2] < 0.55)` (boolean selector).
- Drop target for library drag (HTML5 DnD, dataTransfer type `application/x-bdp-assets` = JSON array of asset ids): on dragover highlight the card (teal ring) and show "Thả để nối"; if the card is selected and other scenes are selected too, hint "Nối vào N cảnh đã chọn". On drop → `actions.linkAssets(targets, assetIds)`. Also accept image files dropped on a scene: create assets from files and link them.
- Hover → `ui.setHovered(id)` (drives edge highlighting). Dim non-connected nodes while hovering (CSS class on wrapper via data attribute is fine).
- Selected style: accent outline. Running take: thin animated progress bar on top edge.

AssetNode (~180px): image (square/round by kind), name, `@Tag`, usage count "dùng ở 24 cảnh", kind icon. Source handle right (teal). Double-click → open `{kind:'asset', assetId}` dialog. Draggable onto scenes via React Flow connection (handle) — see connecting rules.

Connecting rules (the core of the redesign):
1. Drag from an asset node's handle and release ANYWHERE over a scene card (not only the handle): add ref. Implement with `onConnectEnd`: find the scene under the pointer (`document.elementsFromPoint` → closest `.react-flow__node[data-id]`), or use `onConnect` when dropped on a handle. If the target scene is selected together with other scenes, link to all selected scenes. Show live feedback while connecting: valid scene targets get a teal ring (`.cv-connect-target`).
2. Release on empty canvas → open `ConnectMenu` at the pointer: for asset source: "Tạo cảnh mới có @Tag", "Nối vào N cảnh đang chọn" (if any). For scene source (right handle): "Tạo cảnh tiếp theo ở đây" (`project.createNextScene(src, position)`), "Huỷ".
3. Drag from a scene's right handle to another scene → `setContinueFrom(target, source)` (reject cycles with toast).
4. Drop asset onto H3 transform ĐẦU / CUỐI handle → `setFrame`.
5. Reconnect: dragging an existing ref edge's end onto another scene moves it (`edgesReconnectable`, `onReconnect` → `moveRefToScene`).
6. Click an edge → selects it; Delete/Backspace cuts it; hover shows the × button.
7. `isValidConnection`: asset→scene (ref/first/last), scene→scene (seq, not self). Everything else invalid.
8. Drop from library onto empty canvas → place those assets on the canvas at the drop point (`setAssetOnCanvas`). Drop image files onto empty canvas → create assets there.
9. Double-click empty canvas → new scene at that position (`actions.newScene(pos)`).

CanvasToolbar (floating, bottom-center of the canvas, above QueueDrawer): buttons with icons + shortcut hints in tooltips: `+ Cảnh` (N when nothing selected / next scene when a scene is selected), `Nối (C)`, `Chạy (Ctrl+Enter)` showing count of selected scenes, `Sắp xếp` (autoLayout then fitView), `Vừa màn hình (F)`, interaction toggle Tay (H) / Chọn (V), edge mode segmented [Ẩn | Đang chọn | Tất cả] (E cycles), minimap toggle (M), zoom % display with − / + / 100%.
Also a small floating hint in the top-left of the canvas when selection mixes assets & scenes: "3 nhân vật · 12 cảnh đang chọn — bấm C để nối".

Focus requests: listen to `actions.canvasEvents` 'focus' (detail: ids) → `fitView({ nodes, padding, duration: 300 })` (all nodes when empty).

useShortcuts (global; ignore when typing in input/textarea/contenteditable except Ctrl+Enter / Ctrl+S / Escape): Delete/Backspace → deleteSelection; Ctrl+Z undo; Ctrl+Shift+Z / Ctrl+Y redo; Ctrl+D duplicateSelection; N nextScene; C connectSelection; Ctrl+Enter requestRun(selected scenes); Ctrl+A select all scenes (canvas view); Escape clear selection / close dialog; F focus all (or selection); E cycle edge mode; H / V interaction; M minimap; 1/2/3 switch view canvas/table/storyboard; ? open shortcuts dialog; Ctrl+S → `persist.flush()` + toast "Đã lưu"; Ctrl+K → focus sidebar search (dispatch `window.dispatchEvent(new Event('bdp:search'))`).

---------------------------------------------------------------------------------------------------

## B. Sidebar — `components/sidebar/*`

Files: `Sidebar.tsx` (exports `Sidebar`), `AssetLibrary.tsx`, `BlocksPanel.tsx`, `PresetsPanel.tsx`, `AssetDialog.tsx` (exports `AssetDialog({assetId})`), `BlockDialog.tsx` (exports `BlockDialog({blockId})`), `sidebar.css`.

Sidebar: three collapsible sections stacked with their own scroll: **Thư viện** (assets), **Khối prompt**, **Preset**. A search box at top filters assets & blocks (listens to `bdp:search` window event to focus). Collapse state remembered in localStorage.

AssetLibrary:
- Filter chips: Tất cả / Nhân vật / Bối cảnh / Đạo cụ / Phong cách, count per kind.
- Grid of cards (2 columns): image (AssetAvatar large or MediaImg cover), name, `@Tag`, usage badge (number of scenes whose refs include it), "trên canvas" dot if position set. Click = select in library (`ui.toggleLibrary`, Ctrl/Shift = additive). Selected cards get accent ring. Double-click = AssetDialog.
- Drag & drop: cards are `draggable`; on dragstart set dataTransfer `application/x-bdp-assets` with JSON array of asset ids (all selected ones if the dragged card is selected, else just it) and `ui.setDraggingAssets(ids)`; clear on dragend. Custom drag image showing avatars + count.
- Upload: "+ Thêm" button (file input, multiple, images) → `actions.createAssetsFromFiles(files, {kind: current filter or character})`. Also dropping image files onto the library area adds assets.
- Hover card actions: "Đặt lên canvas"/"Bỏ khỏi canvas" toggle, "Nối vào cảnh đang chọn" (linkAssets to selected scenes), "Sửa".
- Footer hint: "Kéo thả vào cảnh để nối · chọn nhiều + C để nối hàng loạt".

AssetDialog (Modal): name, tag (`@` prefix, validated unique via store), kind select, color swatches (PALETTE from core/ids), description (used in the References paragraph — explain that), images grid with: add images (file input), remove, reorder (left/right buttons), first image marked "ảnh chính". Right column: list of scenes using it (`S03 Title`) with button "Bỏ khỏi tất cả cảnh" (removeRefs). Delete asset button (confirm) → `removeAssets`. Changes apply live (no save button needed; footer "Xong").

BlocksPanel:
- List of blocks in order with: color bar, title, placement badge (Trước / Sau prompt), default on/off switch ("Mặc định bật cho mọi cảnh"), count of scenes overriding, 2-line text preview. Drag to reorder (or up/down buttons) → `moveBlock`. Click → BlockDialog. "+ Khối" button.
- Small explanation line at the top: "Sửa một lần, áp dụng cho mọi cảnh."
- If one or more scenes are selected, each block row shows a tri-state toggle for the selection: on / off / theo mặc định (`setBlockOverride(selectedSceneIds, blockId, value)`).

BlockDialog (Modal, wide): title, placement radio, defaultOn, color, big textarea (monospace-ish, char count), live note "Đang dùng ở X/Y cảnh", delete button (confirm).

PresetsPanel: list of presets (name, model, settings label, cost). Click "Áp dụng" → applyPreset to selected scenes (disabled when none selected; tooltip). Edit inline (expand row with model/mode/duration/resolution/ratio selects using `MODELS`), add/delete preset.

---------------------------------------------------------------------------------------------------

## C. Inspector — `components/inspector/*`

Files: `Inspector.tsx` (exports `Inspector`), `SceneInspector.tsx`, `MultiSceneInspector.tsx`, `AssetInspector.tsx`, `PromptEditor.tsx`, `FinalPromptPreview.tsx`, `inspector.css`.

Inspector switches on selection (`ui.selectedIds` + `ui.librarySelection`): 1 scene → SceneInspector; ≥2 scenes → MultiSceneInspector; else 1 asset (canvas or library) → AssetInspector; else empty state with tips (how to connect, shortcuts list short, "Nhập prompt cũ" button opening `{kind:'import'}`).

SceneInspector (scrollable, sections with `.section-title`):
1. Header: `S07` + editable title input, prev/next scene arrows (navigate by order, select + focusNodes), "Tiếp nối từ" select (none or any other scene) → setContinueFrom.
2. Video settings: Preset select (applies preset), Model, Mode (only modes of model), Duration, Resolution, Ratio (`MODELS`), cost badge. Changing any setting calls `updateSettings([id], patch)`.
3. Prompt: `PromptEditor`.
4. Tham chiếu (references): ordered list; each row: drag handle (reorder via `moveRef`), avatar, name, `@Tag`, computed `@image_N` numbers (from compileScene().images), × remove. Note when over the model's image limit. "+ Thêm" opens a small picker popover listing library assets (search) → linkAssets([id], [asset]).
   For H3 transform: two slots Khung đầu / Khung cuối with asset pickers.
5. Khối prompt: checklist of all blocks with effective state; 3-state (theo mặc định / bật / tắt) → setBlockOverride.
6. Prompt cuối (FinalPromptPreview): collapsible, shows compiled text with `@image_N` tokens highlighted and blocks visually separated, char count `12.345 / 20.000` (red when over), warnings list, buttons "Copy prompt" (`actions.copyCompiledPrompt`) and "Tải ảnh + prompt (.zip)" (`actions.downloadSceneZip`) — label hint "Dùng cho canvasapp".
7. Takes: `<TakeStrip sceneId size="md" />` + Run button large: "Chạy · 15s · 20 credit" → `actions.requestRun([id])`.
8. Ghi chú (note) textarea.

PromptEditor (the @mention editor):
- Textarea (auto-grow, min 8 rows) bound to `project.setScenePrompt(id, text)`. It returns newly linked asset ids → toast "Đã tự nối @Elara" with Undo.
- Typing `@` opens a popup anchored near the caret listing assets (avatar, name, @Tag, kind), filtered by the typed letters, ↑/↓/Enter/Tab to pick, Esc to close; picking inserts `@Tag ` replacing the partial token. Compute caret coordinates with a mirror-div technique.
- Below the textarea: char count of the scene prompt itself, legend "Gõ @ để chèn nhân vật — tự nối vào cảnh".
- Under that, a row of chips for unknown mentions (`@Foo` not in library) with "Tạo nhân vật @Foo" quick action (addAsset).
- When the user removes the last mention of an asset that is in refs, show a non-blocking hint chip "Bỏ nối @Elara?" with a button (removeRef). Do NOT auto-remove.

MultiSceneInspector (N scenes): summary (count, total cost of a run), batch settings (Preset apply, model/duration/resolution/ratio selects that apply to all; show "—" when mixed), common references: union of refs with counts "12/12 cảnh" and buttons add to all / remove from all, blocks tri-state for all, buttons: "Chạy N cảnh · X credit" (requestRun), "Nhân bản", "Xoá", "Copy tất cả prompt" (concatenate compiled prompts with `=== S01 ===` headers).

AssetInspector: big image, name/tag/kind/description inline-editable, images strip, "Dùng ở N cảnh" list (click → select that scene + focus), buttons: "Nối vào cảnh đang chọn" (if scenes selected), "Đặt lên canvas"/"Bỏ khỏi canvas", "Sửa chi tiết" (AssetDialog).

---------------------------------------------------------------------------------------------------

## D. Runs — `components/runs/*`

Files: `QueueDrawer.tsx`, `RunConfirmDialog.tsx`, `TakeStrip.tsx`, `TakeViewer.tsx`, `runs.css`. You may improve `src/lib/mockProvider.ts` (keep its exported API).

RunConfirmDialog({sceneIds}) (Modal, wide): uses `useRuns.getState().check(ids)`; table rows: code, title, model, settings, refs count, warnings (icon + text), cost, status (OK / reason why skipped, red). Footer: total "Chạy 12 cảnh · 240 credit", balance before → after, "Huỷ" / primary "Chạy" (disabled if nothing runnable or not enough credits) → `actions.runNow(ids)` then close. Also a checkbox "Chỉ chạy cảnh chưa có take" that filters the list (scenes with no completed take).

QueueDrawer: docked at the bottom of the center area (absolute, full width of center). Collapsed bar (36px): "Hàng đợi" + counts (đang chạy / chờ / xong / lỗi) + mini progress; click toggles `ui.queueOpen`. Expanded (~260px, resizable not required): list of takes sorted newest first, grouped by status sections; each row: poster thumb (MediaImg posterId) or spinner, `S07 · T2`, scene title, settings, status badge, progress bar, elapsed time, cost, actions: Huỷ (queued/processing), Thử lại (failed/cancelled), Xem (completed → TakeViewer), Đi tới cảnh (select + focusNodes). Header actions: "Xoá các job lỗi/đã huỷ khỏi danh sách". Shows demo credit balance + "spent" + note "Chế độ demo: video giả, không tốn tiền".

TakeStrip({sceneId, size}): horizontal list of the scene's takes (newest last): thumbnail (poster), `T2` label, status overlay (spinner with % / red ! for failed), star toggle (★ filled accent when starred), click → open `{kind:'take', takeId}`. `sm` = 44×26 thumbs, max 5 + "+N"; `md` = 96×54 thumbs, all, wrap. Must be cheap: use `useSceneTakes(sceneId)`.

TakeViewer({takeId}) (Modal, xwide): left: video player (`useMediaUrl(videoId)` webm, autoplay muted loop, controls) or poster; prev/next take of the same scene; right: `S07 · T2`, status, timings, settings, cost, ★ toggle, refs snapshot (avatars), "Prompt đã gửi" (promptSnapshot, scrollable, copy button), diff vs current compiled prompt (simple: "Prompt hiện tại đã khác" badge + button), buttons "Khôi phục prompt này" (`actions.restoreFromTake`), "Chạy lại", "Tải về" (download video/poster blob with name `S07_T2.webm`), "Xoá take".

---------------------------------------------------------------------------------------------------

## E. Top bar, views and dialogs — `components/topbar/*`, `components/views/*`, `components/dialogs/*`, `src/core/importPrompts.ts`

TopBar: left: app mark "Bàn Dựng" (small logo square + text), project name (click → inline rename `renameProject`), save status dot+text from `useSave` ("Đã lưu" / "Đang lưu…" / "Lỗi lưu"), "Dự án" button → ProjectsDialog. Center: view segmented control [Canvas 1 | Bảng cảnh 2 | Storyboard 3]. Right: undo/redo icon buttons (disabled based on `useProject.temporal` past/future length — use `useStore(useProject.temporal, s => s.pastStates.length)`), running indicator "⚡ 2 đang chạy" (opens queue), credit pill "377 credit · demo", "Nhập prompt" button (import dialog), settings icon, shortcuts icon (?), toggle left/right panels icons.

SceneTable view ("Bảng cảnh"): spreadsheet-like list ordered by scene.order. Columns: drag handle (reorder → `moveScene`), checkbox (selection synced with `ui.selectedIds`), Cảnh (S01), Tên (inline edit), Nhân vật (avatars; drop target for library drag like the canvas card), Prompt (first 120 chars; click selects row; Inspector edits), Khối (n/N on), Cấu hình (settings label; preset name), Credit, Take (TakeStrip sm), Trạng thái, Run button. Header: select all, bulk bar when rows selected (Áp dụng preset ▾, Nối nhân vật ▾ (pick from library), Chạy, Nhân bản, Xoá). Footer: totals (scenes, est. cost of running all, number with starred takes). Keyboard ↑/↓ moves selection.

Storyboard view: grid of scenes in order (cards 16:9): starred take poster (or latest completed, or placeholder with code), code + title, duration, status. Header: "Phát liền" button → a player overlay that plays each scene's starred (else latest completed) take video in order (webm), showing S-code captions, with prev/next; scenes without video show the poster for its duration/5 seconds (demo). Also totals: total runtime of starred takes, scenes missing a starred take (click to jump).

ImportDialog ("Nhập prompt cũ", Modal xwide), with logic in `src/core/importPrompts.ts` (pure, unit-tested in `src/core/__tests__/importPrompts.test.ts`):
- Input: paste a big text where prompts are separated by lines of `---` / `===` / `***` (3+ chars) OR upload many `.txt` files (canvasapp auto-download saves one `.txt` per video — each file = one scene, title = file name).
- `splitPrompts(text) → string[]`; `analyzePrompts(prompts) → { paragraphs per prompt, candidates: {key, text, count, variants[], avgPosition}[] }` where paragraphs are split on blank lines; normalized key = lowercase, collapsed whitespace; candidates = paragraphs appearing in ≥ max(2, 30% of prompts) prompts; also group near-duplicates sharing the same first 48 normalized chars as variants (pick the most frequent variant as block text). Suggest a block title from the paragraph's leading label (`Audio:` → "Audio", `Constraints, repeated:` → "Constraints") or first words. Placement = 'before' if avgPosition < 0.35 else 'after'.
- `applyImport(prompts, selectedCandidates) → { blocks, scenes }`: blocks from chosen candidates; each scene prompt = its paragraphs minus those matching a chosen candidate (exact or variant); scenes whose paragraph was a different variant keep that paragraph inline. Detect `@image_N` tokens and keep them (warn in UI that they can be mapped to library assets later).
- UI: step 1 input (textarea + file drop + "Dùng ví dụ" button that loads 3 sample prompts), step 2 review: list of candidate blocks with checkbox, count "xuất hiện ở 18/24 prompt", editable title, placement; preview of resulting scene count and average chars saved per scene; step 3 confirm → `project.applyImport(...)` (one undo step), toast, switch to canvas and focus.

SettingsDialog: project settings (autoReferences, autoContinuity, referencesTemplate with `{list}` token + reset to default), mock provider (`useRuns().mock`: speed fast/normal/slow, failRate slider 0–50%, concurrency 1–5, recordVideo), demo credits "+100 credit demo" button, data: export project (`persist.exportProjectFile`), import `.bdp.json` (`persist.importProjectFile`), "Tạo lại dự án demo" (`persist.createDemo`).

ProjectsDialog: list from `useSave().projects` (name, scenes, updated time relative), actions: open (`switchProject`), duplicate, delete (confirm), "+ Dự án trống" (`createProject`), "+ Dự án demo" (`createDemo`), import file.

ShortcutsDialog: table of all shortcuts listed in section A (useShortcuts) and the connecting gestures, in Vietnamese.
