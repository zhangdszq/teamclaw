const arch = process.env.BUILD_ARCH; // 'arm64' | 'x64'
const updateUrl = (process.env.ALIYUN_OSS_UPDATE_URL || "").replace(/\/+$/, "");
/** When no Aliyun generic URL, publish to GitHub Releases (CI sets GITHUB_TOKEN). */
const publish = updateUrl
  ? [{ provider: "generic", url: updateUrl }]
  : [{ provider: "github", owner: "zhangdszq", repo: "teamclaw" }];
const enableNotarize = Boolean(
  process.env.APPLE_ID &&
  process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  process.env.APPLE_TEAM_ID
);

const macSidecar =
  arch === 'x64'
    ? { from: 'src-api/dist/agent-api-x86_64-apple-darwin', to: 'sidecar/agent-api-x86_64-apple-darwin' }
    : { from: 'src-api/dist/agent-api-aarch64-apple-darwin', to: 'sidecar/agent-api-aarch64-apple-darwin' };

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.aiteam.app',
  productName: 'AI Team',
  publish,
  files: [
    'package.json',
    { from: 'dist-electron', to: 'dist-electron', filter: ['**/*'] },
    { from: 'dist-react', to: 'dist-react', filter: ['**/*'] },
  ],
  extraResources: [
    'dist-electron/electron/preload.cjs',
    'app-icon.png',
    'trayIconTemplate.png',
    { from: 'config', to: 'config' },
    { from: 'builtin-skills', to: 'builtin-skills', filter: ['**/*'] },
    'skills-catalog.json',
  ],
  asarUnpack: [
    'node_modules/@anthropic-ai/claude-agent-sdk/vendor/**/*',
  ],
  icon: './app-icon.png',
  mac: {
    target: ['dmg', 'zip'],
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: enableNotarize,
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
