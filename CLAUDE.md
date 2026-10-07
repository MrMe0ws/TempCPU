# TempCPU — заметки для разработки

Виджет температуры CPU/GPU на Electron. Каркас (окно, закрепление на рабочем столе, ширина за края,
меню, трей, автозапуск) — из `../MeowsClock` (подробности про `desktop-pin.js` — в `../MeowsConvert/CLAUDE.md`).
Главного окна нет: только виджет и трей.

## Структура

```
src/
  main.js            трей, виджет, настройки, меню, автозапуск, управление LHM, IPC
  sensors.js         SensorPoller (HTTP data.json LHM), parseTree, selectReadings, readLhmServer, findLhmExe
  desktop-pin.js     встраивание виджета в рабочий стол (копия из MeowsClock, префикс структур TC_)
  preload.js         window.api, белый список каналов main → renderer в CHANNELS
  renderer/widget.*  строки CPU/GPU, подсказка «нет данных», ручки ширины
scripts/
  setup-lhm.ps1      с правами админа: стоп LHM, его настройки (вкл. веб-сервер) + задача планировщика + запуск (в сборке — extraResources)
  make-icon.js       рисует иконку кодом (чип с ушками и градусником)
  start.js           запуск без ELECTRON_RUN_AS_NODE
```

## Команды

- `npm start` — запуск; `npm run icon` — иконки; `npm run dist` — установщик NSIS.
- `parseTree`/`selectReadings` проверять node-скриптом с деревом в формате `data.json` LHM; `SensorPoller` —
  натравив его на `http.createServer`, отдающий это дерево.
- UI — `npm start -- --remote-debugging-port=9335` и CDP. Показания можно подставить:
  `state.readings = { state: 'ok', cpu: {...}, gpus: [...] }; render()`.

## Архитектура

- **Источник данных — LibreHardwareMonitor.** Настоящая температура CPU на Windows доступна только через
  драйвер ядра (MSR), без прав админа есть лишь ACPI-зона (`Win32_PerfFormattedData_Counters_ThermalZoneInformation`),
  на ноутбуке пользователя она показывает ~28 °C и к CPU отношения не имеет. LHM (с драйвером PawnIO; старый
  WinRing0 блокирует Защитник) работает с правами админа. **WMI (`root\LibreHardwareMonitor`) в LHM 0.9.6 убран** —
  читаем встроенный веб-сервер (`runWebServerMenuItem`, порт `listenerPort`, по умолчанию 8085): `GET /data.json` —
  дерево узлов `{Text, Children}`; у устройств `HardwareId` и `ImageURL`, у датчиков `SensorId`, `Type`, `RawValue`.
  Тип устройства берётся из картинки (`nvidia/ati/intel.png` → Gpu*); `cpu.png` LHM ставит и неизвестным типам,
  поэтому CPU — ещё и по `cpu` в `HardwareId`. Адрес `listenerIp` «?» = все интерфейсы → ходим на 127.0.0.1.
- `SensorPoller` — `http.get` с keep-alive раз в интервал (таймаут 1,5 с). Порт/адрес — из `LibreHardwareMonitor.config`
  (`readLhmServer`, кэш по mtime, перечитывается в `checkLhm` при ошибках опроса).
- `selectReadings`: CPU — первый `HardwareType = Cpu`, температура по приоритету `CPU_TEMP` (иначе максимум),
  нагрузка — `CPU Total`. GPU — все `Gpu*` с датчиком температуры (`GPU Core`, иначе максимум); без датчика —
  не показываются (встроенная Intel обычно без него).
- Состояния `readings.state`: `ok`, `waiting` (первые 2 мин после старта, если задача LHM есть — LHM стартует
  параллельно), `not-running`, `no-server` (процесс LHM есть — по `tasklist`, — а веб-сервер выключен или не
  отвечает; кнопка «Настроить»), `missing` (exe LHM не найден), `no-sensors` (LHM работает, датчиков нет — обычно
  без админа/драйвера). Статус в шапке — только для не-`ok`.
- LHM: exe ищется в `WinGet\Packages\LibreHardwareMonitor.LibreHardwareMonitor_*`, Program Files, LocalAppData.
  Задача планировщика `LibreHardwareMonitor` (корень) — то же имя, что создаёт сам LHM в «Run On Windows Startup».
  «Запустить» = `schtasks /Run` (без UAC); без задачи или если LHM уже работает (значит, без сервера) — `setup-lhm.ps1` через `Start-Process -Verb RunAs`.
  Установка — видимое окно PowerShell с `winget install`.
- Высота окна — по содержимому (`widget-resize`), ширина — ручками (`widget-width-*`), как в MeowsClock.

## Подводные камни

- `resizable: true` обязателен (иначе `SetWindowPos` закреплённого окна не меняет размер), `CalculateNativeWinOcclusion`
  отключён, `backgroundThrottling: false`, двигать закреплённое окно только через `desktopPin.setBounds`.
- Задача планировщика: обязательно `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries` и
  `ExecutionTimeLimit 0` — по умолчанию задача не стартует от батареи и убивается через 72 часа.
- LHM перезаписывает `LibreHardwareMonitor.config` при выходе — скрипт сначала убивает LHM (убитый файл не пишет),
  меняет только свои ключи и запускает задачу заново.
- **ELECTRON_RUN_AS_NODE** из терминала VS Code — запускать через `npm start` или из Проводника.
  Бинарник Electron скачивается при первом `npm start`.
- Строки с кириллицей в `-Command` PowerShell 5.1 портятся — пути передавать через `-EncodedCommand` (UTF-16LE)
  или относительными путями.
- Поиск окна при отладке: дочернее окно Progman с заголовком `TempCPU — виджет`.

## Место виджета при смене мониторов

- `src/widget-place.js` (одинаковый в MeowsClock, MeowsConvert, Notes, TempCPU) хранит в `settings.widgetPlace`
  монитор (`display.id`, запасной ключ — `label`) и отступ от ближайших краёв его рабочей области. Абсолютные
  `widgetBounds` оставлены для совместимости: из них при первом запуске строится `widgetPlace`.
  Без этого смена масштаба/разрешения/расположения экранов уводила виджет на соседний монитор.
- Место сохраняется только по действию пользователя (`moved`, конец растягивания) через `rememberWidgetPlace`.
- `watchDisplays` на `display-added/removed/metrics-changed`, выход из сна и разблокировку вызывает
  `restoreWidgetPlace` трижды (0,3 / 1,5 / 4 с): Explorer растягивает Progman не сразу, а Chromium после смены DPI
  сам двигает и масштабирует дочернее окно. Если монитора нет — тот же угол основного экрана, сохранённое место не меняется.
