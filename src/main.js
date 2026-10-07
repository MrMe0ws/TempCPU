const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const desktopPin = require('./desktop-pin');
const widgetPlace = require('./widget-place');
const { SensorPoller, findLhmExe, readLhmServer } = require('./sensors');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('com.tempcpu.app');

// Виджет встроен в рабочий стол и почти всегда перекрыт окнами. Chromium считает такое окно
// невидимым и перестаёт его рисовать, а для дочернего окна рабочего стола это состояние может
// не сняться даже после «Свернуть всё» — виджет застывает. Отключаем расчёт перекрытия.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const ASSETS = path.join(__dirname, '..', 'assets');
const RENDERER = path.join(__dirname, 'renderer');
const WIDGET_WIDTH = 280;
const WIDGET_MIN_WIDTH = 230;
const WIDGET_MAX_WIDTH = 520;
const WIDGET_TITLE = 'TempCPU — виджет';
const APP_ICON = path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const LHM_TASK = 'LibreHardwareMonitor';
// Сколько после запуска ждём, пока LHM (он стартует вместе с Windows) поднимет веб-сервер
const LHM_WAIT_MS = 120000;
const STARTED_AT = Date.now();

// ---------- Хранилище ----------

const DEFAULT_SETTINGS = {
  interval: 2000,
  showLoad: true,
  showGpu: true,
  warnTemp: 80,
  hotTemp: 90,
  autostart: true,
  // true — пользователь сам переключал автозапуск в меню; до этого он включается при каждом старте
  autostartChosen: false,
  widgetEnabled: true,
  widgetOnTop: false,
  widgetOpacity: 1,
  widgetBounds: null,
  widgetPlace: null,
  widgetWidth: WIDGET_WIDTH,
};

const INTERVALS = [1000, 2000, 5000];
const WARN_TEMPS = [70, 75, 80, 85];
const HOT_TEMPS = [85, 90, 95, 100];

const clampWidth = (w) => Math.max(WIDGET_MIN_WIDTH, Math.min(WIDGET_MAX_WIDTH, Math.round(Number(w) || WIDGET_WIDTH)));

function dataPath(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeSettingsNow, 400);
}

function writeSettingsNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(dataPath('settings.json'), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Не удалось сохранить настройки', e);
  }
}

let settings;

// ---------- LibreHardwareMonitor ----------

// server — настройки веб-сервера LHM из его конфига (через него читаем датчики), running — процесс LHM есть
const lhm = { exe: null, task: false, running: false, server: readLhmServer(null), busy: false, checkedAt: 0 };

function checkLhm(force = false) {
  if (!force && Date.now() - lhm.checkedAt < 10000) return;
  lhm.checkedAt = Date.now();
  lhm.exe = findLhmExe();
  lhm.server = readLhmServer(lhm.exe);
  execFile('schtasks.exe', ['/Query', '/TN', LHM_TASK], { windowsHide: true }, (err) => {
    lhm.task = !err;
  });
  execFile('tasklist.exe', ['/FI', 'IMAGENAME eq LibreHardwareMonitor.exe', '/NH', '/FO', 'CSV'], { windowsHide: true }, (err, out) => {
    lhm.running = !err && /LibreHardwareMonitor\.exe/i.test(out);
  });
}

// Запуск через задачу планировщика не спрашивает UAC; без задачи — сразу настраиваем её.
// Если LHM уже работает, но без веб-сервера, — тоже настройка: она включит сервер и перезапустит LHM.
function startLhm() {
  if (!lhm.task || lhm.running) return setupLhm();
  execFile('schtasks.exe', ['/Run', '/TN', LHM_TASK], { windowsHide: true }, (err) => {
    if (err && lhm.exe) shell.openPath(lhm.exe);
  });
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function setupScriptPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'setup-lhm.ps1') : path.join(__dirname, '..', 'scripts', 'setup-lhm.ps1');
}

