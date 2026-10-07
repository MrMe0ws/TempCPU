// Закрепление окна на рабочем столе Windows (тот же подход, что в MeowsConvert, MeowsClock и MeowsNotes).
// Окно становится дочерним для окна, в котором живут значки рабочего стола (Progman или WorkerW).
// Поэтому «Свернуть всё» (Win+D, жест тремя пальцами) его не прячет, а обычные программы
// всегда остаются поверх него.
const { screen } = require('electron');

let api = null;

function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    koffi.struct('TC_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    koffi.struct('TC_POINT', { x: 'long', y: 'long' });
    api = {
      FindWindowExW: user32.func('intptr_t __stdcall FindWindowExW(intptr_t, intptr_t, str16, str16)'),
      SetParent: user32.func('intptr_t __stdcall SetParent(intptr_t, intptr_t)'),
      GetAncestor: user32.func('intptr_t __stdcall GetAncestor(intptr_t, uint)'),
      GetDesktopWindow: user32.func('intptr_t __stdcall GetDesktopWindow()'),
      IsWindow: user32.func('bool __stdcall IsWindow(intptr_t)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t, intptr_t, int, int, int, int, uint)'),
      ScreenToClient: user32.func('bool __stdcall ScreenToClient(intptr_t, _Inout_ TC_POINT *)'),
    };
  } catch (e) {
    console.error('Закрепление на рабочем столе недоступно:', e.message);
  }
  return api;
}

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
const HWND_TOP = 0;
const GA_PARENT = 1;

function hwndOf(win) {
  return Number(win.getNativeWindowHandle().readBigInt64LE(0));
}

// Окно, содержащее SHELLDLL_DefView (значки рабочего стола).
// Windows 11 24H2+: это Progman. Раньше или при запущенных «живых обоях» — один из WorkerW.
function findDesktopHost() {
  const w = load();
  if (!w) return 0;
  const progman = w.FindWindowExW(0, 0, 'Progman', null);
  if (progman && w.FindWindowExW(progman, 0, 'SHELLDLL_DefView', null)) return progman;
  let worker = 0;
  while ((worker = w.FindWindowExW(0, worker, 'WorkerW', null))) {
    if (w.FindWindowExW(worker, 0, 'SHELLDLL_DefView', null)) return worker;
  }
  return 0;
}

// GetParent тут не подходит: без WS_CHILD он возвращает владельца, а не родителя
function parentOf(hwnd) {
  const w = load();
  const parent = w.GetAncestor(hwnd, GA_PARENT);
  return parent && parent !== w.GetDesktopWindow() ? parent : 0;
}

function isPinned(win) {
  const w = load();
  if (!w || win.isDestroyed()) return false;
  const parent = parentOf(hwndOf(win));
  return !!parent && w.IsWindow(parent);
}

// Прямоугольник в DIP (как у BrowserWindow.getBounds) → физические пиксели в координатах родителя
function toParentPixels(parent, dipRect) {
  const w = load();
  const px = screen.dipToScreenRect(null, dipRect);
  const pt = { x: px.x, y: px.y };
  if (parent) w.ScreenToClient(parent, pt);
  return { x: pt.x, y: pt.y, width: px.width, height: px.height };
}

// Возвращает true, если окно встроено в рабочий стол
function pin(win) {
  const w = load();
  if (!w || win.isDestroyed()) return false;
  const host = findDesktopHost();
  if (!host) return false;
  const hwnd = hwndOf(win);
  const bounds = win.getBounds();
  w.SetParent(hwnd, host);
  const r = toParentPixels(host, bounds);
  w.SetWindowPos(hwnd, HWND_TOP, r.x, r.y, r.width, r.height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  return true;
}

// Задать положение и размер в DIP экранных координат — работает и для закреплённого окна
function setBounds(win, dipRect) {
  const w = load();
  if (!w || !isPinned(win)) {
    win.setBounds(dipRect);
    return;
  }
  const hwnd = hwndOf(win);
  const r = toParentPixels(parentOf(hwnd), dipRect);
  w.SetWindowPos(hwnd, HWND_TOP, r.x, r.y, r.width, r.height, SWP_NOACTIVATE | SWP_NOZORDER);
}

// Поднять над значками рабочего стола (после того как Explorer перерисовал их)
function raise(win) {
  const w = load();
  if (!w || !isPinned(win)) return;
  w.SetWindowPos(hwndOf(win), HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

module.exports = { pin, isPinned, setBounds, raise, available: () => !!load() };
