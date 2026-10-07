// Red placeholders "@image_?N(label)" (GT1, "giữ token"): removing a reference picture never deletes prompt text; the
// token becomes a labelled placeholder that blocks the run until the user fills it explicitly.
import { describe, expect, it } from 'vitest'
import { compileScene, extractMentions, imageKey, imageSlotsFor, LABELLED_TOKEN_RE, mediaKeys, PLACEHOLDER_RE, placeholderToken, remapTokens } from '../compile'
import {
  allGroupsToText,
  assetDeleteImpact,
  assetDeleteQuestion,
  fillChoices,
  groupKeyOf,
  keepTokenOnly,
  labelledTokens,
  linkFillOffer,
  membersToText,
  parsePlaceholders,
  placeholderAt,
  placeholderGroups,
  placeholdersAddedSince,
  placeholdersToText,
  placeholderTitle,
  planFill,
  planReplace,
  removalLabels,
  removeMembers,
} from '../placeholders'
import { mediaChangeNote, scenesWithStaleTokens } from '../staleTokens'
import { characterLabel, labelFitsSlot, sanitizeLabel, splitLabel } from '../tokenLabels'
import type { Asset, Project, Scene } from '../types'

const asset = (id: string, name: string, images = 1, tag = name): Asset => ({
  id,
  kind: 'character',
  name,
  tag,
  description: '',
  imageIds: Array.from({ length: images }, (_, i) => `${id}${i + 1}`),
  color: '#fff',
  position: null,
})
const elara = asset('e', 'Elara', 2)
const lumi = asset('l', 'Lumi')
const village = asset('v', 'Làng')
const mira = asset('m', 'Mira')
const ALL = [elara, lumi, village, mira]

const scene = (over: Partial<Scene> = {}): Scene => ({
  id: 's1',
  order: 1,
  title: '',
  prompt: '',
  refs: [],
  videoRefs: [],
  presetId: null,
  settings: { model: 'seedance_2_5', mode: 't2v', duration: 15, resolution: '1080p', ratio: '16:9' },
  firstFrame: null,
  lastFrame: null,
  color: null,
  position: { x: 0, y: 0 },
  note: '',
  ...over,
})
const project = (scenes: Scene[], assets: Asset[] = ALL, autoRenumber = true): Project => ({
  id: 'p',
  name: 'P',
  schemaVersion: 2,
  createdAt: 0,
  updatedAt: 0,
  presets: [],
  settings: { autoRenumber },
  assets,
  scenes,
})

/** What the store's withMedia does to a prompt for a refs change (assets unchanged). */
function cut(prompt: string, assets: Asset[], refsBefore: string[], refsAfter: string[], keepNumbers = false, assetsAfter = assets) {
  const before = mediaKeys(assets, refsBefore)
  const label = removalLabels(assets, { beforeKeys: before.images, refsAfter, assetsAfter })
  return remapTokens(prompt, before, mediaKeys(assetsAfter, refsAfter), () => 'NAME', { keepNumbers, placeholder: label }).text
}

describe('labels', () => {
  it('sanitizeLabel: NFC, no ( ) [ ] @ ? / line breaks, spaces collapsed, ≤ 40 code points + "…", blank → null', () => {
    expect(sanitizeLabel('  Lumi  ')).toBe('Lumi')
    expect(sanitizeLabel('Bé (An) [x] @y? z\nw\tq')).toBe('Bé An x y z w q')
    expect(sanitizeLabel('Lé')).toBe('Lé') // NFD → NFC
    expect(sanitizeLabel(' () ')).toBeNull()
    expect(sanitizeLabel(undefined)).toBeNull()
    const long = sanitizeLabel('Một cái tên rất là dài dài dài dài dài dài dài dài')!
    expect(long.endsWith('…')).toBe(true)
    expect([...long].length).toBeLessThanOrEqual(41)
    expect(long).toBe('Một cái tên rất là dài dài dài dài dài…') // cut at a word boundary (≥ 20 code points in)
    const emoji = sanitizeLabel('😀'.repeat(50))!
    expect([...emoji].length).toBe(41)
    // the emoji label still parses whole (u flag, ≤ 120 UTF-16 units)
    expect(parsePlaceholders(placeholderToken('image', 2, emoji))[0].label).toBe(emoji)
  })
  it('characterLabel: the name; the (unique) tag when the name is shared or blank', () => {
    const lumi2 = asset('l2', ' lumi', 1, 'LumiNho')
    expect(characterLabel(lumi, [lumi, village])).toBe('Lumi')
    expect(characterLabel(lumi, [lumi, lumi2])).toBe('Lumi') // its tag
    expect(characterLabel(lumi2, [lumi, lumi2])).toBe('LumiNho')
    expect(characterLabel(asset('x', '  ', 1, 'Xa'), [])).toBe('Xa')
  })
  it('splitLabel reads " · ảnh k"', () => {
    expect(splitLabel('Elara · ảnh 2')).toEqual({ base: 'Elara', k: 2 })
    expect(splitLabel('Lumi')).toEqual({ base: 'Lumi', k: 1 })
  })
  it('removalLabels: name for picture 1 of a removed character, " · ảnh k" for later ones, every k when still linked, null when unknown', () => {
    const before = mediaKeys(ALL, ['e', 'l']).images
    const whole = removalLabels(ALL, { beforeKeys: before, refsAfter: ['l'], assetsAfter: ALL })
    expect(whole('e:e1')).toBe('Elara')
    expect(whole('e:e2')).toBe('Elara · ảnh 2')
    const one = removalLabels(ALL, { beforeKeys: before, refsAfter: ['e', 'l'], assetsAfter: ALL })
    expect(one('e:e1')).toBe('Elara · ảnh 1')
    expect(removalLabels([], { beforeKeys: before, refsAfter: [], assetsAfter: [] })('e:e1')).toBeNull()
  })
})

