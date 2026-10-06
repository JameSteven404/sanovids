# SanoVids — instructions for coding agents (Codex, Antigravity, others)

**Read `CLAUDE.md` first. It is the authoritative, up-to-date description of the architecture, conventions and the
security / signing / updater rules.** This file only adds the rules that matter when an agent other than Claude works here.

- UI text Vietnamese, code comments English, CSS tokens only (dark + light), zustand selectors must return stable values.
- Never run `electron .`, the packaged app, electron.exe, browsers or other GUI programs from a sandbox (they crash and pop up
  error dialogs on the user's screen). Use `npm run typecheck` and `npx vitest run --exclude ".claude/**"` to verify.
- Never touch `%APPDATA%\SanoVids` (the user's real data), never kill processes you did not start, never call
  canvasapp.io.vn or seedvis.com, never sign anything, never change certificate trust, never add npm dependencies unless the
  task says so, never add a `beforeunload` handler.
- Edit only the files your task assigns to you; other agents edit other files in the same tree at the same time.
- Do not commit, push, merge or switch branches unless your task explicitly says so.
