import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { TerminalKind } from './terminal'

export interface CliLaunch {
  kind: 'codex' | 'claude'
  cwd: string
  args: string[]
  home?: string
  sessionId?: string
  running: boolean
  runId?: string
}

/** 셸에서 직접 실행한 CLI도 실행 인자와 세션 식별 정보만 남긴다. */
const bridge = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const file = process.env.ORBIT_TERMINAL_STATE;
const generation = process.env.ORBIT_TERMINAL_GENERATION;
function read() {
  try { const state = JSON.parse(fs.readFileSync(file, 'utf8')); return state.generation === generation && !state.frozen ? state : null; }
  catch { return null; }
}
function save(state) {
  const pending = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(pending, JSON.stringify(state));
  fs.renameSync(pending, file);
}
const action = process.argv[2];
if (action === 'start') {
  if (!read()) process.exit(0);
  const kind = process.argv[3];
  const args = process.argv.slice(4);
  const index = args.findIndex(arg => kind === 'codex' ? arg === 'resume' : ['--resume', '-r', '--session-id'].includes(arg));
  const candidate = args[index + 1];
  const sessionId = index >= 0 && /^[a-f0-9-]{36}$/i.test(candidate || '') ? candidate : undefined;
  save({ generation, kind, cwd: process.cwd(), args, sessionId, runId: require('node:crypto').randomUUID(), home: process.env[kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'], running: true });
} else if (action === 'stop') {
  const state = read();
  if (state) save({ ...state, running: false });
} else if (action === 'hook') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { if (input.length < 65536) input += chunk; });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(input);
      const state = read();
      if (state?.kind === 'claude' && state.running && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(event.session_id)) {
        save({ ...state, sessionId: event.session_id, cwd: typeof event.cwd === 'string' ? event.cwd : state.cwd });
      }
    } catch {}
  });
}
`

export function shellQuote(value: string, platform = process.platform): string {
  return platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
}

const powershellInit = String.raw`
function global:Invoke-OrbitBridge {
  param([string]$Action)
  $orbitPrevious = $env:ELECTRON_RUN_AS_NODE
  try { $env:ELECTRON_RUN_AS_NODE = '1'; & $env:ORBIT_NODE $env:ORBIT_BRIDGE $Action @args }
  finally { $env:ELECTRON_RUN_AS_NODE = $orbitPrevious }
}
$global:OrbitCodexCommand = Get-Command codex -ErrorAction SilentlyContinue
if ($global:OrbitCodexCommand) {
  function global:codex {
    if ($args -match '^(exec|e|review|login|logout|mcp|mcp-server|app-server|completion|sandbox|debug|apply|a|cloud|features|--help|-h|--version|-V)$') { & $global:OrbitCodexCommand @args; return }
    Invoke-OrbitBridge start codex @args
    $orbitExtra = @('-c', "tui.terminal_title=['session-id']")
    if ($args -notcontains '--no-daemon') { $orbitExtra += '--no-daemon' }
    try { & $global:OrbitCodexCommand @args @orbitExtra }
    finally { $orbitCode = $LASTEXITCODE; Invoke-OrbitBridge stop; $global:LASTEXITCODE = $orbitCode }
  }
}
$global:OrbitClaudeCommand = Get-Command claude -ErrorAction SilentlyContinue
if ($global:OrbitClaudeCommand) {
  function global:claude {
    if ($args -match '^(--print|-p|--help|-h|--version|-v|mcp|auth|doctor|update|install|plugin|plugins|setup-token)$') { & $global:OrbitClaudeCommand @args; return }
    Invoke-OrbitBridge start claude @args
    $orbitExtra = @()
    if ($args -notcontains $env:ORBIT_CLAUDE_SETTINGS) { $orbitExtra = @('--settings', $env:ORBIT_CLAUDE_SETTINGS) }
    try { & $global:OrbitClaudeCommand @args @orbitExtra }
    finally { $orbitCode = $LASTEXITCODE; Invoke-OrbitBridge stop; $global:LASTEXITCODE = $orbitCode }
  }
}
`

const posixInit = String.raw`
orbit_bridge() { ELECTRON_RUN_AS_NODE=1 "$ORBIT_NODE" "$ORBIT_BRIDGE" "$@"; }
codex() {
  case " $* " in
    *' exec '*|*' e '*|*' review '*|*' login '*|*' logout '*|*' mcp '*|*' mcp-server '*|*' app-server '*|*' completion '*|*' sandbox '*|*' debug '*|*' apply '*|*' cloud '*|*' features '*|*' --help '*|*' -h '*|*' --version '*|*' -V '*) command codex "$@"; return $?;;
  esac
  orbit_bridge start codex "$@"
  case " $* " in
    *' --no-daemon '*) command codex "$@" -c "tui.terminal_title=['session-id']";;
    *) command codex "$@" --no-daemon -c "tui.terminal_title=['session-id']";;
  esac
  local orbit_code=$?
  orbit_bridge stop
  return $orbit_code
}
claude() {
  case " $* " in
    *' --print '*|*' -p '*|*' --help '*|*' -h '*|*' --version '*|*' -v '*|*' mcp '*|*' auth '*|*' doctor '*|*' update '*|*' install '*|*' plugin '*|*' plugins '*|*' setup-token '*) command claude "$@"; return $?;;
  esac
  orbit_bridge start claude "$@"
  case " $* " in
    *" $ORBIT_CLAUDE_SETTINGS "*) command claude "$@";;
    *) command claude "$@" --settings "$ORBIT_CLAUDE_SETTINGS";;
  esac
  local orbit_code=$?
  orbit_bridge stop
  return $orbit_code
}
`

const fishInit = String.raw`
function orbit_bridge
  env ELECTRON_RUN_AS_NODE=1 "$ORBIT_NODE" "$ORBIT_BRIDGE" $argv
