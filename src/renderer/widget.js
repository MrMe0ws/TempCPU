const $ = (sel) => document.querySelector(sel);

const ICON_CPU =
  '<svg viewBox="0 0 24 24"><path d="M9 9h6v6H9V9zm12 2V9h-2V7a2 2 0 0 0-2-2h-2V3h-2v2h-2V3H9v2H7a2 2 0 0 0-2 2v2H3v2h2v2H3v2h2v2a2 2 0 0 0 2 2h2v2h2v-2h2v2h2v-2h2a2 2 0 0 0 2-2v-2h2v-2h-2v-2h2zm-4 6H7V7h10v10z"/></svg>';
const ICON_GPU =
  '<svg viewBox="0 0 24 24"><path d="M2 6h1v12H2V6zm3 0h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-5v2h-2v-2H9v2H7v-2H5V6zm2 2v7h13V8H7zm7.5 1.25a2.25 2.25 0 1 1 0 4.5 2.25 2.25 0 0 1 0-4.5zM8.5 9.5h2v1h-2v-1zm0 2h2v1h-2v-1z"/></svg>';

const ICON_MEMORY =
  '<svg viewBox="0 0 24 24"><path d="M3 7h18a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-1v2h-2v-2h-2v2h-2v-2h-2v2H9v-2H7v2H5v-2H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm1 2v6h16V9H4zm2 1h2v4H6v-4zm4 0h2v4h-2v-4zm4 0h2v4h-2v-4z"/></svg>';
const ICON_DISK =
  '<svg viewBox="0 0 24 24"><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h14V5H5zm2 2h10v2H7V7zm0 4h10v2H7v-2zm8 4h2v2h-2v-2z"/></svg>';
const ICON_PLUG = '<svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>';

// Батарея с заливкой по заряду
function batteryIcon(percent) {
  const fill = Math.max(1, Math.round((12 * Math.min(100, Math.max(0, percent || 0))) / 100));
  return `<svg viewBox="0 0 24 24"><path d="M4 7h13a2 2 0 0 1 2 2v1h1a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v6h13V9H4z"/><rect x="5" y="10" width="${fill}" height="4" rx="0.5"/></svg>`;
}

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

const has = (v) => v !== null && v !== undefined;

function level(value, warn, hot) {
  if (!has(value)) return '';
  if (has(hot) && value >= hot) return 'hot';
  if (has(warn) && value >= warn) return 'warm';
  return '';
}

// Десятые — только у маленьких чисел: «7,4», «19»
const decimal = (v) => (Math.abs(v) < 10 ? v.toFixed(1).replace('.', ',') : String(Math.round(v)));
const gigabytes = (bytes) => (bytes / 2 ** 30).toFixed(1).replace('.', ',');

function duration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}

// value — HTML большого числа (null → «–»), hint — строка под ним
function rowHtml({ kind, icon, name, value, hint, cls = '', title }) {
  return `
    <div class="row ${cls}">
      <div class="chip" title="${escapeHtml(title || (name ? `${kind} · ${name}` : kind))}">
        <span class="badge">${icon}</span>
        <div class="chip-text">
          <span class="kind">${kind}</span>
          ${name ? `<span class="model">${escapeHtml(name)}</span>` : ''}
        </div>
      </div>
      <div class="field">
        <div class="temp${has(value) ? '' : ' none'}">${has(value) ? value : '–'}</div>
        ${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''}
      </div>
    </div>`;
}

const tempHtml = (t) => (has(t) ? `${t}<span class="deg">°</span>` : null);

// CPU/GPU: температура, под ней — нагрузка и мощность, что включено в «Показателях»
function chipRow(kind, icon, item) {
  const s = state.settings;
  const parts = [];
  if (item && s.showLoad && has(item.load)) parts.push(s.showPower ? `${item.load}%` : `нагрузка ${item.load}%`);
  if (item && s.showPower && has(item.power)) parts.push(`${decimal(item.power)} Вт`);
  return rowHtml({
    kind,
    icon,
    name: item && item.name,
    value: tempHtml(item && item.temp),
    hint: parts.join(' · '),
    cls: level(item && item.temp, s.warnTemp, s.hotTemp),
  });
}

function memoryRow(m) {
  return rowHtml({
    kind: 'Память',
    icon: ICON_MEMORY,
    name: `${gigabytes(m.used)} из ${gigabytes(m.total)} ГБ`,
    value: `${m.load}<span class="unit">%</span>`,
    cls: level(m.load, 85, 95),
  });
}

function diskRow(d) {
  return rowHtml({
    kind: 'Диск',
    icon: ICON_DISK,
    name: d.name,
    value: tempHtml(d.temp),
    hint: has(d.load) ? `активность ${d.load}%` : '',
    // У NVMe свои пороги (обычно 70/75 °C) — их сообщает сам диск
    cls: level(d.temp, d.warnTemp, d.hotTemp),
  });
}

// От батареи — расход всего ноутбука (скорость разряда). От сети батарея молчит, пока не заряжается, —
// тогда показываем питание платформы из датчиков процессора (Intel PSys), если оно есть.
function batteryRow(b, cpu) {
  let power = null;
  let hint = '';
  let about = '';
  let status;
  if (!b.ac) {
    status = has(b.minutes) ? `${b.percent}% · ${duration(b.minutes)}` : `${b.percent}% · от батареи`;
    if (has(b.power)) [power, hint, about] = [Math.abs(b.power), 'расход', 'расход ноутбука — скорость разряда батареи'];
  } else {
    status = b.charging ? `${b.percent}% · заряжается` : `${b.percent}% · от сети`;
    if (b.charging && has(b.power) && b.power > 0) {
      [power, hint, about] = [b.power, 'в батарею', 'скорость заряда батареи'];
    } else if (cpu && has(cpu.platformPower)) {
      [power, hint, about] = [
        cpu.platformPower,
        'платформа',
        'питание платформы по датчику процессора (PSys): процессор, память, часть периферии. Расход всего ноутбука виден от батареи',
      ];
    }
  }
  return rowHtml({
    kind: 'Питание',
    icon: b.ac ? ICON_PLUG : batteryIcon(b.percent),
    name: status,
    value: has(power) ? `${decimal(power)}<span class="unit">Вт</span>` : null,
    hint,
    title: about ? `Питание · ${about}` : 'Питание',
    cls: !b.ac && b.percent <= 10 ? 'hot' : !b.ac && b.percent <= 20 ? 'warm' : '',
  });
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

  const s = state.settings;
  const ok = r.state === 'ok';
  let html = chipRow('CPU', ICON_CPU, r.cpu);
  if (ok && s.showGpu) {
    for (const g of r.gpus) html += chipRow(g.integrated ? 'GPU (встр.)' : 'GPU', ICON_GPU, g);
  }
  if (s.showMemory && r.memory) html += memoryRow(r.memory);
  if (ok && s.showDisks) for (const d of r.disks || []) html += diskRow(d);
  if (s.showBattery && r.battery) html += batteryRow(r.battery, ok ? r.cpu : null);
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
