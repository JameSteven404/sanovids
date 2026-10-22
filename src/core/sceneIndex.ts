// Scenes by id, cached per scenes array (the store replaces the array on every change, never mutates it): ONE map built
// per change, shared by every selector that looks a scene up (canvas nodes, the inspector's fields, the library) —
// instead of each selector scanning the whole list (`scenes.find`) on every keystroke. Pure, no imports.
import type { Scene } from './types'

const maps = new WeakMap<readonly Scene[], Map<string, Scene>>()

export function sceneMapOf(scenes: readonly Scene[]): Map<string, Scene> {
  let m = maps.get(scenes)
  if (!m) {
    m = new Map(scenes.map((s) => [s.id, s]))
    maps.set(scenes, m)
  }
  return m
}
