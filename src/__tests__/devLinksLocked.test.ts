// Development mode locked (DV): "Bảng phát triển" cannot open (actions.openDevPanel does nothing), so the take viewer
// and the queue never show a link to it on a DEV take or a dev issue — a dead button would look broken (DV → XT / DV2b
// handoff). Source guards (no DOM test environment): every openDevPanel button there sits behind useDevAllowed().
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** The 160 characters before each `openDevPanel(` call in JSX. */
const contexts = (src: string) => [...src.matchAll(/onClick=\{\(\) => openDevPanel\(/g)].map((m) => src.slice(Math.max(0, (m.index ?? 0) - 160), m.index))

describe('links to "Bảng phát triển" only while development mode is open', () => {
  it('take viewer: the refund note and the job id link', () => {
    const src = read('../components/runs/TakeViewer.tsx')
    expect(src).toContain("import { useDevAllowed } from '../../providers/devAccess'")
    const ctx = contexts(src)
    expect(ctx).toHaveLength(2)
    expect(ctx[0]).toContain('{devOpen && (')
    expect(ctx[1]).toContain("provider === 'dev' && devOpen && (")
    // the uncertain-charge wording never sends a locked user to the panel
    expect(src).toContain("devOpen ? 'kiểm tra trong Bảng phát triển' : 'mở khoá chế độ Phát triển để kiểm tra'")
  })
  it('queue: the dev issue banner (the head button exists only while new takes use development mode)', () => {
    const src = read('../components/runs/QueueDrawer.tsx')
    const ctx = contexts(src)
    expect(ctx.some((c) => c.includes("issue.provider === 'dev' && devOpen && ("))).toBe(true)
    expect(src).toMatch(/\{provider === 'dev' \? \(\s*<DevPanelButton \/>/)
  })
})