describe('the rule of the user: cutting a reference never deletes prompt text', () => {
  it('cut Lumi: "@image_1 hugs @image_?2(Lumi) in front of @image_2" (Làng moves to 2, the placeholder keeps 2)', () => {
    expect(cut('@image_1 hugs @image_2 in front of @image_3', [asset('e', 'Elara'), lumi, village], ['e', 'l', 'v'], ['e', 'v'])).toBe(
      '@image_1 hugs @image_?2(Lumi) in front of @image_2',
    )
  })
  it('a multi-picture character removed: one placeholder per picture', () => {
    expect(cut('@image_1, @image_2 and @image_3', ALL, ['e', 'l'], ['l'])).toBe('@image_?1(Elara), @image_?2(Elara · ảnh 2) and @image_1')
  })
  it('renumbering off (Q8b): only the removed picture turns red, other numbers stay as written', () => {
    expect(cut('@image_1 @image_2 @image_3', [asset('e', 'Elara'), lumi, village], ['e', 'l', 'v'], ['e', 'v'], true)).toBe('@image_1 @image_?2(Lumi) @image_3')
  })
  it('every byte outside the token stays, and the old regex of v0.2–v0.5 still reads the placeholder (older builds block it too)', () => {
    const out = cut('Đêm, @image_2 khóc. (@image_1)', [asset('e', 'Elara'), lumi], ['e', 'l'], ['e'])
    expect(out).toBe('Đêm, @image_?2(Lumi) khóc. (@image_1)')
    expect([...out.matchAll(/@(image|video)_\?(\d+)/gi)].map((m) => m[0])).toEqual(['@image_?2'])
  })
  it('placeholders are never renumbered by later changes', () => {
    const once = cut('@image_1 @image_2 @image_3', [asset('e', 'Elara'), lumi, village], ['e', 'l', 'v'], ['e', 'v'])
    expect(cut(once, [asset('e', 'Elara'), lumi, village], ['e', 'v'], ['v', 'e'])).toBe('@image_2 @image_?2(Lumi) @image_1')
  })
})

describe('reading placeholders', () => {
  it('PLACEHOLDER_RE: bare, labelled, a spaced "(cười)" is not eaten, video ones read', () => {
    const text = '@image_?2 (cười) @image_?3(Lumi · ảnh 2) @video_?1(S01·T1)'
    expect([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[0])).toEqual(['@image_?2', '@image_?3(Lumi · ảnh 2)', '@video_?1(S01·T1)'])
    const ph = parsePlaceholders(text)
    expect(ph[1]).toMatchObject({ kind: 'image', n: 3, label: 'Lumi · ảnh 2', base: 'Lumi', imageNo: 2 })
    expect(ph[0].label).toBeUndefined()
  })
  it('placeholderAt: strictly inside only', () => {
    const t = 'x @image_?2(Lumi) y'
    expect(placeholderAt(t, 2)).toBeNull()
    expect(placeholderAt(t, 3)?.text).toBe('@image_?2(Lumi)')
    expect(placeholderAt(t, 16)?.text).toBe('@image_?2(Lumi)')
    expect(placeholderAt(t, 17)).toBeNull()
  })
  it('extractMentions never reads "@image_" of a placeholder as a @Tag', () => {
    expect(extractMentions('@image_?2(Lumi) @Elara')).toEqual(['Elara'])
  })
  it('placeholderTitle', () => {
    expect(placeholderTitle({ kind: 'image', n: 2, label: 'Lumi', text: '@image_?2(Lumi)' })).toBe('Ảnh @image_2 (Lumi) đã bị bỏ nối — nối ảnh thay thế rồi chọn ở dải dưới ô prompt')
  })
})

