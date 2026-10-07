// Место виджета на рабочем столе, переживающее перенастройку мониторов.
// Абсолютные координаты ломаются при любой смене экранов: поменяли масштаб, разрешение или
// расположение — края мониторов сдвигаются, и виджет оказывается на соседнем экране.
// Поэтому храним монитор и отступ от ближайших к виджету краёв его рабочей области.
// Модуль одинаковый в MeowsClock, MeowsConvert, MeowsNotes и TempCPU.
const { screen, powerMonitor } = require('electron');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function findDisplay(place) {
  const all = screen.getAllDisplays();
  return (
    all.find((d) => String(d.id) === place.display) ||
    (place.label && all.find((d) => d.label === place.label)) ||
    null
  );
}

// Снимок места окна (bounds в DIP). По вертикали запоминаем верхний край даже у нижней привязки:
// высота виджетов часов и температуры меняется по содержимому, а верх должен стоять на месте.
function capture(b) {
  const d = screen.getDisplayMatching(b);
  const a = d.workArea;
  const right = b.x + b.width / 2 > a.x + a.width / 2;
  const bottom = b.y + b.height / 2 > a.y + a.height / 2;
  return {
    display: String(d.id),
    label: d.label || '',
    ax: right ? 'r' : 'l',
    dx: Math.round(right ? a.x + a.width - (b.x + b.width) : b.x - a.x),
    ay: bottom ? 'b' : 't',
    dy: Math.round(bottom ? a.y + a.height - b.y : b.y - a.y),
  };
}

// Прямоугольник для окна размера width × height. Если монитора больше нет — тот же угол
// основного экрана (запомненное место не трогаем: монитор вернётся — вернётся и виджет).
function resolve(place, width, height) {
  if (!place) return null;
  const a = (findDisplay(place) || screen.getPrimaryDisplay()).workArea;
  const x = place.ax === 'r' ? a.x + a.width - place.dx - width : a.x + place.dx;
  const y = place.ay === 'b' ? a.y + a.height - place.dy : a.y + place.dy;
  return {
    x: Math.round(clamp(x, a.x, a.x + a.width - width)),
    y: Math.round(clamp(y, a.y, a.y + a.height - height)),
    width,
    height,
  };
}

// restore() вызывается после подключения/отключения монитора, смены масштаба, разрешения,
// расположения и выхода из сна. Explorer растягивает рабочий стол (родителя закреплённого виджета)
// не сразу, а Chromium может сам подвинуть окно следом — поэтому возвращаем место несколько раз.
function watchDisplays(restore) {
  let timers = [];
  const schedule = () => {
    timers.forEach(clearTimeout);
    timers = [300, 1500, 4000].map((ms) => setTimeout(restore, ms));
  };
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, schedule);
  powerMonitor.on('resume', schedule);
  powerMonitor.on('unlock-screen', schedule);
}

module.exports = { capture, resolve, watchDisplays };
