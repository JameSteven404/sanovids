// Test helper (no test of its own): mounts React components that render NOTHING into the DOM with react-dom/client
// although vitest runs in node without one — effects, StrictMode's development double mount and act() all run for
// real. Only for components that return null (or whose DOM-making children are mocked away).
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Just enough of a DOM element for createRoot / render / unmount. */
function container(): Element {
  const noop = () => undefined
  const doc = { nodeType: 9, addEventListener: noop, removeEventListener: noop }
  return { nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: null, ownerDocument: doc, addEventListener: noop, removeEventListener: noop } as unknown as Element
}

export function mountWithoutDom(el: ReactElement): Root {
  // react-dom reads window.event (an update's priority) and window.HTMLIFrameElement (focus around a commit)
  if (typeof window === 'undefined') vi.stubGlobal('window', { HTMLIFrameElement: class {} })
  const root = createRoot(container())
  act(() => root.render(el))
  return root
}

/** Let pending promises settle, inside act() so their state updates render. */
export async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}