describe('labelled tokens ("?" deleted by hand)', () => {
  const s = scene({ refs: ['e', 'v'], prompt: '' }) // e = 1,2   v = 3
  it('fits only the character (name / tag) AND picture number of its slot', () => {
    expect(labelFitsSlot('Elara', elara, 0, ALL)).toBe(true)
    expect(labelFitsSlot('Elara · ảnh 2', elara, 1, ALL)).toBe(true)
    expect(labelFitsSlot('Elara · ảnh 2', elara, 0, ALL)).toBe(false)
    expect(labelFitsSlot('Lumi', village, 0, ALL)).toBe(false)
    expect(labelFitsSlot('làng', village, 0, ALL)).toBe(true)
  })
  it('a mismatching label blocks the run (unsentTokens verbatim + warning); a fitting one only notes', () => {
    const bad = compileScene(project([{ ...s, prompt: '@image_3(Lumi) waves' }]), { ...s, prompt: '@image_3(Lumi) waves' })
    expect(bad.unsentTokens).toEqual(['@image_3(Lumi)'])
    expect(bad.warnings.some((w) => w.startsWith('@image_3 bây giờ là “Làng”, không phải “Lumi”'))).toBe(true)
    const ok = compileScene(project([{ ...s, prompt: '@image_3(Làng) waves' }]), { ...s, prompt: '@image_3(Làng) waves' })
    expect(ok.unsentTokens).toEqual([])
    expect(ok.notes.some((n) => n.includes('sẽ được gửi cùng prompt'))).toBe(true)
    const pic = compileScene(project([{ ...s, prompt: '@image_1(Elara · ảnh 2)' }]), { ...s, prompt: '@image_1(Elara · ảnh 2)' })
    expect(pic.unsentTokens).toEqual(['@image_1(Elara · ảnh 2)'])
  })
  it('two characters with the same name: only the tag fits', () => {
    const lumi2 = asset('l2', 'Lumi', 1, 'LumiNho')
    const assets = [lumi, lumi2]
    const sc = scene({ refs: ['l2'], prompt: '@image_1(Lumi) runs' })
    expect(compileScene(project([sc], assets), sc).unsentTokens).toEqual(['@image_1(Lumi)'])
    const sc2 = scene({ refs: ['l2'], prompt: '@image_1(LumiNho) runs' })
    expect(compileScene(project([sc2], assets), sc2).unsentTokens).toEqual([])
  })
  it('labelledTokens / LABELLED_TOKEN_RE', () => {
    expect([...'@image_2(Lumi) @image_2 (x)'.matchAll(LABELLED_TOKEN_RE)].map((m) => m[0])).toEqual(['@image_2(Lumi)'])
    expect(labelledTokens('@image_3(Lumi)', ALL, ['e', 'v'])[0]).toMatchObject({ fits: false, slotName: 'Làng', base: 'Lumi' })
  })
})

