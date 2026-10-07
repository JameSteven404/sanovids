import v1 from './v1.json'
import v02 from './v0.2.0.json'
import v03 from './v0.3.0.json'
import v04 from './v0.4.2.json'
import v05 from './v0.5.0.json'

// Historical JSON deliberately has no current Project/Take cast at the migration boundary.
export const compatFixtures = [v1, v02, v03, v04, v05]
/** The v1 fixture with its own expectations (what the v1 compiler sent, the paragraphs it generated). */
export const v1Fixture = v1
/** Factory presets every old build created (defaultPresets of ae04bea … v0.5.0), with their historical names. */
export const HISTORICAL_FACTORY_PRESETS = { preset_draft: 'Nháp', preset_final: 'Final', preset_h3: 'H3 nháp' } as const
export const jsonCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
