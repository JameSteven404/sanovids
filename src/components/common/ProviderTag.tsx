import { memo } from 'react'
import { Cloud, Sprout } from 'lucide-react'
import { SERVICES, type ServiceId } from '../../core/services'
import './providerTag.css'

export interface ProviderTagProps {
  service: ServiceId
  simulated?: boolean
  size?: 'mini' | 'full'
}

const ICONS = { Cloud, Sprout }

export const ProviderTag = memo(function ProviderTag({ service, simulated = false, size = 'full' }: ProviderTagProps) {
  const spec = SERVICES[service]
  const Icon = ICONS[spec.icon]
  const title = `${spec.label}${simulated ? ' · DEV (giả lập)' : ''}`
  return (
    <span className={`provider-tag provider-tag-${service}${simulated ? ' is-simulated' : ''}`} data-size={size} title={title} aria-label={title}>
      <Icon size={12} aria-hidden="true" />
      <span>{size === 'mini' ? spec.short : spec.label}{simulated && ' · DEV'}</span>
    </span>
  )
})
