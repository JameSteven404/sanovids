// Demo project so the app is testable on first open. Content is original sample text.
// Prompts use the numbered tokens of each scene's refs (order of `refs` = @image_1, @image_2, …).
import { avatarSvg, putBlob } from '../lib/imageStore'
import { defaultPresets, defaultProjectSettings, LAYOUT, scenePosition } from '../store/project'
import { newId } from './ids'
import type { Asset, Project, Scene } from './types'

const ASSETS: { name: string; tag: string; kind: Asset['kind']; description: string; color: string; onCanvas: boolean }[] = [
  { name: 'Elara', tag: 'Elara', kind: 'character', description: 'young woman, long auburn braid, green wool cloak', color: '#e8894a', onCanvas: true },
  { name: 'Aurelian', tag: 'Aurelian', kind: 'character', description: 'tall man, short dark beard, leather armor', color: '#7c9cff', onCanvas: true },
  { name: 'Thú nhỏ Lumi', tag: 'Lumi', kind: 'character', description: 'small white fox-like creature with glowing blue eyes', color: '#5ac8fa', onCanvas: true },
  { name: 'Làng núi', tag: 'LangNui', kind: 'location', description: 'small medieval mountain village, stone houses, pine forest', color: '#8bc34a', onCanvas: true },
  { name: 'Hang động', tag: 'HangDong', kind: 'location', description: 'narrow cave with blue crystal light', color: '#b48cff', onCanvas: false },
  { name: 'Mặt dây chuyền', tag: 'MatDay', kind: 'prop', description: 'silver pendant with a moonstone', color: '#c9b14a', onCanvas: false },
]

const STYLE = 'Live-action fantasy drama, naturalistic realistic footage, soft motivated cuts, one clear action per shot.'
const AUDIO = 'Audio: natural ambient sound only, no music, no narration, no subtitles.'

const SCENES: { title: string; prompt: string; refs: string[]; preset: 'draft' | 'final' }[] = [
  {
    title: 'Leo dốc lúc chiều tà',
    preset: 'final',
    refs: ['Elara', 'LangNui'],
    prompt: `${STYLE}\n\nAt dusk @image_1 climbs the last rocky slope above the village in @image_2, breathing hard, then stops and looks back at the lights below.\n\n${AUDIO}`,
  },
  {
    title: 'Ánh sáng trong hang',
    preset: 'final',
    refs: ['Elara', 'Lumi'],
    prompt: `${STYLE}\n\nInside a narrow cave @image_1 follows a soft blue glow and discovers @image_2 curled on a crystal ledge. She kneels slowly, hand open.\n\n${AUDIO}`,
  },
  {
    title: 'Lumi tỉnh dậy',
    preset: 'draft',
    refs: ['Elara', 'Lumi'],
    prompt: `${STYLE}\n\n@image_2 opens its glowing eyes, sniffs @image_1's fingers, then climbs onto her shoulder. She laughs quietly.\n\n${AUDIO}`,
  },
  {
    title: 'Trở về làng',
    preset: 'draft',
    refs: ['Elara', 'Lumi', 'LangNui'],
    prompt: `${STYLE}\n\n@image_1 walks back into the village of @image_3 at night carrying @image_2 under her cloak, glancing around to make sure nobody sees.\n\n${AUDIO}`,
  },
  {
    title: 'Aurelian nghi ngờ',
    preset: 'draft',
    refs: ['Elara', 'Aurelian'],
    prompt: `${STYLE}\n\n@image_2 waits by the fire, arms crossed. When @image_1 enters he notices a faint blue light under her cloak. "What are you hiding?"\n\n${AUDIO}`,
  },
  {
    title: 'Lời thú nhận',
    preset: 'draft',
    refs: ['Elara', 'Aurelian', 'Lumi'],
    prompt: `${STYLE}\n\n@image_1 slowly opens her cloak. @image_3 peeks out. @image_2 steps back, then lowers his guard and kneels to look closer.\n\n${AUDIO}`,
  },
  {
    title: 'Bình minh',
    preset: 'draft',
    refs: ['Elara', 'Aurelian', 'LangNui'],
    prompt: `${STYLE}\n\nMorning over the village of @image_3. @image_1 and @image_2 stand at its edge watching the mist lift from the pine forest.\n\n${AUDIO}`,
  },
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

  const scenes: Scene[] = SCENES.map((s, i) => {
    const preset = presets.find((p) => p.id === (s.preset === 'final' ? 'preset_final' : 'preset_draft'))!
    const { id: _pid, name: _pname, ...settings } = preset
    return {
      id: newId('scn'),
      order: i + 1,
      title: s.title,
      prompt: s.prompt,
      refs: s.refs.map((t) => byTag.get(t)!).filter(Boolean),
      videoRefs: [],
      presetId: preset.id,
      settings,
      firstFrame: null,
      lastFrame: null,
      color: null,
      position: scenePosition(i),
      note: '',
    }
  })

  return {
    id: newId('prj'),
    name: 'Phim demo: Elara & Lumi',
    schemaVersion: 2,
    createdAt: now,
    updatedAt: now,
    assets,
    presets,
    scenes,
    settings: defaultProjectSettings(),
  }
}
