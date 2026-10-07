// Запуск Electron. Терминал VS Code выставляет ELECTRON_RUN_AS_NODE,
// из-за которого Electron работает как обычный Node — убираем её.
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env, cwd: `${__dirname}/..` });
child.on('close', (code) => process.exit(code ?? 0));
