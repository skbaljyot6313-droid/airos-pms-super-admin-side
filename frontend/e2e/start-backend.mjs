// E2E backend launcher — spawns uvicorn against the fixture database.
// Playwright's webServer runs this so the API env never depends on the
// developer's shell. PYTHON_BIN may point at a specific interpreter
// (e.g. a 3.12 install whose asyncpg is not policy-blocked).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend');
const python = process.env.PYTHON_BIN || 'python';
const dbUrl =
  process.env.E2E_DATABASE_URL ||
  'postgresql+asyncpg://postgres:e2e@localhost:55432/airos_e2e';

const child = spawn(
  python,
  ['-m', 'uvicorn', 'app.main:app', '--port', '8901', '--log-level', 'warning'],
  {
    cwd: backendDir,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      RUN_EMBEDDED_SCHEDULER: 'false',
      APP_ENV: 'development',
      CORS_ORIGINS: 'http://localhost:3000',
    },
    stdio: 'inherit',
  },
);

const shutdown = () => child.kill('SIGTERM');
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', (code) => process.exit(code ?? 1));
