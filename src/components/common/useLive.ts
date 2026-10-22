// "Is this component still on screen?" for async work started from it (a scan, a login): its answer is dropped once
// the component is gone. Set in the effect BODY, not only cleared in its cleanup: React's StrictMode (npm run dev)
// mounts, unmounts and mounts again keeping the refs, so a ref cleared by that first cleanup must be set back.
import { useEffect, useRef, type RefObject } from 'react'

export function useLive(): RefObject<boolean> {
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  return live
}
