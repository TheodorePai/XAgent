import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/mastra/dist/index.js', import.meta.url)),
  'dev', '--request-context-presets', './studio-presets.json'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
  env: { ...process.env, MASTRA_TELEMETRY_DISABLED: '1' },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
