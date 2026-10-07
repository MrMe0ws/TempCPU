# Настройка LibreHardwareMonitor для TempCPU (запускать с правами администратора):
#   - LibreHardwareMonitor.config: стартовать свёрнутым, сворачиваться в трей, крестик сворачивает,
#     включить веб-сервер (Remote Web Server) — через него TempCPU читает датчики
#   - задача планировщика «LibreHardwareMonitor»: запуск при входе с наивысшими правами (без UAC),
#     в том числе от батареи и без ограничения времени работы
#   - (пере)запуск LibreHardwareMonitor
# Имя и вид задачи — как у пункта LHM «Options → Run On Windows Startup», чтобы он её узнавал.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$User
)
$ErrorActionPreference = 'Stop'

$dir = Split-Path $Exe
$config = Join-Path $dir 'LibreHardwareMonitor.config'

# Настройки LHM — XML appSettings рядом с exe. LHM перезаписывает файл при выходе, поэтому работающий
# LHM сначала останавливаем (убитый процесс файл не пишет), а меняем только свои ключи.
Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
[xml]$xml = if (Test-Path $config) { Get-Content $config -Raw -Encoding UTF8 } else { '<?xml version="1.0" encoding="utf-8"?><configuration><appSettings /></configuration>' }
$settingsNode = $xml.configuration.SelectSingleNode('appSettings')
if (-not $settingsNode) { $settingsNode = $xml.configuration.AppendChild($xml.CreateElement('appSettings')) }
foreach ($key in 'startMinMenuItem', 'minTrayMenuItem', 'minCloseMenuItem', 'runWebServerMenuItem') {
  $node = $settingsNode.SelectSingleNode("add[@key='$key']")
  if (-not $node) {
    $node = $settingsNode.AppendChild($xml.CreateElement('add'))
    $node.SetAttribute('key', $key)
  }
  $node.SetAttribute('value', 'true')
}
$xml.Save($config)

$action = New-ScheduledTaskAction -Execute $Exe -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'LibreHardwareMonitor' -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description 'Starts LibreHardwareMonitor on Windows startup. (TempCPU)' -Force | Out-Null

Start-ScheduledTask -TaskName 'LibreHardwareMonitor'
