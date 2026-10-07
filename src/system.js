// Показания, которые Windows отдаёт без LibreHardwareMonitor и без прав администратора: память и батарея.
// Батарею LHM иногда теряет (после переподключения зарядки у неё меняется Tag), поэтому читаем её сами.
const os = require('os');

let api = null;

function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const powrprof = koffi.load('powrprof.dll');
    const kernel32 = koffi.load('kernel32.dll');
    koffi.struct('TC_SYSTEM_BATTERY_STATE', {
      AcOnLine: 'uint8',
      BatteryPresent: 'uint8',
      Charging: 'uint8',
      Discharging: 'uint8',
      Spare1: koffi.array('uint8', 3),
      Tag: 'uint8',
      MaxCapacity: 'uint32',
      RemainingCapacity: 'uint32',
      Rate: 'int32', // мВт; при разряде отрицательная
      EstimatedTime: 'uint32', // секунды; 0xFFFFFFFF — неизвестно
      DefaultAlert1: 'uint32',
      DefaultAlert2: 'uint32',
    });
    koffi.struct('TC_SYSTEM_POWER_STATUS', {
      ACLineStatus: 'uint8',
      BatteryFlag: 'uint8',
      BatteryLifePercent: 'uint8',
      SystemStatusFlag: 'uint8',
      BatteryLifeTime: 'uint32',
      BatteryFullLifeTime: 'uint32',
    });
    api = {
      koffi,
      CallNtPowerInformation: powrprof.func(
        'long __stdcall CallNtPowerInformation(int, void *, ulong, _Out_ TC_SYSTEM_BATTERY_STATE *, ulong)'
      ),
      GetSystemPowerStatus: kernel32.func('bool __stdcall GetSystemPowerStatus(_Out_ TC_SYSTEM_POWER_STATUS *)'),
    };
  } catch (e) {
    console.error('Состояние батареи недоступно:', e.message);
  }
  return api;
}

const SystemBatteryState = 5;
const UNKNOWN = 0xffffffff;

// { percent, ac, charging, power (Вт, + заряд / − разряд), minutes } или null, если батареи нет
function readBattery() {
  const w = load();
  if (!w) return null;
  try {
    const state = {};
    if (w.CallNtPowerInformation(SystemBatteryState, null, 0, state, w.koffi.sizeof('TC_SYSTEM_BATTERY_STATE')) !== 0) return null;
    if (!state.BatteryPresent) return null;
    // Процент — как в системном значке; из ёмкостей он расходится на пару процентов
    const status = {};
    const percent =
      w.GetSystemPowerStatus(status) && status.BatteryLifePercent <= 100
        ? status.BatteryLifePercent
        : state.MaxCapacity
          ? Math.round((state.RemainingCapacity / state.MaxCapacity) * 100)
          : null;
    return {
      percent,
      ac: !!state.AcOnLine,
      charging: !!state.Charging,
      power: state.Rate ? Math.round(state.Rate / 100) / 10 : null,
      minutes: !state.AcOnLine && state.EstimatedTime !== UNKNOWN ? Math.round(state.EstimatedTime / 60) : null,
    };
  } catch {
    return null;
  }
}

// Свободная память на Windows — ullAvailPhys, как «Доступно» в диспетчере задач
function readMemory() {
  const total = os.totalmem();
  const used = total - os.freemem();
  return { used, total, load: Math.round((used / total) * 100) };
}

module.exports = { readBattery, readMemory };