end
function codex
  if contains -- $argv[1] exec e review login logout mcp mcp-server app-server completion sandbox debug apply a cloud features; or contains -- --help $argv; or contains -- --version $argv
    command codex $argv
    return $status
  end
  orbit_bridge start codex $argv
  if contains -- --no-daemon $argv
    command codex $argv -c "tui.terminal_title=['session-id']"
  else
    command codex $argv --no-daemon -c "tui.terminal_title=['session-id']"
  end
  set -l orbit_code $status
  orbit_bridge stop
  return $orbit_code
end
function claude
  if contains -- $argv[1] mcp auth doctor update install plugin plugins setup-token; or contains -- --print $argv; or contains -- -p $argv; or contains -- --help $argv; or contains -- --version $argv
    command claude $argv
    return $status
  end
  orbit_bridge start claude $argv
  if contains -- "$ORBIT_CLAUDE_SETTINGS" $argv
    command claude $argv
  else
    command claude $argv --settings "$ORBIT_CLAUDE_SETTINGS"
  end
  set -l orbit_code $status
  orbit_bridge stop
  return $orbit_code
end
`

/** 앱이 만든 셸에만 적용한다. 사용자의 CLI 전역 설정·셸 프로필은 수정하지 않는다. */
export function prepareTerminalIntegration(dir: string, kind: TerminalKind, cwd: string): { init: string; env: Record<string, string>; claudeSettings: string } {
  mkdirSync(dir, { recursive: true })
  const helper = path.join(dir, 'bridge.cjs')
  const state = path.join(dir, 'state.json')
  const settings = path.join(dir, 'claude-settings.json')
  const init = path.join(dir, process.platform === 'win32' ? 'init.ps1' : 'init.sh')
  const generation = randomUUID()
  writeFileSync(helper, bridge)
  writeFileSync(init, process.platform === 'win32' ? powershellInit : path.basename(process.env.SHELL ?? '') === 'fish' ? fishInit : posixInit)
  writeFileSync(state, JSON.stringify({ generation, runId: generation, kind, cwd, args: [], running: kind !== 'shell' }))
  const hook = process.platform === 'win32'
    ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`$env:ELECTRON_RUN_AS_NODE='1'; [Console]::In.ReadToEnd() | & ${shellQuote(process.execPath)} ${shellQuote(helper)} hook`, 'utf16le').toString('base64')}`
    : `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(helper)} hook`
  writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook }] }] } }))
  return {
    init: `. ${shellQuote(init)}`,
    claudeSettings: settings,
    env: { ORBIT_NODE: process.execPath, ORBIT_BRIDGE: helper, ORBIT_TERMINAL_STATE: state, ORBIT_TERMINAL_GENERATION: generation, ORBIT_CLAUDE_SETTINGS: settings }
  }
}

export function freezeTerminalIntegration(dir: string): void {
  const file = path.join(dir, 'state.json')
  if (!existsSync(file)) return
  const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...state, frozen: true }))
}

export function readCliLaunch(dir: string): CliLaunch | undefined {
  const file = path.join(dir, 'state.json')
  if (!existsSync(file) || statSync(file).size > 65536) return
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as Partial<CliLaunch>
    if (!['codex', 'claude'].includes(state.kind ?? '') || typeof state.cwd !== 'string' || !path.isAbsolute(state.cwd) || typeof state.running !== 'boolean') return
    if (!Array.isArray(state.args) || !state.args.every((arg) => typeof arg === 'string')) return
    if (state.home !== undefined && typeof state.home !== 'string') return
    if (state.sessionId !== undefined && typeof state.sessionId !== 'string') return
    if (state.sessionId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(state.sessionId)) return
    return state as CliLaunch
  } catch (e) {
    if (!(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/** 재개할 때 최초 프롬프트·이전 resume 대상은 다시 보내지 않고 실행 옵션만 보존한다. */
export function resumeOptions(args: string[], command = ''): string[] {
  const booleans = new Set(['--yolo', '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--no-alt-screen', '--oss', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose'])
  const valued = new Set(['--model', '-m', '--profile', '-p', '--sandbox', '-s', '--ask-for-approval', '-a', '--add-dir', '--local-provider', '--permission-mode', '--effort'])
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    const [name] = args[i].split('=')
    if (!booleans.has(name) && !valued.has(name)) continue
    if (new RegExp(`(?:^|\\s|['"])${name}(?:[=\\s'"]|$)`).test(command)) {
      if (valued.has(name) && !args[i].includes('=')) i++
      continue
    }
    if (booleans.has(name)) result.push(args[i])
    else if (valued.has(name)) {
      result.push(args[i])
      if (!args[i].includes('=') && i + 1 < args.length) result.push(args[++i])
    }
  }
  return result
}