describe('groups', () => {
  it('same base = one group; bare ones only with identical text; a mismatching labelled token is its own group', () => {
    const p = '@image_?1(Elara) @image_?2(Elara · ảnh 2) @image_?5 @image_?5 @image_1(Lumi)'
    const g = placeholderGroups(p, ALL, ['v'])
    expect(g.map((x) => [x.key, x.kind, x.members.length])).toEqual([
      ['L:Elara', 'label', 2],
      ['T:@image_?5', 'bare', 2],
      ['M:@image_1(Lumi)', 'mismatch', 1],
    ])
    expect(g[2].slotName).toBe('Làng')
    expect(groupKeyOf('@image_?2(Elara · ảnh 2)')).toBe('L:Elara')
    expect(groupKeyOf('@image_?5')).toBe('T:@image_?5')
    expect(groupKeyOf('@image_1(Lumi)')).toBe('M:@image_1(Lumi)')
  })
  it('two roles named "Lumi" never share a group: filling one leaves the other', () => {
    const lumi2 = asset('l2', 'Lumi', 1, 'LumiNho')
    const assets = [lumi, lumi2, mira]
    const prompt = cut('@image_1 and @image_2', assets, ['l', 'l2'], [])
    expect(prompt).toBe('@image_?1(Lumi) and @image_?2(LumiNho)')
    const plan = planFill({ prompt, refs: ['m'] }, assets, 'L:LumiNho', 'm', { renumber: true, maxImages: 9 })
    expect(plan.ok && plan.prompt).toBe('@image_?1(Lumi) and @image_1')
  })
  it('the explicit text fixes', () => {
    const p = 'A @image_?2(Lumi) b @image_?2(Lumi), c'
    const [g] = placeholderGroups(p, ALL, [])
    expect(membersToText(p, g.members)).toBe('A Lumi b Lumi, c')
    expect(removeMembers(p, g.members)).toBe('A b , c') // removeTokenAt: one of two spaces goes, nothing else
    const m = '@image_1(Lumi) runs'
    expect(keepTokenOnly(m, placeholderGroups(m, ALL, ['v'])[0].members)).toBe('@image_1 runs')
    expect(allGroupsToText('@image_?1(Elara) @image_?4 @image_1(Lumi)', ALL, ['v'])).toBe('Elara @image_?4 Lumi')
    expect(placeholdersToText('@image_?1(Elara) x @image_?2')).toBe('Elara x @image_?2')
    // never glued into a mention / token: "@" + "Lumi" would read as @Lumi
    expect(membersToText('@@image_?2(Lumi)', placeholderGroups('@@image_?2(Lumi)', ALL, [])[0].members)).toBe('@ Lumi')
  })
})

describe('planFill (always an explicit click)', () => {
  const base = { renumber: true, maxImages: 9 }
  // after cutting Lumi from [Elara(1), Lumi, Làng]: refs [e1, v]
  const e1 = asset('e', 'Elara')
  const assets = [e1, lumi, village, mira]
  const afterCut = { prompt: '@image_1 hugs @image_?2(Lumi) in front of @image_2', refs: ['e', 'v'] }

  it('linked but not named yet → moved to the removed one\'s place; the other tokens follow', () => {
    const plan = planFill({ ...afterCut, refs: ['e', 'v', 'm'] }, assets, 'L:Lumi', 'm', base)
    expect(plan).toEqual({ ok: true, prompt: '@image_1 hugs @image_2 in front of @image_3', refs: ['e', 'm', 'v'], token: '@image_2', filled: 1, left: 0 })
  })
  it('not linked yet → linked at that place (n0 = 1 → first)', () => {
    const plan = planFill({ prompt: '@image_?1(Lumi) and @image_1', refs: ['v'] }, assets, 'L:Lumi', 'm', base)
    expect(plan.ok && [plan.prompt, plan.refs]).toEqual(['@image_1 and @image_2', ['m', 'v']])
  })
  it('already named by a real token → stays where it is (R4)', () => {
    const plan = planFill({ prompt: '@image_?1(Lumi) and @image_2', refs: ['v', 'm'] }, assets, 'L:Lumi', 'm', base)
    expect(plan.ok && [plan.prompt, plan.refs]).toEqual(['@image_2 and @image_2', ['v', 'm']])
  })
  it('renumbering off → appended, only the placeholder text changes', () => {
    const plan = planFill(afterCut, assets, 'L:Lumi', 'm', { ...base, renumber: false })
    expect(plan.ok && [plan.prompt, plan.refs]).toEqual(['@image_1 hugs @image_3 in front of @image_2', ['e', 'v', 'm']])
  })
  it('a character with fewer pictures fills what it can; the rest stays red', () => {
    const plan = planFill({ prompt: '@image_?1(Elara) @image_?2(Elara · ảnh 2) + @image_1', refs: ['l'] }, [elara, lumi, mira], 'L:Elara', 'm', base)
    expect(plan.ok && [plan.prompt, plan.filled, plan.left]).toEqual(['@image_1 @image_?2(Elara · ảnh 2) + @image_2', 1, 1])
  })
  it('a mismatching labelled token is filled like a placeholder', () => {
    const plan = planFill({ prompt: '@image_1 @image_2(Lumi)', refs: ['e', 'v'] }, assets, 'M:@image_2(Lumi)', 'm', base)
    // Mira goes where Lumi was (slot 2), Làng moves to 3
    expect(plan.ok && [plan.prompt, plan.refs]).toEqual(['@image_1 @image_2', ['e', 'm', 'v']])
  })
  it('refusals leave everything as it is', () => {
    const scene0 = { ...afterCut }
    const noPic = asset('n', 'Nobody', 0)
    expect(planFill(scene0, [...assets, noPic], 'L:Lumi', 'n', base)).toEqual({ ok: false, why: 'no-image' })
    expect(planFill(scene0, assets, 'L:Lumi', 'zz', base)).toEqual({ ok: false, why: 'no-asset' })
    expect(planFill(scene0, assets, 'L:Elara', 'm', base)).toEqual({ ok: false, why: 'gone' })
    expect(planFill(scene0, assets, 'L:Lumi', 'm', { ...base, maxImages: 2 })).toEqual({ ok: false, why: 'over-limit' })
    expect(planFill({ prompt: '@image_?2(Elara · ảnh 2)', refs: [] }, [elara, mira], 'L:Elara', 'm', base)).toEqual({ ok: false, why: 'few-images' })
    expect(scene0).toEqual(afterCut)
  })
})

