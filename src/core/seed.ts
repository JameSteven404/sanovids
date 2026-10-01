// Demo project so the app is testable on first open. Content is original sample text.
import { avatarSvg, putBlob } from '../lib/imageStore'
import { defaultPresets, defaultProjectSettings, LAYOUT } from '../store/project'
import { newId } from './ids'
import type { Asset, Project, PromptBlock, Scene } from './types'

const ASSETS: { name: string; tag: string; kind: Asset['kind']; description: string; color: string; onCanvas: boolean }[] = [
  { name: 'Elara', tag: 'Elara', kind: 'character', description: 'young woman, long auburn braid, green wool cloak', color: '#e8894a', onCanvas: true },
  { name: 'Aurelian', tag: 'Aurelian', kind: 'character', description: 'tall man, short dark beard, leather armor', color: '#7c9cff', onCanvas: true },
  { name: 'Thú nhỏ Lumi', tag: 'Lumi', kind: 'character', description: 'small white fox-like creature with glowing blue eyes', color: '#5ac8fa', onCanvas: true },
  { name: 'Làng núi', tag: 'LangNui', kind: 'location', description: 'small medieval mountain village, stone houses, pine forest', color: '#8bc34a', onCanvas: true },
  { name: 'Hang động', tag: 'HangDong', kind: 'location', description: 'narrow cave with blue crystal light', color: '#b48cff', onCanvas: false },
  { name: 'Mặt dây chuyền', tag: 'MatDay', kind: 'prop', description: 'silver pendant with a moonstone', color: '#c9b14a', onCanvas: false },
]

const BLOCKS: Omit<PromptBlock, 'id'>[] = [
  {
    title: 'Phong cách phim',
    placement: 'before',
    defaultOn: true,
    color: '#e8894a',
    text: 'Live-action fantasy drama scene, naturalistic realistic footage with film-style editing: shots joined by soft motivated cuts, one clear action per shot, every cut easy to follow.',
  },
  {
    title: 'Ánh sáng & bối cảnh',
    placement: 'before',
    defaultOn: false,
    color: '#8bc34a',
    text: 'Setting and light: the village always looks the same — stone houses, pine forest, cold mountain air, soft overcast daylight or warm firelight at night.',
  },
  {
    title: 'Âm thanh (không nhạc)',
    placement: 'after',
    defaultOn: true,
    color: '#5ac8fa',
    text: 'Audio: natural ambient sound only. No music of any kind: no score, no drums, no choir, no singing, no humming. No narration, no subtitles, no on-screen text.',
  },
  {
    title: 'Nguyên bản',
    placement: 'after',
    defaultOn: true,
    color: '#b48cff',
    text: 'Originality: all characters, creatures and designs are original to this story; do not imitate any existing film, game or franchise.',
  },
  {
    title: 'Liên tục nhân vật',
    placement: 'after',
    defaultOn: true,
    color: '#d66b9a',
    text: 'Continuity: exactly one Elara and one Aurelian, each with one head, two arms and two legs, never duplicated, same clothes and hair as their reference images in every shot.',
  },
  {
    title: 'Ràng buộc lặp lại',
    placement: 'after',
    defaultOn: true,
    color: '#a3a3a3',
    text: 'Constraints, repeated: no music, no extra dialogue, no subtitles, no on-screen text, no extra people or animals.',
  },
]

const SCENES: { title: string; prompt: string; refs: string[]; preset: 'draft' | 'final' }[] = [
  { title: 'Leo dốc lúc chiều tà', preset: 'final', refs: ['Elara', 'LangNui'], prompt: 'At dusk @Elara climbs the last rocky slope above @LangNui, breathing hard, then stops and looks back at the lights of the village.' },
  { title: 'Ánh sáng trong hang', preset: 'final', refs: ['Elara', 'Lumi'], prompt: 'Inside a narrow cave @Elara follows a soft blue glow and discovers @Lumi curled on a crystal ledge. She kneels slowly, hand open.' },
  { title: 'Lumi tỉnh dậy', preset: 'draft', refs: ['Elara', 'Lumi'], prompt: '@Lumi opens its glowing eyes, sniffs @Elara\'s fingers, then climbs onto her shoulder. She laughs quietly.' },
  { title: 'Trở về làng', preset: 'draft', refs: ['Elara', 'Lumi', 'LangNui'], prompt: '@Elara walks back into @LangNui at night carrying @Lumi under her cloak, glancing around to make sure nobody sees.' },
  { title: 'Aurelian nghi ngờ', preset: 'draft', refs: ['Elara', 'Aurelian'], prompt: '@Aurelian waits by the fire, arms crossed. When @Elara enters he notices a faint blue light under her cloak. "What are you hiding?"' },
  { title: 'Lời thú nhận', preset: 'draft', refs: ['Elara', 'Aurelian', 'Lumi'], prompt: '@Elara slowly opens her cloak. @Lumi peeks out. @Aurelian steps back, then lowers his guard and kneels to look closer.' },
  { title: 'Bình minh', preset: 'draft', refs: ['Elara', 'Aurelian', 'LangNui'], prompt: 'Morning over @LangNui. @Elara and @Aurelian stand at the edge of the village watching the mist lift from the pine forest.' },
  { title: '', preset: 'draft', refs: [], prompt: '' },
]

export async function createDemoProject(): Promise<Project> {
  const now = Date.now()
  let assetY = LAYOUT.scenesY
  const assets: Asset[] = []
  for (const a of ASSETS) {
    const imageId = await putBlob(avatarSvg(a.name, a.color, a.kind), 'img')
    assets.push({
      id: newId('ast'),
      kind: a.kind,
      name: a.name,
      tag: a.tag,
      description: a.description,
      imageIds: [imageId],
      color: a.color,
      position: a.onCanvas ? { x: LAYOUT.assetX, y: assetY } : null,
    })
    if (a.onCanvas) assetY += LAYOUT.assetH + LAYOUT.assetGapY
  }
  const byTag = new Map(assets.map((a) => [a.tag, a.id]))
  const presets = defaultPresets()
  const blocks: PromptBlock[] = BLOCKS.map((b) => ({ ...b, id: newId('blk') }))

  let prev: string | null = null
  const scenes: Scene[] = SCENES.map((s, i) => {
    const preset = presets.find((p) => p.id === (s.preset === 'final' ? 'preset_final' : 'preset_draft'))!
    const { id: _pid, name: _pname, ...settings } = preset
    const id = newId('scn')
    const col = i % LAYOUT.perRow
    const row = Math.floor(i / LAYOUT.perRow)
    const scene: Scene = {
      id,
      order: i + 1,
      title: s.title,
      prompt: s.prompt,
      refs: s.refs.map((t) => byTag.get(t)!).filter(Boolean),
      blockOverrides: i === 1 ? { [blocks[1].id]: true } : {},
      presetId: preset.id,
      settings,
      continueFrom: prev,
      firstFrame: null,
      lastFrame: null,
      color: null,
      position: { x: LAYOUT.scenesX + col * (LAYOUT.sceneW + LAYOUT.gapX), y: LAYOUT.scenesY + row * (LAYOUT.sceneH + LAYOUT.gapY) },
      note: '',
    }
    prev = id
    return scene
  })

  return {
    id: newId('prj'),
    name: 'Phim demo: Elara & Lumi',
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    assets,
    blocks,
    presets,
    scenes,
    settings: defaultProjectSettings(),
  }
}
