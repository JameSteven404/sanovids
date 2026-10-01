import { Search, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AssetLibrary } from './AssetLibrary'
import { PresetsPanel } from './PresetsPanel'
import { readPrefValue, useFileDropGuard, writePref } from './shared'
import { TakesPanel } from './TakesPanel'
import './sidebar.css'

type SectionId = 'library' | 'takes' | 'presets'
type Collapsed = Record<SectionId, boolean>
const PREF_KEY = 'sb-collapsed'
const SECTIONS: SectionId[] = ['library', 'takes', 'presets']

/** Only the known sections (an older saved value may carry keys of removed sections). */
function loadCollapsed(): Collapsed {
  const saved = readPrefValue<Partial<Record<string, unknown>>>(PREF_KEY, {})
  const out = { library: false, takes: false, presets: false }
  for (const id of SECTIONS) if (typeof saved?.[id] === 'boolean') out[id] = saved[id] as boolean
  return out
}

/** Left column: search + Thư viện / Video đã tạo / Preset, each collapsible with its own scroll. */
export function Sidebar() {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Collapsed>(loadCollapsed)
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
  const toggleTakes = useCallback(() => toggle('takes'), [toggle])
  const togglePresets = useCallback(() => toggle('presets'), [toggle])

  return (
    <div className="sb">
      <div className="sb-top">
        <label className="sb-search">
          <Search size={14} className="sb-search-icon" />
          <input
            ref={inputRef}
            className="input sb-search-input"
            placeholder="Tìm nhân vật, bối cảnh, video…"
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
        <TakesPanel query={query} collapsed={collapsed.takes} onToggle={toggleTakes} />
        <PresetsPanel collapsed={collapsed.presets} onToggle={togglePresets} />
      </div>
    </div>
  )
}
