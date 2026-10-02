// Sound of the in-app video players (canvas hover preview, take viewer, storyboard "Phát liền"): one switch,
// remembered on this device. Browsers may refuse to start a video WITH sound before the user has interacted with the
// page (autoplay policy); playWithSound() then falls back to muted playback so the picture still shows.
import { create } from 'zustand'

const KEY = 'bdp:pref:videoSound'

function readSound(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'false'
  } catch {
    return true
  }
}

interface PlaybackState {
  /** Play previews with sound (default on). */
  sound: boolean
  setSound: (sound: boolean) => void
}

export const usePlayback = create<PlaybackState>()((set) => ({
  sound: readSound(),
  setSound: (sound) => {
    try {
      localStorage.setItem(KEY, String(sound))
    } catch {
      /* storage unavailable: the choice lasts for this session */
    }
    set({ sound })
  },
}))

/**
 * Start `video` with sound when `sound` is on. When the browser blocks unmuted autoplay (NotAllowedError: no user
 * gesture yet), it plays muted instead. Resolves whether the video is left unmuted (= audible once it plays).
 */
export async function playWithSound(video: HTMLVideoElement, sound: boolean): Promise<boolean> {
  video.muted = !sound
  try {
    await video.play()
  } catch (e) {
    // AbortError etc. (paused / new source / hidden page saving power): nothing to fix, it keeps its sound setting.
    if (sound && (e as DOMException)?.name === 'NotAllowedError') {
      video.muted = true
      try {
        await video.play()
      } catch {
        /* still refused: the poster stays visible */
      }
    }
  }
  return !video.muted
}
