---
name: local-update
description: Orbit에 만든 기능을 GitHub 릴리스 없이 이 PC에만 빌드·설치해 확인할 때 쓴다. "로컬 업데이트", "로컬에 설치", "로컬에서만 다운", "설치해" 등을 요청할 때 사용.
---

# Orbit 로컬 업데이트

새 기능을 GitHub Releases에 올리지 않고 이 PC의 Orbit에만 설치한다. 자동 업데이트(electron-updater)는 GitHub의 최신 릴리스보다 높은 버전을 덮어쓰지 않으므로, 로컬에서 버전을 올려 설치해도 GitHub 버전으로 되돌아가지 않는다.

## 순서

### 1. 버전 올리기
`package.json`과 `package-lock.json`(맨 위 `version` 두 군데)의 패치 버전을 1 올린다 (예: 0.3.8 → 0.3.9). 같은 버전으로 다시 설치하면 사용자가 바뀌었는지 알 수 없다.

### 2. 검사
```bash
npm run typecheck
npm test
```
실패하면 설치하지 않는다. 실패한 테스트와 출력을 그대로 알린다.

### 3. 설치 파일 만들기 (올리지 않음)
```bash
npm run dist
```
`dist`는 `--publish never`라 아무것도 올리지 않는다. **`npm run release`는 쓰지 않는다** (GitHub에 올라간다). 결과: `release/Orbit Setup <버전>.exe`.

### 4. 설치 전에 확인할 것
이 세션이 Orbit 안의 터미널에서 돌고 있으면, 설치하려고 Orbit을 끄는 순간 **이 세션도 같이 끊긴다**. 확인:
```powershell
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"; $inOrbit = $false
while ($p -and $p.ParentProcessId) { if ($p.Name -eq 'Orbit.exe') { $inOrbit = $true; break }; $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" }
$inOrbit
```
- `True`면 사용자에게 "설치하면 Orbit이 다시 시작되고 이 세션은 끊긴다"고 먼저 알리고, 사용자가 설치하라고 했을 때만 진행한다.
- 사용자가 이미 "설치해"라고 했으면 그대로 진행한다.

### 5. 설치 (Orbit과 분리된 프로세스로)
Orbit 안에서 직접 설치 프로그램을 돌리면 Orbit을 끌 때 같이 죽는다. WMI로 Orbit 프로세스 트리 밖에서 실행한다. 스크립트가 Orbit 종료 → 조용히 설치(`/S`) → Orbit 다시 실행 → 결과 기록까지 한다.
```powershell
$s = (Resolve-Path '.claude/skills/local-update/install.ps1').Path
$exe = (Resolve-Path 'release/Orbit Setup <버전>.exe').Path
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$s`" -Installer `"$exe`"" }
```
`ReturnValue`가 0이면 시작된 것이다. 세션이 끊기지 않았으면 15초쯤 뒤에 6단계로 확인한다.

### 6. 설치 확인
```powershell
Get-Content "$env:TEMP\orbit-local-update.log"
(Get-Item "$env:LOCALAPPDATA\Programs\orbit\Orbit.exe").VersionInfo.ProductVersion
```
- 로그에 `installer exit=0`이 있고 버전이 1단계에서 올린 버전이면 성공.
- `exit=2`는 Orbit이 덜 꺼진 상태에서 설치하려 한 것이다. 다시 실행한다.

## 주의
- 커밋·태그·push는 하지 않는다 (사용자가 따로 요청할 때만).
- 한글이 든 파일을 bash heredoc(`cat <<EOF`)이나 `python -` 표준 입력으로 쓰지 않는다. 이 환경에서는 한글이 깨진다 (`\x18` 바이트가 끼어든다). 파일은 Write·Edit 도구로 쓴다. 의심되면 `grep -lP '\x18|\xEF\xBF\xBD' <파일>`로 확인한다.
- 설치가 끝나면 사용자에게 바뀐 기능을 어디서 확인하는지 알려준다.