describe('planReplace (drag the picture end of a wire onto another character)', () => {
  it('same picture count → the prompt stays byte for byte', () => {
    const plan = planReplace({ prompt: 'A @image_1 b @image_2.', refs: ['l', 'v'] }, ALL, 'l', 'm', { renumber: true, maxImages: 9 })
    expect(plan).toEqual({ ok: true, prompt: 'A @image_1 b @image_2.', refs: ['m', 'v'] })
  })
  it('2 → 1 picture → "@image_?k(Tên · ảnh 2)"; 1 → 2 pictures → the extra one is sent, later numbers follow', () => {
    const fewer = planReplace({ prompt: '@image_1 @image_2 @image_3', refs: ['e', 'v'] }, ALL, 'e', 'm', { renumber: true, maxImages: 9 })
    expect(fewer.ok && fewer.prompt).toBe('@image_1 @image_?2(Elara · ảnh 2) @image_2')
    const more = planReplace({ prompt: '@image_1 @image_2', refs: ['m', 'v'] }, ALL, 'm', 'e', { renumber: true, maxImages: 9 })
    expect(more.ok && more.prompt).toBe('@image_1 @image_3')
  })
  it('refused: not linked, already linked, no picture, over the limit', () => {
    const s0 = { prompt: '@image_1', refs: ['l'] }
    expect(planReplace(s0, ALL, 'v', 'm', { renumber: true, maxImages: 9 })).toEqual({ ok: false, why: 'not-linked' })
    expect(planReplace({ ...s0, refs: ['l', 'm'] }, ALL, 'l', 'm', { renumber: true, maxImages: 9 })).toEqual({ ok: false, why: 'already-linked' })
    expect(planReplace(s0, [...ALL, asset('n', 'N', 0)], 'l', 'n', { renumber: true, maxImages: 9 })).toEqual({ ok: false, why: 'no-image' })
    expect(planReplace(s0, ALL, 'l', 'e', { renumber: true, maxImages: 1 })).toEqual({ ok: false, why: 'over-limit' })
  })
})

