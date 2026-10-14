import { ChevronDown, LayoutGrid } from 'lucide-react'
import { memo, useEffect, useRef } from 'react'
import { useArrangeMenu } from '../../arrangeActions'
import { resolveArrange, useArrangePrefs } from '../../lib/arrangePrefs'
import { arrangeTitle } from './arrangeModel'
import { ToolbarButton } from './ToolbarControls'

const toggleMenu = () => useArrangeMenu.getState().toggle()

/**
 * "Sắp xếp" split button: the button arranges with the saved style; ▾, a right-click or a touch hold opens
 * ArrangePopover (drawn by ToolbarBar, anchored to the `data-arrange-menu` button).
 */
export const ArrangeToolbarSlot = memo(function ArrangeToolbarSlot({ onArrange }: { onArrange: () => void }) {
  const open = useArrangeMenu((s) => s.open)
  const title = useArrangePrefs((s) => arrangeTitle(resolveArrange(s)))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const stopHold = () => { if (timer.current) clearTimeout(timer.current) }
  return <>
    <ToolbarButton className="cv-toolbar-button" label={title}
      onClick={() => { if (!held.current) onArrange(); held.current = false }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); toggleMenu() }}
      onPointerDown={(e) => { held.current = false; if (e.pointerType === 'touch') timer.current = setTimeout(() => { held.current = true; toggleMenu() }, 500) }}
      onPointerUp={stopHold} onPointerCancel={stopHold} onPointerLeave={stopHold}>
      <LayoutGrid size={16} strokeWidth={1.75} />
    </ToolbarButton>
    <ToolbarButton data-arrange-menu className="cv-toolbar-button cv-toolbar-arrange-menu" label="Kiểu sắp xếp & tuỳ chỉnh"
      aria-haspopup="dialog" aria-expanded={open} onClick={toggleMenu}>
      <ChevronDown size={12} strokeWidth={2} />
    </ToolbarButton>
  </>
})
