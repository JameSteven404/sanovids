import type { KeyEventLike } from '../core/keymap'
import { isTextEntry } from '../components/common/focus'

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)

/** Shared by local key handlers and the global dispatcher; accepts lightweight test targets too. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return isTextEntry(el) || el?.tagName?.toUpperCase() === 'SELECT' || el?.tagName?.toUpperCase() === 'VIDEO'
}

type EventSource = Partial<KeyEventLike> & { nativeEvent?: Partial<KeyEventLike>; getModifierState?: (key: string) => boolean }

/** React's composition flags live on nativeEvent. */
export function isImeKey(e: EventSource): boolean {
  return !!(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229 || e.nativeEvent?.keyCode === 229 || e.key === 'Process' || e.nativeEvent?.key === 'Process')
}

export function eventLike(e: EventSource): KeyEventLike {
  return {
    key: e.key ?? e.nativeEvent?.key ?? '', code: e.code ?? e.nativeEvent?.code ?? '',
    ctrlKey: !!e.ctrlKey, metaKey: !!e.metaKey, altKey: !!e.altKey, shiftKey: !!e.shiftKey,
    repeat: !!e.repeat, defaultPrevented: !!e.defaultPrevented, isComposing: isImeKey(e),
    keyCode: e.keyCode ?? e.nativeEvent?.keyCode,
    altGraph: !!(e.altGraph || e.getModifierState?.('AltGraph')),
  }
}