describe('fill choices, link offer, change notes, delete impact', () => {
  it('fillChoices: linked pictures nobody names first, newest link first', () => {
    const order = fillChoices('@image_1 @image_?9(X)', ALL, ['v', 'l', 'm']).map((c) => [c.asset.id, c.named])
    expect(order).toEqual([
      ['m', false],
      ['l', false],
      ['v', true],
    ])
  })
  it('linkFillOffer: one label in the newly linked scenes → offer; typed-ahead bare ones never count; different labels → none', () => {
    const before = project([scene({ id: 's1', order: 1, prompt: '@image_?2(Lumi) @image_?7 x', refs: ['e'] }), scene({ id: 's2', order: 2, prompt: '@image_?1(Lumi)', refs: [] })])
    const after = project(before.scenes.map((s) => ({ ...s, refs: [...s.refs, 'm'] })))
    expect(linkFillOffer(before, after, ['m']).offer).toEqual({ assetId: 'm', base: 'Lumi', example: '@image_?2(Lumi)', sceneIds: ['s1', 's2'] })
    const mixed = project([after.scenes[0], { ...after.scenes[1], prompt: '@image_?1(Elara)' }])
    const res = linkFillOffer(before, mixed, ['m'])
    expect(res.offer).toBeNull()
    expect(res.pending).toEqual(['s1', 's2'])
    // two labelled groups, one named like the new character → that one
    const two = project([{ ...after.scenes[0], prompt: '@image_?1(Elara) @image_?2(Mira)' }])
    expect(linkFillOffer(project([before.scenes[0]]), two, ['m']).offer?.base).toBe('Mira')
    // several characters at once: never an offer
    expect(linkFillOffer(before, after, ['m', 'l']).offer).toBeNull()
  })
  it('placeholdersAddedSince counts per scene as a multiset', () => {
    const b = [scene({ id: 's1', prompt: '@image_?2(Lumi) x' })]
    const a = [scene({ id: 's1', prompt: '@image_?2(Lumi) x @image_?2(Lumi)' })]
    expect(placeholdersAddedSince(b, a)).toEqual([{ sceneId: 's1', added: ['@image_?2(Lumi)'] }])
  })
  it('mediaChangeNote: one scene, several scenes, stale numbers (renumbering off) after the placeholders, renumbered', () => {
    const s = (id: string, order: number, prompt: string, refs: string[] = []) => scene({ id, order, prompt, refs })
    const before = project([s('s1', 1, '@image_1 @image_2', ['e', 'v']), s('s2', 2, '@image_1', ['v'])])
    const one = project([s('s1', 1, '@image_?1(Elara) @image_?2(Elara · ảnh 2)', ['v']), before.scenes[1]])
    expect(mediaChangeNote(before, one)).toEqual({ text: ' — prompt giữ chữ đỏ @image_?1(Elara) (+1) (chặn Chạy) để bạn gắn ảnh thay thế', tone: 'warning', ms: 10000 })
    const two = project([one.scenes[0], s('s2', 2, '@image_?1(Làng)')])
    expect(mediaChangeNote(before, two)?.text).toBe(' · 2 cảnh giữ chữ đỏ (S01, S02) — chưa chạy được cho tới khi gắn ảnh thay thế')
    const renum = project([s('s1', 1, '@image_2 @image_1', ['v', 'e']), before.scenes[1]])
    expect(mediaChangeNote(before, renum)).toEqual({ text: ' · đánh lại số @image trong 1 prompt', tone: 'info' })
    // renumbering off: Làng's token kept "@image_3" now points at nothing — named after the placeholder note
    const offBefore = project([s('s1', 1, '@image_1 @image_2 @image_3', ['e', 'v'])], ALL, false)
    const offAfter = project([s('s1', 1, '@image_?1(Elara) @image_?2(Elara · ảnh 2) @image_3', ['v'])], ALL, false)
    expect(scenesWithStaleTokens(offBefore, offAfter)).toEqual(['s1'])
    expect(mediaChangeNote(offBefore, offAfter)?.text).toBe(
      ' — prompt giữ chữ đỏ @image_?1(Elara) (+1) (chặn Chạy) để bạn gắn ảnh thay thế · tự đánh lại số đang tắt — hãy sửa số @image trong S01',
    )
    expect(mediaChangeNote(before, before)).toBeNull()
  })
  it('assetDeleteImpact / assetDeleteQuestion: named → confirm with the number of scenes; unused → one click', () => {
    const p = project([
      scene({ id: 's1', order: 1, prompt: '@image_1 x', refs: ['l'] }),
      scene({ id: 's2', order: 2, prompt: 'no token', refs: ['l'] }),
      scene({ id: 's3', order: 3, prompt: '@image_2', refs: ['v', 'l'] }),
    ])
    const used = assetDeleteImpact(p, ['l'])
    expect(used).toEqual({ sceneIds: ['s1', 's3'], placeholders: 2, frameSceneIds: [], linkedSceneIds: ['s1', 's2', 's3'], needsConfirm: true })
    expect(assetDeleteQuestion('Lumi', 1, used)).toBe(
      'Xoá “Lumi” khỏi thư viện? 2 cảnh đang dùng nhân vật này sẽ giữ chữ đỏ và chưa chạy được cho tới khi bạn gắn nhân vật khác (Ctrl+Z để hoàn tác).',
    )
    const unused = assetDeleteImpact(p, ['m'])
    expect(unused.needsConfirm).toBe(false)
    expect(assetDeleteQuestion('Mira', 1, unused)).toBeNull()
    const frame = assetDeleteImpact(project([scene({ firstFrame: 'm' })]), ['m'])
    expect(frame.needsConfirm).toBe(true)
  })
})

describe('key helpers stay consistent with the queue snapshot', () => {
  it('imageSlotsFor + imageKey are what the queue captures (imageKeysSnapshot)', () => {
    expect(imageSlotsFor(ALL, ['e', 'l']).map(imageKey)).toEqual(['e:e1', 'e:e2', 'l:l1'])
  })
})
