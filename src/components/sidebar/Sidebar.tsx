import { Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AssetLibrary } from './AssetLibrary'
import { BlocksPanel } from './BlocksPanel'
import { PresetsPanel } from './PresetsPanel'
import { readPref, useFileDropGuard, writePref } from './shared'
import './sidebar.css'

type SectionId = 'library' | 'blocks' | 'presets'
type Collapsed = Record<SectionId, boolean>
const PREF_KEY = 'sb-collapsed'
const DEFAULT_COLLAPSED: Collapsed = { library: false, blocks: false, presets: false }

/** Left column: search + Thư viện / Khối prompt / Preset, each collapsible with its own scroll. */
export function Sidebar() {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Collapsed>(() => readPref(PREF_KEY, DEFAULT_COLLAPSED))
  const inputRef = useRef<HTMLInputElement>(null)
  useFileDropGuard()

  useEffect(() => writePref(PREF_KEY, collapsed), [collapsed])

  // Ctrl+K (useShortcuts) dispatches `bdp:search` → focus the search box.
  useEffect(() => {
    const onSearch = () => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.select()
    }
    window.addEventListener('bdp:search', onSearch)
    return () => window.removeEventListener('bdp:search', onSearch)
  }, [])

  const toggle = useCallback((id: SectionId) => setCollapsed((c) => ({ ...c, [id]: !c[id] })), [])
  const toggleLibrary = useCallback(() => toggle('library'), [toggle])
  const toggleBlocks = useCallback(() => toggle('blocks'), [toggle])
  const togglePresets = useCallback(() => toggle('presets'), [toggle])

  return (
    <div className="sb">
      <div className="sb-top">
        <label className="sb-search">
          <Search size={14} className="sb-search-icon" />
          <input
            ref={inputRef}
            className="input sb-search-input"
            placeholder="Tìm nhân vật, khối prompt…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                if (query) setQuery('')
                else e.currentTarget.blur()
              }
            }}
          />
          {query ? (
            <button className="sb-search-clear" onClick={() => setQuery('')} title="Xoá tìm kiếm" aria-label="Xoá tìm kiếm">
              <X size={13} />
            </button>
          ) : (
            <span className="kbd sb-search-kbd">Ctrl K</span>
          )}
        </label>
      </div>
      <div className="sb-sections">
        <AssetLibrary query={query} collapsed={collapsed.library} onToggle={toggleLibrary} />
        <BlocksPanel query={query} collapsed={collapsed.blocks} onToggle={toggleBlocks} />
        <PresetsPanel collapsed={collapsed.presets} onToggle={togglePresets} />
      </div>
    </div>
  )
}
