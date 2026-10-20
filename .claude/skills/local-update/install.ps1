# Orbit을 끄고 설치 파일을 조용히 설치한 뒤 다시 실행한다. Orbit 프로세스 트리 밖에서 실행해야 한다 (SKILL.md 5단계).
param([Parameter(Mandatory = $true)][string]$Installer)

$log = Join-Path $env:TEMP 'orbit-local-update.log'
"start $(Get-Date -Format o) $Installer" | Out-File $log -Encoding utf8
# 이 명령을 낸 세션이 응답을 마칠 시간을 준다
Start-Sleep -Seconds 3
Get-Process Orbit -ErrorAction SilentlyContinue | Stop-Process -Force
for ($i = 0; $i -lt 30 -and (Get-Process Orbit -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 2
$p = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru -Wait
"installer exit=$($p.ExitCode)" | Out-File $log -Append -Encoding utf8
$exe = Join-Path $env:LOCALAPPDATA 'Programs\orbit\Orbit.exe'
"version=$((Get-Item $exe).VersionInfo.ProductVersion)" | Out-File $log -Append -Encoding utf8
Start-Process $exe
"done $(Get-Date -Format o)" | Out-File $log -Append -Encoding utf8
