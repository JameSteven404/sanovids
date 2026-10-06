import { Profiler, type ReactNode } from 'react'
import { perfRender } from './probe'

export function PerfProfiler({ id, children }: { id: string; children: ReactNode }) {
  return <Profiler id={id} onRender={perfRender}>{children}</Profiler>
}
