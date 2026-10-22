// Cài đặt on a packaged Mac build, as rendered (server-side, no DOM; effects do not run): Giới thiệu says "thử nghiệm"
// after the version and "Bản cho Mac", and explains the ad-hoc signature in its own styled line; "Tự động tải bản cập
// nhật" says only that the Mac build reports new versions. None of it on Windows, nor on a Mac run from the sources.
// The platform is the simulated one (DevPanel → "Chữ ký số (Giới thiệu)") while the signature is simulated, else this
// device's (lib/platform).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appSignatureSource, type AppSignature } from '../../../lib/appSignature'
import type { Platform } from '../../../lib/platform'
import { MAC_AD_HOC_NOTE, MAC_EXPERIMENTAL } from '../../../lib/platformText'
import type { UpdateKind } from '../../../lib/updateTypes'
import { autoDownloadNote } from '../../../lib/updateModel'
import { AboutBlock, UpdateAutoDownloadSetting } from '../SettingsBasic'

// Server rendering reads a zustand store's INITIAL state (getServerSnapshot), so the three stores these rows read are
// handed the state of each test instead (the stores themselves stay real for everything else).
const live = vi.hoisted(() => ({
  sig: null as AppSignature | null,
  simPlatform: null as Platform | null,
  updateKind: null as UpdateKind | null,
  hook<S>(real: object, read: () => S) {
    return Object.assign(<T>(select: (s: S) => T) => select(read()), real)
  },
}))
vi.mock('../../../lib/appSignature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/appSignature')>()
  return { ...actual, useAppSignature: live.hook(actual.useAppSignature, () => ({ sig: live.sig })) }
})
vi.mock('../../../providers/dev/appSignature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../providers/dev/appSignature')>()
  return { ...actual, useDevSignaturePlatform: live.hook(actual.useDevSignaturePlatform, () => ({ platform: live.simPlatform })) }
})
vi.mock('../../../lib/updates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/updates')>()
  const read = () => {
    const s = actual.useUpdates.getState()
    return live.updateKind ? { ...s, state: { ...s.state, kind: live.updateKind } } : s
  }
  return { ...actual, useUpdates: live.hook(actual.useUpdates, read) }
})

afterEach(() => {
  live.sig = null
  live.simPlatform = null
  live.updateKind = null
})

/** The About block for this signature, rendered for `platform` (the simulated platform: the test runs outside Electron). */
function about(sig: AppSignature, platform: Platform): string {
  live.sig = sig
  live.simPlatform = platform
  // React separates adjacent text children with <!-- -->: drop it to read the line as the user does.
  return renderToStaticMarkup(createElement(AboutBlock)).replace(/<!-- -->/g, '')
}

const versionOf = (html: string) => html.match(/<small>(Phiên bản [^<]*)<\/small>/)?.[1] ?? ''

describe('Giới thiệu on a Mac', () => {
  it('the test runs with a simulated signature (so the simulated platform decides)', () => {
    expect(appSignatureSource()).toBe('sim')
  })

  it('a packaged Mac build: "Bản cho Mac · thử nghiệm" and the ad-hoc note in its own class', () => {
    const html = about({ status: 'unsigned', packaged: true }, 'mac')
    expect(versionOf(html)).toMatch(new RegExp(`^Phiên bản \\S+ · Bản cho Mac · ${MAC_EXPERIMENTAL}$`))
    expect(html).toContain(`<p class="dg-about-note">${MAC_AD_HOC_NOTE}</p>`)
    // no Windows thumbprint rows on a Mac
    expect(html).not.toContain('dg-about-thumb')
  })

  it('a Mac run from the sources and every Windows build: no "thử nghiệm", no ad-hoc note', () => {
    const cases: [AppSignature, Platform][] = [
      [{ status: 'unsigned', packaged: false }, 'mac'],
      [{ status: 'unsigned', packaged: true }, 'win'],
      [{ status: 'signed', packaged: true, signer: 'Nguyễn Giang Minh (Jame Steven)', thumbprint: '7489ABFAC1A7CD23D5FFB0785CA7CAB414AE49ED' }, 'win'],
    ]
    for (const [sig, platform] of cases) {
      const html = about(sig, platform)
      const label = `${platform} ${JSON.stringify(sig)}`
      expect(versionOf(html), label).toMatch(/^Phiên bản \S+ · /)
      expect(versionOf(html), label).not.toContain(MAC_EXPERIMENTAL)
      expect(versionOf(html), label).not.toContain('Bản cho Mac')
      expect(html, label).not.toContain('dg-about-note')
      expect(html, label).not.toContain(MAC_AD_HOC_NOTE)
    }
  })
})

describe('"Tự động tải bản cập nhật" on a Mac (check-only updates)', () => {
  it('shows only the Mac note, switched off and disabled', () => {
    live.updateKind = 'mac-manual'
    const hint = 'Bản mới được tải ngầm khi có mạng và tự cài khi bạn tắt SanoVids.'
    const html = renderToStaticMarkup(createElement(UpdateAutoDownloadSetting, { label: 'Tự động tải bản cập nhật', hint })).replace(/<!-- -->/g, '')
    expect(html).toContain(autoDownloadNote('mac-manual')!)
    expect(html).not.toContain(hint)
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('checked=""')
  })

  it('portable keeps the row hint followed by its note', () => {
    live.updateKind = 'portable'
    const hint = 'Bản mới được tải ngầm khi có mạng và tự cài khi bạn tắt SanoVids.'
    const html = renderToStaticMarkup(createElement(UpdateAutoDownloadSetting, { label: 'Tự động tải bản cập nhật', hint })).replace(/<!-- -->/g, '')
    expect(html).toContain(`${hint} ${autoDownloadNote('portable')}`)
  })
})
