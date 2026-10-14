import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SERVICES, type ServiceId } from '../../../core/services'
import { ProviderTag } from '../ProviderTag'

describe('provider tags', () => {
  it.each(['canvasapp', 'seedvis'] as const)('%s always has text and its own decorative icon', service => {
    for (const size of ['mini', 'full'] as const) {
      const html = renderToStaticMarkup(createElement(ProviderTag, { service, size }))
      expect(html).toContain(`title="${service}"`)
      expect(html).toContain(`aria-label="${service}"`)
      expect(html).toContain(`>${size === 'mini' ? SERVICES[service].short : service}</span>`)
      expect(html).toContain(`lucide-${SERVICES[service].icon.toLowerCase()}`)
      expect(html).toContain('aria-hidden="true"')
    }
  })
  it('marks simulation in full and mini tags, with a dashed border', () => {
    for (const service of Object.keys(SERVICES) as ServiceId[]) {
      const html = renderToStaticMarkup(createElement(ProviderTag, { service, size: 'mini', simulated: true }))
      expect(html).toContain(`${service} · DEV (giả lập)`)
      expect(html).toContain(`${SERVICES[service].short} · DEV`)
      expect(html).toContain('is-simulated')
    }
    const css = readFileSync(new URL('../providerTag.css', import.meta.url), 'utf8')
    expect(css).toContain('border-style: dashed')
  })
  it('uses only theme tokens for all three components', () => {
    const css = ['../providerTag.css', '../../inspector/modelPicker.css', '../../dialogs/seedvisSection.css']
      .map(path => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i)
    for (const spec of Object.values(SERVICES)) {
      expect(css).toContain(`var(${spec.token})`)
      expect(css).toContain(`var(${spec.softToken})`)
    }
  })
})
