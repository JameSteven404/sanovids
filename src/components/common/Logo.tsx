import { useId } from 'react'

/** Option D: rounded play mark with an S-shaped cutout. Decorative unless given a title. */
export function Logo({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  const cut = useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="currentColor"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <mask id={cut}>
          <rect width="512" height="512" fill="white" />
          <path d="M370 181H228C173 181 173 251 228 251H269C325 251 325 323 269 323H93" fill="none" stroke="black" strokeWidth="30" strokeLinecap="round" />
        </mask>
      </defs>
      <path d="M119 107Q119 62 165 86L423 226Q469 252 423 281L165 427Q119 454 119 400Z" mask={`url(#${cut})`} />
      <circle cx="94" cy="323" r="25" />
    </svg>
  )
}
