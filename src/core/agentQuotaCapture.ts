import { existsSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import path from 'path'
import { createHash } from 'crypto'

export function accountHomeKey(home: string): string {
  let canonical = path.resolve(home)
  try { canonical = realpathSync(canonical) } catch { /* 새 계정은 첫 로그인 전에는 폴더가 없을 수 있다. */ }
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  return createHash('sha256').update(canonical).digest('hex')
}

/** CLI가 제공한 한도 수치만 저장하고 기존 사용자 상태 표시줄에는 원래 입력을 전달한다. */
export const quotaCaptureScript = String.raw`
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { exec } = require('node:child_process');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'quota-config.json'), 'utf8'));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 2000000) process.exit(0); });
process.stdin.on('end', () => {
  let windows = {};
  try {
    const data = JSON.parse(input), limits = data.rate_limits;
    if (limits && typeof limits === 'object') {
      for (const key of ['five_hour', 'seven_day', 'spend_limit']) {
        const row = limits[key];
        if (!row || typeof row.used_percentage !== 'number' || !Number.isFinite(row.used_percentage) || row.used_percentage < 0) continue;
        windows[key] = { used_percentage: row.used_percentage, ...(typeof row.resets_at === 'number' && Number.isFinite(row.resets_at) ? { resets_at: row.resets_at } : {}) };
      }
      let home = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
      try { home = fs.realpathSync(home); } catch {}
      if (process.platform === 'win32') home = home.toLowerCase();
      const file = path.join(config.quotaDir, crypto.createHash('sha256').update(home).digest('hex') + '.json');
      const temp = file + '.' + crypto.randomUUID() + '.tmp';
      fs.mkdirSync(config.quotaDir, { recursive: true });
      try { fs.writeFileSync(temp, JSON.stringify({ at: new Date().toISOString(), rate_limits: windows })); fs.renameSync(temp, file); }
      finally { try { fs.rmSync(temp, { force: true }); } catch {} }
    }
  } catch {}
  if (config.command) {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = exec(config.command, { shell: config.shell, env, timeout: 5000, maxBuffer: 256000, windowsHide: true }, (error, stdout) => { if (stdout) process.stdout.write(stdout); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  } else {
    const labels = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' };
    const text = Object.entries(windows).map(([key, value]) => labels[key] + ': ' + Math.round(value.used_percentage) + '%').join(' · ');
    process.stdout.write(text ? 'Claude · ' + text : 'Claude');
  }
});
`

export function prepareQuotaCapture(dir: string, cwd: string, home: string, quotaDir: string, command: string): Record<string, unknown> {
  let previous: Record<string, unknown> = {}
  for (const file of [path.join(home, 'settings.json'), path.join(cwd, '.claude/settings.json'), path.join(cwd, '.claude/settings.local.json')]) {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8')).statusLine
      if (value && typeof value === 'object' && !Array.isArray(value)) previous = value as Record<string, unknown>
    } catch { /* 설정이 없으면 Orbit의 간단한 상태 표시줄을 사용한다. */ }
  }
  const bash = [process.env.CLAUDE_CODE_GIT_BASH_PATH, path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs/Git/bin/bash.exe')].find((file) => file && existsSync(file))
  writeFileSync(path.join(dir, 'quota-status.cjs'), quotaCaptureScript)
  writeFileSync(path.join(dir, 'quota-config.json'), JSON.stringify({ quotaDir, command: typeof previous.command === 'string' ? previous.command : undefined, shell: process.platform === 'win32' ? bash ?? 'powershell.exe' : process.env.SHELL || '/bin/sh' }))
  return { ...previous, type: 'command', command }
}
