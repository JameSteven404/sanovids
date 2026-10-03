/**
 * The SanoVids mark (the S-wire: a canvas wire from a source dot to the output disc), one colour: it paints with
 * `currentColor`. Same 24-unit grid as build/icon-source/icon-24.svg / logo-mark.svg, so inside the 24 px orange
 * `.tb-logo` tile it matches the taskbar icon pixel for pixel. The gap before the disc is a real gap, so the mark also
 * works without a tile (orange on the dark UI, ink on light).
 *
 * Decorative by default (aria-hidden): the brand name is always written next to it. Pass `title` to make it an image.
 */
export function Logo({ size = 24, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d="M14 4.5H12A4.5 3.3 0 0 0 9.22 10.39L14.78 13.61A4.5 3.3 0 0 1 12 19.5H6" fill="none" stroke="currentColor" strokeWidth={3} />
      <circle cx={18} cy={4.5} r={3} />
      <circle cx={6} cy={19.5} r={3} />
    </svg>
  )
}
