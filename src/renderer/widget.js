const $ = (sel) => document.querySelector(sel);

const ICON_CPU =
  '<svg viewBox="0 0 24 24"><path d="M9 9h6v6H9V9zm12 2V9h-2V7a2 2 0 0 0-2-2h-2V3h-2v2h-2V3H9v2H7a2 2 0 0 0-2 2v2H3v2h2v2H3v2h2v2a2 2 0 0 0 2 2h2v2h2v-2h2v2h2v-2h2a2 2 0 0 0 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z"/></svg>';
const ICON_GPU =
  '<svg viewBox="0 0 24 24"><path d="M2 6h1v12H2V6zm3 0h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-5v2h-2v-2H9v2H7v-2H5V6zm2 2v7h13V8H7zm7.5 1.25a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5zM8.5 9.5h2v1h-2v-1zm0 2h2v1h-2v-1z"/></svg>';

const state = { settings: null, readings: null, notice: '' };

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Высота окна ----------

// getBoundingClientRect считает раскладку сразу, не дожидаясь кадра: ResizeObserver срабатывает
// только при отрисовке, а перекрытое окно может не рисоваться.
let lastHeight = 0;
function reportHeight() {
  const h = Math.ceil($('#widget').getBoundingClientRect().height);
  if (h === lastHeight) return;
  lastHeight = h;
  window.api.widgetResize(h);
}

// ---------- Строки ----------

function level(temp) {
  if (temp === null || temp === undefined) return '';
  if (temp >= state.settings.hotTemp) return 'hot';
  if (temp >= state.settings.warnTemp) return 'warm';
  return '';
}

function rowHtml(kind, icon, item) {
  const temp = item ? item.temp : null;
  const hasTemp = temp !== null && temp !== undefined;
  const load = item && item.load !== null && item.load !== undefined ? `нагрузка ${item.load}%` : '';
  const title = item && item.name ? `${kind} · ${item.name}` : kind;
  return `
    <div class="row ${level(temp)}">
      <div class="chip" title="${escapeHtml(title)}">
        <span class="badge">${icon}</span>
        <div class="chip-text">
          <span class="kind">${kind}</span>
          ${item && item.name ? `<span class="model">${escapeHtml(item.name)}</span>` : ''}
        </div>
      </div>
      <div class="field">
        <div class="temp${hasTemp ? '' : ' none'}">${hasTemp ? `${temp}<span class="deg">°</span>` : '–'}</div>
        ${state.settings.showLoad && load ? `<div class="hint">${load}</div>` : ''}
      </div>
    </div>`;
}

// Подсказка и кнопка для состояний без данных; статус в шапке — только когда что-то не так
const NOTICES = {
  waiting: { status: 'Жду LibreHardwareMonitor…', cls: '' },
  'not-running': {
    status: 'LibreHardwareMonitor не запущен',
    cls: 'warn',
    text: (lhm) =>
      lhm.task
        ? 'Температуру виджету отдаёт LibreHardwareMonitor — сейчас он не работает.'
        : 'Температуру виджету отдаёт LibreHardwareMonitor. Настройте его запуск вместе с Windows — понадобятся права администратора.',
    button: (lhm) => (lhm.task ? ['Запустить', 'start'] : ['Настроить и запустить', 'setup']),
  },
  'no-server': {
    status: 'Нет связи с LibreHardwareMonitor',
    cls: 'warn',
    text: () =>
      'LibreHardwareMonitor запущен, но не отдаёт данные: виджет читает их через его веб-сервер. «Настроить» включит сервер и перезапустит LHM — понадобятся права администратора.',
    button: () => ['Настроить', 'setup'],
  },
  missing: {
    status: 'Нужен LibreHardwareMonitor',
    cls: 'warn',
    text: () => 'Температуру процессора Windows отдаёт только через драйвер. Её читает бесплатная программа LibreHardwareMonitor — установите её, затем нажмите «Настроить» в меню.',
    button: () => ['Установить', 'install'],
  },
  'no-sensors': {
    status: 'Датчики недоступны',
    cls: 'bad',
    text: () => 'LibreHardwareMonitor работает, но не видит датчиков. Он должен быть запущен от администратора, а драйвер PawnIO — установлен.',
    button: () => ['Настроить', 'setup'],
  },
};

let lastRowsHtml = '';
function render() {
  const r = state.readings;
  if (!state.settings || !r) return;

  let html = rowHtml('CPU', ICON_CPU, r.cpu);
  if (r.state === 'ok' && state.settings.showGpu) {
    for (const g of r.gpus) html += rowHtml(g.integrated ? 'GPU (встр.)' : 'GPU', ICON_GPU, g);
  }
  if (html !== lastRowsHtml) {
    lastRowsHtml = html;
    $('#rows').innerHTML = html;
  }

  const n = NOTICES[r.state];
  const lhm = r.lhm || {};
  $('#status').textContent = state.notice || (n ? n.status : '');
  $('#status').className = `status ${state.notice ? 'warn' : n ? n.cls : ''}`;
  $('#notice').hidden = !(n && n.text);
  if (n && n.text) {
    $('#notice-text').textContent = n.text(lhm);
    const [label, action] = n.button(lhm);
    $('#notice-btn').textContent = label;
    $('#notice-btn').dataset.action = action;
  }
  reportHeight();
}

$('#notice-btn').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  window.api.lhmAction(btn.dataset.action);
  // Защита от двойного клика, пока идёт UAC/запуск
  btn.disabled = true;
  setTimeout(() => (btn.disabled = false), 4000);
});

// ---------- Общее ----------

$('#w-menu').addEventListener('click', () => window.api.widgetMenu());
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.api.widgetMenu();
});

new ResizeObserver(reportHeight).observe($('#widget'));

// Ширина: тянем за левый или правый край. Смещение считаем по screenX — он не зависит
// от того, что окно под курсором само двигается и меняет размер.
for (const grip of document.querySelectorAll('.grip')) {
  let startX = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    startX = e.screenX;
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('active');
    document.body.classList.add('resizing');
    window.api.widthStart();
  });
  grip.addEventListener('pointermove', (e) => {
    if (startX !== null) window.api.widthMove(grip.dataset.edge, e.screenX - startX);
  });
  const finish = () => {
    if (startX === null) return;
    startX = null;
    grip.classList.remove('active');
    document.body.classList.remove('resizing');
    window.api.widthEnd();
  };
  grip.addEventListener('pointerup', finish);
  grip.addEventListener('lostpointercapture', finish);
  grip.addEventListener('dblclick', () => window.api.setSettings({ widgetWidth: 280 }));
}

let noticeTimer = null;

(async () => {
  const s = await window.api.getState();
  state.settings = s.settings;
  state.readings = s.readings;
  render();
  window.api.on('settings', (settings) => {
    state.settings = settings;
    lastRowsHtml = '';
    render();
  });
  window.api.on('readings', (readings) => {
    state.readings = readings;
    render();
  });
  window.api.on('notice', (text) => {
    state.notice = text;
    render();
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      state.notice = '';
      render();
    }, 4000);
  });
})();
