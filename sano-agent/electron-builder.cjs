// Sano Agent (D220/D223): the SANO desktop app — SanoVids' own build config (package.json build) with its own identity,
// signed and checked exactly like SanoVids. npm run dist:sano-agent passes it as --config, so electron-builder reads
// only this file. Spreads, not -c.x=y overrides: those would union the arrays (win.target, files, signExts) with the
// originals. appId, productName and name are permanent once released (NSIS GUID, install entry, update feed and cache).
// docs/SANO-DESKTOP.md "Phát hành Sano Agent". One version for both apps (D235): package.json's.
const { build, version } = require('../package.json')

const { mac: _mac, dmg: _dmg, ...base } = build // Windows only
const ART = 'sano-agent/brand/build'
const NAME = 'Sano Agent'

module.exports = {
  ...base,
  appId: 'com.sanoagent.app',
  productName: NAME,
  // = productName: NSIS names the uninstaller after it, and the updater (updater-rules detectKind) looks for
  // `Uninstall ${app.getName()}.exe` to know it runs from an install.
  executableName: NAME,
  directories: { ...base.directories, output: 'release/sano-agent' },
  extraMetadata: {
    ...base.extraMetadata,
    name: 'sano-agent',
    productName: NAME,
    version,
    description: 'Sano Agent — app SANO trên máy tính, khu Canvas là SanoVids',
    homepage: 'https://github.com/JameSteven404/sano-agent-releases',
    // The SANO web app the window opens (electron/hardening-rules sanoShell): inside the integrity-checked app.asar.
    sanoAgent: { url: 'http://127.0.0.1:8080/' },
  },
  icon: `${ART}/icon.png`,
  win: { ...base.win, icon: `${ART}/icon.ico` },
  nsis: {
    ...base.nsis,
    shortcutName: NAME,
    uninstallDisplayName: NAME,
    artifactName: 'SanoAgent-Setup-${version}.${ext}',
    installerIcon: `${ART}/icon.ico`,
    installerSidebar: `${ART}/installerSidebar.bmp`,
    uninstallerSidebar: `${ART}/uninstallerSidebar.bmp`,
    installerHeader: `${ART}/installerHeader.bmp`,
  },
  portable: { artifactName: 'SanoAgent-Portable-${version}.${ext}' },
  publish: [{ provider: 'github', owner: 'JameSteven404', repo: 'sano-agent-releases', releaseType: 'release' }],
}
