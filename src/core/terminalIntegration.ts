import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
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
function complete(event) {
  if (!read()) return;
  const dir = path.dirname(file);
  try {
    const capture = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8'));
    const output = event.last_assistant_message ?? event['last-assistant-message'];
    if (capture.generation === generation && typeof output === 'string' && output.length <= 4 * 1024 * 1024) {
      const target = path.join(dir, 'agent-output.json');
      const pending = target + '.' + process.pid + '.tmp';
      fs.writeFileSync(pending, JSON.stringify({ requestId: capture.requestId, output }));
      fs.renameSync(pending, target);
    }
  } catch {}
  fs.appendFileSync(path.join(dir, 'agent.done'), 'done\n');
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
} else if (action === 'hook' || action === 'done' || action === 'notify') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { if (input.length < 8 * 1024 * 1024) input += chunk; });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(input.replace(/^\uFEFF/, ''));
      if (action === 'done' || (action === 'notify' && event.type === 'agent-turn-complete')) { complete(event); return; }
      if (action !== 'hook') return;
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
    $orbitExtra = @('-c', "tui.terminal_title=['session-id','status']", '-c', $env:ORBIT_CODEX_NOTIFY)
    $orbitArgs = @($args)
    # Windows PowerShell은 네이티브 인자의 큰따옴표를 제거하므로 notify의 TOML 문자열을 보존한다.
    if ($PSVersionTable.PSVersion -lt [version]'7.3' -or $PSNativeCommandArgumentPassing -eq 'Legacy') {
      $orbitArgs = @($orbitArgs | ForEach-Object { if ([string]$_ -like 'notify=*') { ([string]$_).Replace('"', '"""') } else { $_ } })
      $orbitExtra[3] = $orbitExtra[3].Replace('"', '"""')
    }
    if ($args -notcontains '--no-daemon') { $orbitExtra += '--no-daemon' }
    try { & $global:OrbitCodexCommand @orbitArgs @orbitExtra }
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
$global:OrbitOriginalPrompt = (Get-Item Function:\prompt).ScriptBlock
$global:OrbitPromptSequence = 0
function global:prompt {
  $global:OrbitPromptSequence += 1
  [Console]::Write(([char]27).ToString() + ']0;orbit:shell:ready:' + $global:OrbitPromptSequence + [char]7)
  & $global:OrbitOriginalPrompt
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
    *' --no-daemon '*) command codex "$@" -c "tui.terminal_title=['session-id','status']" -c "$ORBIT_CODEX_NOTIFY";;
    *) command codex "$@" --no-daemon -c "tui.terminal_title=['session-id','status']" -c "$ORBIT_CODEX_NOTIFY";;
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
orbit_prompt_sequence=0
orbit_shell_ready() {
  local orbit_status=$?
  orbit_prompt_sequence=$((orbit_prompt_sequence + 1))
  printf '\033]0;orbit:shell:ready:%s\007' "$orbit_prompt_sequence"
  return "$orbit_status"
}
if [ -n "$ZSH_VERSION" ]; then
  precmd_functions+=(orbit_shell_ready)
elif [ -n "$BASH_VERSION" ]; then
  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    PROMPT_COMMAND=(orbit_shell_ready "${'${PROMPT_COMMAND[@]}'}")
  else
    PROMPT_COMMAND="orbit_shell_ready; $PROMPT_COMMAND"
  fi
fi
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
    command codex $argv -c "tui.terminal_title=['session-id','status']" -c "$ORBIT_CODEX_NOTIFY"
  else
    command codex $argv --no-daemon -c "tui.terminal_title=['session-id','status']" -c "$ORBIT_CODEX_NOTIFY"
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
set -g orbit_prompt_sequence 0
function orbit_shell_ready --on-event fish_prompt
  set -g orbit_prompt_sequence (math $orbit_prompt_sequence + 1)
  printf '\033]0;orbit:shell:ready:%s\007' "$orbit_prompt_sequence"
