const arch = process.env.BUILD_ARCH; // 'arm64' | 'x64'

const macSidecar =
  arch === 'x64'
    ? { from: 'src-api/dist/agent-api-x86_64-apple-darwin', to: 'sidecar/agent-api-x86_64-apple-darwin' }
    : { from: 'src-api/dist/agent-api-aarch64-apple-darwin', to: 'sidecar/agent-api-aarch64-apple-darwin' };

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.aiteam.app',
  productName: 'AI Team',
  files: ['dist-electron', 'dist-react'],
  extraResources: [
    'dist-electron/preload.cjs',
    'app-icon.png',
    'trayIconTemplate.png',
    { from: 'config', to: 'config' },
  ],
  asarUnpack: [
    'node_modules/@openai/codex-sdk/vendor/**/*',
    'node_modules/@anthropic-ai/claude-agent-sdk/vendor/**/*',
  ],
  icon: './app-icon.png',
  mac: {
    target: 'dmg',
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: false,
    extraResources: [
      macSidecar,
      { from: 'cli-bundle', to: 'cli-bundle', filter: ['**/*', '!.git'] },
    ],
  },
  linux: {
    target: 'AppImage',
    category: 'Utility',
    extraResources: [
      { from: 'src-api/dist/agent-api-x86_64-unknown-linux-gnu', to: 'sidecar/agent-api-x86_64-unknown-linux-gnu' },
      { from: 'cli-bundle', to: 'cli-bundle', filter: ['**/*', '!.git'] },
    ],
  },
  win: {
    target: ['nsis', 'portable'],
    extraResources: [
      { from: 'src-api/dist/agent-api-x86_64-pc-windows-msvc.exe', to: 'sidecar/agent-api-x86_64-pc-windows-msvc.exe' },
      { from: 'cli-bundle', to: 'cli-bundle', filter: ['**/*', '!.git'] },
    ],
  },
  afterPack: './scripts/afterPack.cjs',
};
