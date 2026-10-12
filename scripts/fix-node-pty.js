// node-pty 1.1.0의 macOS 미리 빌드된 spawn-helper가 실행 권한 없이 배포된다.
// 그대로 두면 macOS에서 터미널을 열 때 "posix_spawnp failed"로 실패하므로, 설치 후 권한을 준다.
const fs = require('fs')
const path = require('path')

for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const file = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds', arch, 'spawn-helper')
  try {
    fs.chmodSync(file, 0o755)
  } catch {
    // 없는 플랫폼은 건너뛴다
  }
}