end
`

const slash = (p: string) => p.replace(/\\/g, '/')
const signalFile = (dir: string, signal: AgentSignal) => path.join(dir, `agent.${signal}`)

/** IN-F10: 입력 준비·작업 시작·응답 끝·중단 신호. */
export type AgentSignal = 'ready' | 'working' | 'done' | 'idle'
const AGENT_SIGNALS: AgentSignal[] = ['ready', 'working', 'done', 'idle']

/** 그래프가 요청한 한 응답만 수집한다. 일반 터미널 대화는 저장하지 않는다. */
export function beginOutputCapture(dir: string): void {
  const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as { generation: string }
  endOutputCapture(dir)
  rmSync(signalFile(dir, 'done'), { force: true })
  writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ generation: state.generation, requestId: randomUUID() }))
}
export function readAgentOutput(dir: string): string | undefined {
  try {
    const capture = JSON.parse(readFileSync(path.join(dir, 'capture.json'), 'utf8')) as { requestId: string }
    const file = path.join(dir, 'agent-output.json')
    if (statSync(file).size > 32 * 1024 * 1024) return undefined
    const result = JSON.parse(readFileSync(file, 'utf8')) as { requestId: string; output?: unknown }
    return result.requestId === capture.requestId && typeof result.output === 'string' ? result.output : undefined
  } catch { return undefined }
}
export function endOutputCapture(dir: string): void {
  for (const name of ['capture.json', 'agent-output.json']) rmSync(path.join(dir, name), { force: true })
}

/** 신호 파일이 있으면 지우고 true를 돌려준다. */
export function takeAgentSignal(dir: string, signal: AgentSignal): boolean {
  const file = signalFile(dir, signal)
  try {
    if (!existsSync(file) || statSync(file).size === 0) return false
    rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

/** 한 번의 확인 사이에 끝난 작업과 다음 작업의 시작이 겹치면 발생 순서대로 처리한다. */
export function takeAgentSignals(dir: string): AgentSignal[] {
  return AGENT_SIGNALS.flatMap((signal) => {
    try { return [{ signal, at: statSync(signalFile(dir, signal)).mtimeMs }] }
    catch { return [] }
  }).sort((a, b) => a.at - b.at).filter(({ signal }) => takeAgentSignal(dir, signal)).map(({ signal }) => signal)
}

/** 앱이 만든 셸에만 적용한다. 사용자의 CLI 전역 설정·셸 프로필은 수정하지 않는다. */
export function prepareTerminalIntegration(dir: string, kind: TerminalKind, cwd: string, platform = process.platform): { init: string; env: Record<string, string>; claudeSettings: string; codexNotify: string } {
  mkdirSync(dir, { recursive: true })
  const helper = path.join(dir, 'bridge.cjs')
  const state = path.join(dir, 'state.json')
  const settings = path.join(dir, 'claude-settings.json')
  const init = path.join(dir, platform === 'win32' ? 'init.ps1' : 'init.sh')
  const generation = randomUUID()
  writeFileSync(helper, bridge)
  writeFileSync(init, platform === 'win32' ? powershellInit : path.basename(process.env.SHELL ?? '') === 'fish' ? fishInit : posixInit)
  writeFileSync(state, JSON.stringify({ generation, runId: generation, kind, cwd, args: [], running: kind !== 'shell' }))
  const hookCommand = (action: string) => platform === 'win32'
    ? `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(`$env:ELECTRON_RUN_AS_NODE='1'; $OutputEncoding=[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::In.ReadToEnd() | & ${shellQuote(process.execPath)} ${shellQuote(helper)} ${action}`, 'utf16le').toString('base64')}`
    : `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(helper)} ${action}`
  // 지난 실행에서 남은 신호는 지운다
  for (const s of AGENT_SIGNALS) rmSync(signalFile(dir, s), { force: true })
  endOutputCapture(dir)
  // echo ... >> "파일" 은 bash·cmd·PowerShell 어느 셸로 훅을 돌려도 동작한다
  const echo = (s: AgentSignal) => ({ type: 'command', command: `echo done >> "${slash(signalFile(dir, s))}"` })
  writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('hook') }, echo('ready')] }], UserPromptSubmit: [{ hooks: [echo('working')] }], Stop: [{ hooks: [{ type: 'command', command: hookCommand('done') }] }], StopFailure: [{ hooks: [echo('idle')] }] } }))
  // Codex는 notify를 셸 없이 바로 실행하므로 신호를 남기는 작은 스크립트를 만든다
  const win = platform === 'win32'
  const notify = path.join(dir, `notify.${win ? 'ps1' : 'sh'}`)
  writeFileSync(notify, win
    ? `param([string]$Notification)\n$env:ELECTRON_RUN_AS_NODE='1'\n$OutputEncoding=[System.Text.UTF8Encoding]::new($false)\n$Notification | & $env:ORBIT_NODE $env:ORBIT_BRIDGE notify\n`
    : `#!/bin/sh\nprintf '%s' "$1" | ELECTRON_RUN_AS_NODE=1 "$ORBIT_NODE" "$ORBIT_BRIDGE" notify\n`)
  if (!win) chmodSync(notify, 0o755)
  const codexNotify = `notify=${JSON.stringify(win ? ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', slash(notify)] : [slash(notify)])}`
  return {
    init: `. ${shellQuote(init)}`,
    claudeSettings: settings,
    codexNotify,
    env: { ORBIT_NODE: process.execPath, ORBIT_BRIDGE: helper, ORBIT_TERMINAL_STATE: state, ORBIT_TERMINAL_GENERATION: generation, ORBIT_CLAUDE_SETTINGS: settings, ORBIT_CODEX_NOTIFY: codexNotify }
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
