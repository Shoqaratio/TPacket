import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const db = join(tmpdir(), `netlab-e2e-${Date.now()}.db`).replaceAll('\\', '/');
const python = process.env.TPACKET_TEST_PYTHON ?? (process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python');

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1366, height: 768 },
    locale: 'fr-FR',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: `"${python}" -m alembic upgrade head && "${python}" -m app.cli create-admin admin@example.com --name Admin && "${python}" -m uvicorn app.main:app --port 8000`,
      cwd: '../api',
      env: { NETLAB_DATABASE_URL: `sqlite:///${db}`, TPACKET_ADMIN_PASSWORD: 'correct horse battery' },
      url: 'http://localhost:8000/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    { command: 'npx vite --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
  ],
});
