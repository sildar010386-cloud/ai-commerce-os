# Weekly backup of all owner repositories to this computer (Windows PowerShell 5+ / PowerShell 7).
# Keeps a full mirror (all branches + history) and a readable copy of the working branch for every repo.
# Never deletes anything: no --prune, gc never expires objects. Log: <Dest>\backup_log.txt
$ErrorActionPreference = 'Continue'
$Owner = 'sildar010386-cloud'
$Repos = @(
  @{ name = 'ai-commerce-os';  branch = 'claude/practical-mendel-vjtsd5' },
  @{ name = 'bikas-target';    branch = 'main' },
  @{ name = 'bikas-legal';     branch = 'main' },
  @{ name = 'finance-ipoteka'; branch = 'main' },
  @{ name = 'bikas-music';     branch = '' }
)
$Dest = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'AI_Backup'
$Mirrors = Join-Path $Dest 'mirrors'
$Readable = Join-Path $Dest 'readable'
New-Item -ItemType Directory -Force -Path $Mirrors, $Readable | Out-Null
$Log = Join-Path $Dest 'backup_log.txt'
function Say($t) { $line = "{0:yyyy-MM-dd HH:mm}  {1}" -f (Get-Date), $t; Write-Host $line; Add-Content -Path $Log -Value $line -Encoding UTF8 }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Say 'ОШИБКА: не установлен Git. Установите Git for Windows: https://git-scm.com/download/win и запустите снова.'
  exit 1
}

$ok = 0; $fail = 0
foreach ($r in $Repos) {
  $url = "https://github.com/$Owner/$($r.name).git"
  $m = Join-Path $Mirrors ($r.name + '.git')
  try {
    if (-not (Test-Path $m)) {
      Say "Первая копия $($r.name) (может занять время)..."
      git clone --mirror $url $m 2>&1 | Out-Null
      git -C $m config gc.pruneExpire never
      git -C $m config gc.reflogExpire never
    } else {
      git -C $m remote update 2>&1 | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw "git вернул код $LASTEXITCODE" }
    $w = Join-Path $Readable $r.name
    if (-not (Test-Path $w)) { git clone $m $w 2>&1 | Out-Null }
    git -C $w fetch origin 2>&1 | Out-Null
    $b = $r.branch
    if (-not $b) { $b = (git -C $m symbolic-ref --short HEAD) }
    git -C $w checkout -q -B $b "origin/$b" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "не удалось открыть ветку $b" }
    $size = '{0:N0}' -f ((Get-ChildItem $m -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
    Say "OK  $($r.name)  (ветка $b, копия $size МБ)"
    $ok++
  } catch {
    Say "ОШИБКА  $($r.name): $_"
    $fail++
  }
}
Say "Готово: успешно $ok, ошибок $fail. Папка: $Dest"
if ($fail -gt 0) { exit 2 }
