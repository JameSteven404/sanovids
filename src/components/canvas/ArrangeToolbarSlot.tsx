import { LayoutGrid } from 'lucide-react'
import { memo } from 'react'
import { ToolbarButton } from './ToolbarControls'

/** Merge point for ArrangePopover; the existing arrange command remains the only implementation. */
export const ArrangeToolbarSlot = memo(function ArrangeToolbarSlot({ onArrange }: { onArrange: () => void }) {
  return <ToolbarButton className="cv-toolbar-button" label="Sắp xếp lại canvas" onClick={onArrange}>
    <LayoutGrid size={16} strokeWidth={1.75} />
  </ToolbarButton>
})
