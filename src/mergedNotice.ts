// D236: the last SanoVids release says, once per launch, that SanoVids now lives on as Sano Agent's Canvas, with
// "Tải Sano Agent" (Sano Agent's download page in the default browser: window.open → main's window-open handler →
// shell.openExternal, like every external link) and "Để sau". Only the SanoVids desktop product on its own — never
// Sano Agent (its "Mở Canvas" too), SanoVids inside SANO, or the web app. A persistent toast: work goes on under it.
// Called once by src/main.tsx, outside React (StrictMode would run an effect twice).
import { EMBEDDED } from './lib/sanoBridge'
import { toast } from './store/ui'

/** = electron/updater-rules releasesUrl('Sano Agent'). */
export const SANO_AGENT_RELEASES_URL = 'https://github.com/JameSteven404/sano-agent-releases/releases/latest'
export const MERGED_NOTICE_TEXT = 'SanoVids đã gộp vào Sano Agent. Dự án vẫn còn nguyên: Sano Agent mở cùng thư mục dữ liệu.'

/** `product` = window.bdpDesktop.product (main's app.getName(); missing on the web): every product but Sano Agent is SanoVids. */
export function showsMergedNotice(product: unknown, embedded: boolean): boolean {
  return typeof product === 'string' && product !== '' && product !== 'Sano Agent' && !embedded
}

/** Shows the notice when this run is SanoVids on its own; true when it did. */
export function showMergedNoticeOnLaunch(
  product: unknown = typeof window !== 'undefined' ? window.bdpDesktop?.product : undefined,
  embedded: boolean = EMBEDDED,
  open: (url: string) => void = (url) => void window.open(url, '_blank', 'noopener'),
): boolean {
  if (!showsMergedNotice(product, embedded)) return false
  toast(MERGED_NOTICE_TEXT, {
    tone: 'info',
    persistent: true,
    closeLabel: 'Để sau',
    action: { label: 'Tải Sano Agent', run: () => open(SANO_AGENT_RELEASES_URL) },
  })
  return true
}