// scripts/setup-lhm.ps1 с правами администратора (один запрос UAC): настройки LHM, задача автозапуска, запуск
function setupLhm() {
  checkLhm(true);
  if (!lhm.exe) return installLhm();
  if (lhm.busy) return;
  lhm.busy = true;
  const user = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}`;
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScriptPath(), '-Exe', lhm.exe, '-User', user]
    .map((a) => psQuote(`"${a}"`))
    .join(',');
  const script = `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @(${args}); exit $p.ExitCode`;
  execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true },
    (err) => {
      lhm.busy = false;
      checkLhm(true);
      if (err) send('notice', 'Настройка отменена');
    }
  );
}

// Установка через winget в видимом окне: там видно прогресс и запросы UAC (LHM и драйвер PawnIO)
function installLhm() {
  const cmd =
    "winget install --id LibreHardwareMonitor.LibreHardwareMonitor --accept-source-agreements --accept-package-agreements; " +
    "Write-Host ''; Write-Host 'Готово. Вернитесь к виджету TempCPU и нажмите «Настроить».'";
  spawn('cmd.exe', ['/c', 'start', '"TempCPU"', 'powershell', '-NoProfile', '-NoExit', '-Command', cmd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();
}

// ---------- Показания ----------

let readings = { state: 'waiting', cpu: null, gpus: [] };

function onSensorData(data) {
  let state;
  if (data.ok && data.cpu && (data.cpu.temp !== null || data.gpus.length)) state = 'ok';
  else if (data.ok) state = 'no-sensors';
  else {
    checkLhm();
    if (!lhm.exe) state = 'missing';
    else if (lhm.running && !lhm.server.enabled) state = 'no-server';
    else if (Date.now() - STARTED_AT < LHM_WAIT_MS && (lhm.task || lhm.running)) state = 'waiting';
    else state = lhm.running ? 'no-server' : 'not-running';
  }
  readings = {
    state,
    cpu: data.ok ? data.cpu : null,
    gpus: data.ok ? data.gpus : [],
    lhm: { installed: !!lhm.exe, task: lhm.task, running: lhm.running },
  };
  send('readings', readings);
  updateTrayTooltip();
}

const poller = new SensorPoller(onSensorData, () => lhm.server);

// ---------- Виджет ----------

let widgetWindow = null;
let widgetHeight = 0; // высота по содержимому из последнего widget-resize
let tray = null;
let quitting = false;

function send(channel, data) {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.webContents.send(channel, data);
}

function boundsVisible(b) {
  if (!b) return false;
  const area = screen.getDisplayMatching(b).workArea;
  return b.x < area.x + area.width - 40 && b.x + b.width > area.x + 40 && b.y >= area.y - 10 && b.y < area.y + area.height - 40;
}

// По умолчанию — в правом нижнем углу, чтобы не лечь на соседние виджеты вверху справа
function defaultWidgetPosition(height) {
  const area = screen.getPrimaryDisplay().workArea;
  const width = settings.widgetWidth;
  return { x: area.x + area.width - width - 24, y: area.y + area.height - height - 24, width, height };
}

// Запомненное место (монитор + отступ от края) → прямоугольник под текущие экраны
function widgetPosition(height) {
  const width = settings.widgetWidth;
  // Настройки старых версий: только абсолютные x, y
  const saved = settings.widgetBounds && { ...settings.widgetBounds, width, height };
  if (!settings.widgetPlace && boundsVisible(saved)) {
    settings.widgetPlace = widgetPlace.capture(saved);
    saveSettings();
  }
  return widgetPlace.resolve(settings.widgetPlace, width, height) || defaultWidgetPosition(height);
}

// Сохраняется только по действию пользователя (перетащил, растянул); перенастройка экранов место не трогает
function rememberWidgetPlace() {
  if (!widgetWindow) return;
  const b = widgetWindow.getBounds();
  settings.widgetBounds = { x: b.x, y: b.y };
  settings.widgetPlace = widgetPlace.capture(b);
  saveSettings();
}

// После смены мониторов: виджет мог уехать на другой экран или поменять размер — ставим как было
function restoreWidgetPlace() {
  const win = widgetWindow;
  if (!win || win.isDestroyed() || widthDrag) return;
  const b = win.getBounds();
  const target = widgetPosition(widgetHeight || b.height);
  if (target.x !== b.x || target.y !== b.y || target.width !== b.width || target.height !== b.height) {
    desktopPin.setBounds(win, target);
  }
  desktopPin.raise(win);
}

function createWidget() {
  const bounds = widgetPosition(widgetHeight || 170);

  widgetWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    // При resizable: false Chromium фиксирует размер окна, и SetWindowPos закреплённого виджета
    // не может поменять размер. Системной рамки у прозрачного окна нет — ширину меняют
    // «ручки» по краям в самом виджете (widget-width-*).
    resizable: true,
    minWidth: WIDGET_MIN_WIDTH,
    maxWidth: WIDGET_MAX_WIDTH,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: settings.widgetOnTop,
    title: WIDGET_TITLE,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const win = widgetWindow;
  win.setOpacity(settings.widgetOpacity);
  win.loadFile(path.join(RENDERER, 'widget.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    if (!settings.widgetOnTop) pinWidget(win);
  });
  // Страница меняет <title> — держим постоянный, по нему окно ищется при отладке
  win.on('page-title-updated', (e) => e.preventDefault());

  win.on('moved', rememberWidgetPlace);
  win.on('closed', () => {
    if (widgetWindow === win) widgetWindow = null;
    // Окно закреплено внутри рабочего стола и погибает вместе с Explorer — поднимаем заново
    if (!quitting && settings.widgetEnabled && !widgetWindow) setTimeout(() => setWidgetEnabled(true), 2000);
  });
}

// Explorer может ещё не создать рабочий стол (ранний автозапуск) — пробуем повторно
function pinWidget(win, attempt = 0) {
  if (win.isDestroyed() || settings.widgetOnTop) return;
  if (desktopPin.pin(win)) return;
  if (attempt < 30) setTimeout(() => pinWidget(win, attempt + 1), 2000);
}

function setWidgetEnabled(on) {
  settings.widgetEnabled = on;
  if (on && !widgetWindow) createWidget();
  if (!on && widgetWindow) widgetWindow.close();
}

// Смена режима «на рабочем столе» ↔ «поверх окон» — проще пересоздать окно
function recreateWidget() {
  if (!widgetWindow) return;
  const old = widgetWindow;
  widgetWindow = null;
  old.destroy();
  createWidget();
}

// ---------- Автозапуск ----------

function loginItemOptions() {
  if (app.isPackaged) return { args: ['--autostart'] };
  // В режиме разработки запускаем electron.exe с путём к проекту
  return { path: process.execPath, args: [path.resolve(app.getAppPath()), '--autostart'] };
}

function applyAutostart() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: settings.autostart });
}

// ---------- Меню ----------

function radioMenu(key, values, label) {
  return values.map((v) => ({
    label: label(v),
    type: 'radio',
    checked: settings[key] === v,
    click: () => updateSettings({ [key]: v }),
  }));
}

function lhmMenuItems() {
  checkLhm();
  if (!lhm.exe) return [{ label: 'Установить LibreHardwareMonitor…', click: installLhm }];
  return [
    { label: 'Запустить LibreHardwareMonitor', enabled: readings.state !== 'ok', click: startLhm },
    { label: 'Настроить автозапуск LibreHardwareMonitor…', click: setupLhm },
  ];
}

function commonMenuItems() {
  return [
    { label: 'Обновлять', submenu: radioMenu('interval', INTERVALS, (v) => `Каждые ${v / 1000} с`) },
    {
      label: 'Цвета',
      submenu: [
        { label: 'Жёлтый с', submenu: radioMenu('warnTemp', WARN_TEMPS, (v) => `${v} °C`) },
        { label: 'Красный с', submenu: radioMenu('hotTemp', HOT_TEMPS, (v) => `${v} °C`) },
      ],
    },
    {
      label: 'Показывать нагрузку',
      type: 'checkbox',
      checked: settings.showLoad,
      click: (item) => updateSettings({ showLoad: item.checked }),
    },
    {
      label: 'Показывать видеокарту',
      type: 'checkbox',
      checked: settings.showGpu,
      click: (item) => updateSettings({ showGpu: item.checked }),
    },
    { type: 'separator' },
    {
      label: 'Поверх всех окон',
      type: 'checkbox',
      checked: settings.widgetOnTop,
      click: (item) => updateSettings({ widgetOnTop: item.checked }),
    },
    {
      label: 'Прозрачность',
      submenu: [1, 0.9, 0.8, 0.7, 0.6, 0.5].map((v) => ({
        label: `${Math.round(v * 100)}%`,
        type: 'radio',
        checked: Math.abs(settings.widgetOpacity - v) < 0.01,
        click: () => updateSettings({ widgetOpacity: v }),
      })),
    },
    { label: 'Вернуть в угол экрана', click: () => updateSettings({ widgetBounds: null }) },
    {
      label: 'Стандартная ширина',
      enabled: settings.widgetWidth !== WIDGET_WIDTH,
      click: () => updateSettings({ widgetWidth: WIDGET_WIDTH }),
    },
    { type: 'separator' },
    ...lhmMenuItems(),
    {
      label: 'Запускать вместе с Windows',
      type: 'checkbox',
      checked: settings.autostart,
      click: (item) => updateSettings({ autostart: item.checked, autostartChosen: true }),
    },
  ];
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Виджет на рабочем столе',
        type: 'checkbox',
        checked: settings.widgetEnabled,
        click: (item) => updateSettings({ widgetEnabled: item.checked }),
      },
      ...commonMenuItems(),
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ])
  );
}

function updateTrayTooltip() {
  if (!tray) return;
  const parts = [];
  if (readings.cpu && readings.cpu.temp !== null) parts.push(`CPU ${readings.cpu.temp}°`);
  for (const g of readings.gpus) parts.push(`GPU ${g.temp}°`);
  tray.setToolTip(parts.length ? `TempCPU — ${parts.join(' · ')}` : 'TempCPU — нет данных');
}

function createTray() {
  tray = new Tray(path.join(ASSETS, process.platform === 'win32' ? 'tray.ico' : 'icon-small.png'));
  tray.setToolTip('TempCPU');
  tray.on('click', () => updateSettings({ widgetEnabled: true }));
  // Пункты про LHM зависят от состояния — пересобираем меню перед показом
  tray.on('right-click', buildTrayMenu);
  buildTrayMenu();
}

// ---------- Настройки ----------

function updateSettings(patch) {
  const prev = { ...settings };
  Object.assign(settings, patch);

  if ('autostart' in patch && patch.autostart !== prev.autostart) applyAutostart();
  if ('widgetEnabled' in patch && patch.widgetEnabled !== prev.widgetEnabled) setWidgetEnabled(patch.widgetEnabled);
  if ('widgetOnTop' in patch && patch.widgetOnTop !== prev.widgetOnTop) recreateWidget();
  if ('widgetOpacity' in patch && widgetWindow) widgetWindow.setOpacity(settings.widgetOpacity);
  if ('interval' in patch && patch.interval !== prev.interval) poller.start(settings.interval);
  if ('widgetWidth' in patch) {
    settings.widgetWidth = clampWidth(settings.widgetWidth);
    if (widgetWindow) {
      const b = widgetWindow.getBounds();
      // Сохраняем правый край — виджет по умолчанию стоит у правой стороны экрана
      desktopPin.setBounds(widgetWindow, { ...b, x: b.x + b.width - settings.widgetWidth, width: settings.widgetWidth });
      rememberWidgetPlace();
    }
  }
  if ('widgetBounds' in patch && patch.widgetBounds === null) {
    settings.widgetPlace = null;
    if (widgetWindow) desktopPin.setBounds(widgetWindow, defaultWidgetPosition(widgetWindow.getBounds().height));
  }

  saveSettings();
  buildTrayMenu();
  send('settings', settings);
  return settings;
}

// ---------- IPC ----------

ipcMain.handle('get-state', () => ({ settings, readings, version: app.getVersion() }));
ipcMain.handle('set-settings', (_e, patch) => updateSettings(patch));
ipcMain.on('lhm-action', (_e, action) => {
  if (action === 'install') installLhm();
  else if (action === 'setup') setupLhm();
  else if (action === 'start') startLhm();
});

ipcMain.on('widget-resize', (_e, height) => {
  if (!widgetWindow) return;
  const b = widgetWindow.getBounds();
  const h = Math.max(60, Math.min(1200, Math.round(height)));
  widgetHeight = h;
  const w = settings.widgetWidth;
  if (b.height !== h || b.width !== w) desktopPin.setBounds(widgetWindow, { ...b, width: w, height: h });
});

// Растягивание за край: renderer присылает смещение мыши от начала перетаскивания
let widthDrag = null;

ipcMain.on('widget-width-start', () => {
  if (widgetWindow) widthDrag = widgetWindow.getBounds();
});

ipcMain.on('widget-width-move', (_e, { edge, dx }) => {
  if (!widgetWindow || !widthDrag) return;
  const start = widthDrag;
  const width = clampWidth(start.width + (edge === 'left' ? -dx : dx));
  // Левый край: правая граница остаётся на месте
  const x = edge === 'left' ? start.x + start.width - width : start.x;
  settings.widgetWidth = width;
  desktopPin.setBounds(widgetWindow, { x, y: start.y, width, height: widgetWindow.getBounds().height });
});

ipcMain.on('widget-width-end', () => {
  if (!widgetWindow || !widthDrag) return;
  widthDrag = null;
  rememberWidgetPlace();
  buildTrayMenu();
});

ipcMain.on('widget-menu', () => {
  if (!widgetWindow) return;
  Menu.buildFromTemplate([
    ...commonMenuItems(),
    { type: 'separator' },
    { label: 'Скрыть виджет', click: () => updateSettings({ widgetEnabled: false }) },
    { label: 'Выход', click: () => app.quit() },
  ]).popup({ window: widgetWindow });
});

// ---------- Жизненный цикл ----------

app.on('second-instance', () => updateSettings({ widgetEnabled: true }));

app.on('before-quit', () => {
  quitting = true;
  poller.stop();
  writeSettingsNow();
});

app.on('window-all-closed', () => {
  // Приложение продолжает жить в трее
});

app.whenReady().then(() => {
  settings = { ...DEFAULT_SETTINGS, ...readJson('settings.json', {}) };
  settings.widgetWidth = clampWidth(settings.widgetWidth);
  if (!INTERVALS.includes(settings.interval)) settings.interval = DEFAULT_SETTINGS.interval;

  // Пока пользователь не выключил автозапуск сам, прописываем его при каждом старте.
  // После ручного выбора — синхронизируем флаг с реальной записью в системе.
  if (!settings.autostartChosen) {
    settings.autostart = true;
    applyAutostart();
    saveSettings();
  } else if (process.platform === 'win32') {
    settings.autostart = app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  }

  checkLhm(true);
  createTray();
  if (settings.widgetEnabled) createWidget();
  widgetPlace.watchDisplays(restoreWidgetPlace);
  poller.start(settings.interval);
});
