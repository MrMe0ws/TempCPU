// Датчики из LibreHardwareMonitor (LHM). Сам LHM работает с правами администратора и драйвером PawnIO
// и отдаёт дерево датчиков встроенным веб-сервером (Options → Remote Web Server → Run): GET /data.json.
// Читать его можно без прав администратора, поэтому TempCPU запускается как обычная программа.
// WMI (root\LibreHardwareMonitor) не используем: в LHM 0.9.6 его убрали.
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- Выбор показаний ----------

// Порядок предпочтения датчиков: первый найденный по имени, иначе максимум из всех
const CPU_TEMP = ['CPU Package', 'Core (Tctl/Tdie)', 'Core Average', 'Core Max', 'CPU Cores'];
const GPU_TEMP = ['GPU Core', 'GPU Hot Spot'];
const CPU_LOAD = ['CPU Total'];
const GPU_LOAD = ['GPU Core', 'D3D 3D'];

const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

function pick(sensors, preferred) {
  for (const name of preferred) {
    const s = sensors.find((x) => x.name === name && typeof x.value === 'number');
    if (s) return s.value;
  }
  const values = sensors.map((x) => x.value).filter((v) => typeof v === 'number' && v > 0);
  return values.length ? Math.max(...values) : null;
}

function cleanName(name) {
  return String(name || '')
    .replace(/\((R|TM|tm|r)\)/g, '')
    .replace(/\s+(CPU|Processor)\b/g, '')
    .replace(/^(Intel|AMD)\s+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// hardware/sensors — массивы из WMI. Результат: { cpu, gpus } с температурой и нагрузкой в целых.
// Видеокарта без датчика температуры (обычно встроенная Intel) в список не попадает.
function selectReadings(hardware, sensors) {
  const of = (hw, type) => sensors.filter((s) => s.parent === hw.id && s.type === type);
  const cpuHw = hardware.find((h) => h.type === 'Cpu');
  const cpu = cpuHw
    ? {
        name: cleanName(cpuHw.name),
        temp: round(pick(of(cpuHw, 'Temperature'), CPU_TEMP)),
        load: round(pick(of(cpuHw, 'Load').filter((s) => CPU_LOAD.includes(s.name)), CPU_LOAD)),
      }
    : null;
  const gpus = hardware
    .filter((h) => /^Gpu/.test(h.type))
    .map((h) => ({
      name: cleanName(h.name),
      temp: round(pick(of(h, 'Temperature'), GPU_TEMP)),
      load: round(pick(of(h, 'Load').filter((s) => GPU_LOAD.includes(s.name)), GPU_LOAD)),
      integrated: h.type === 'GpuIntel',
    }))
    .filter((g) => g.temp !== null);
  return { cpu, gpus };
}

// ---------- Где LHM ----------

function findLhmExe(extra = []) {
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [...extra];
  try {
    const packages = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    for (const dir of fs.readdirSync(packages)) {
      if (dir.startsWith('LibreHardwareMonitor.LibreHardwareMonitor')) candidates.push(path.join(packages, dir, 'LibreHardwareMonitor.exe'));
    }
  } catch {}
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], local]) {
    if (base) candidates.push(path.join(base, 'LibreHardwareMonitor', 'LibreHardwareMonitor.exe'));
  }
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// ---------- Настройки веб-сервера LHM ----------

// LibreHardwareMonitor.config лежит рядом с exe (XML appSettings, бывает в несколько МБ) — перечитываем при изменении
let configCache = { file: null, mtime: 0, value: null };

function readLhmServer(exe) {
  const value = { enabled: false, host: '127.0.0.1', port: 8085 };
  if (!exe) return value;
  const file = path.join(path.dirname(exe), 'LibreHardwareMonitor.config');
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (configCache.file === file && configCache.mtime === mtime) return configCache.value;
    const xml = fs.readFileSync(file, 'utf8');
    const get = (key) => (xml.match(new RegExp(`key="${key}"\\s+value="([^"]*)"`)) || [])[1];
    value.enabled = get('runWebServerMenuItem') === 'true';
    const port = Number(get('listenerPort'));
    if (port > 0 && port < 65536) value.port = port;
    // «?» и неизвестный адрес LHM слушает на всех интерфейсах — тогда ходим на localhost
    const ip = get('listenerIp');
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) value.host = ip;
    configCache = { file, mtime, value };
  } catch {}
  return value;
}

// ---------- Разбор data.json ----------

// Дерево: компьютер → устройство (HardwareId) → группа по типу → датчик (SensorId, Type, RawValue).
// Тип устройства в JSON не пишется — берём его из картинки; cpu.png LHM ставит и неизвестным типам,
// поэтому процессор дополнительно сверяем по идентификатору (/intelcpu/0, /amdcpu/0).
const HW_IMAGES = { 'nvidia.png': 'GpuNvidia', 'ati.png': 'GpuAmd', 'intel.png': 'GpuIntel' };

function hardwareType(node) {
  const image = String(node.ImageURL || '').split('/').pop();
  if (HW_IMAGES[image]) return HW_IMAGES[image];
  if (image === 'cpu.png' && /cpu/i.test(node.HardwareId)) return 'Cpu';
  return 'Other';
}

// В старых версиях LHM нет RawValue — тогда разбираем строку вида «45,0 °C»
function sensorValue(node) {
  if (typeof node.RawValue === 'number') return node.RawValue;
  const v = parseFloat(String(node.Value || '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

function parseTree(root) {
  const hardware = [];
  const sensors = [];
  const walk = (node, hw) => {
    if (!node || typeof node !== 'object') return;
    if (node.HardwareId) {
      hw = { id: node.HardwareId, name: node.Text, type: hardwareType(node) };
      hardware.push(hw);
    } else if (node.SensorId && hw) {
      sensors.push({ id: node.SensorId, name: node.Text, type: node.Type, value: sensorValue(node), parent: hw.id });
    }
    for (const child of node.Children || []) walk(child, hw);
  };
  walk(root, null);
  return { hardware, sensors };
}

// ---------- Опрос ----------

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

function fetchJson(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/data.json', agent, timeout }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// getServer() — { host, port } веб-сервера LHM; спрашиваем на каждом опросе, порт мог поменяться
class SensorPoller {
  constructor(onData, getServer) {
    this.onData = onData;
    this.getServer = getServer;
    this.interval = 2000;
    this.timer = null;
    this.generation = 0;
  }

  start(intervalMs) {
    this.stop();
    this.interval = intervalMs;
    this.poll(++this.generation);
  }

  async poll(generation) {
    const { host, port } = this.getServer();
    let data;
    try {
      const { hardware, sensors } = parseTree(await fetchJson(host, port, 1500));
      data = { ok: true, ...selectReadings(hardware, sensors) };
    } catch (e) {
      data = { ok: false, error: e.code || e.message || '' };
    }
    if (generation !== this.generation) return;
    this.onData(data);
    this.timer = setTimeout(() => this.poll(generation), this.interval);
  }

  stop() {
    this.generation++;
    clearTimeout(this.timer);
  }
}

module.exports = { SensorPoller, selectReadings, parseTree, readLhmServer, cleanName, findLhmExe };
