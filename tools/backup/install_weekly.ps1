# Registers a weekly Windows task (Sunday 13:00; if the computer was off, runs at the next start) and runs the first backup now.
$Script = Join-Path $PSScriptRoot 'backup.ps1'
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Script`""
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 13:00
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName 'AI_Backup_weekly' -Action $Action -Trigger $Trigger -Settings $Settings -Description 'Копия всех репозиториев на этот компьютер (Claude, Арман)' -Force | Out-Null
Write-Host 'Еженедельная копия включена: каждое воскресенье в 13:00 (если компьютер был выключен — при следующем включении).'
Write-Host 'Сейчас делаю первую копию...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Script
Write-Host ''
Write-Host 'Можно закрыть окно.'
Read-Host 'Нажмите Enter'
