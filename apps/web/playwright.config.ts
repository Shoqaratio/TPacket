import { defineConfig } from '@playwright/test';

const DB = `${process.env.TMPDIR ?? '/tmp'}/netlab-e2e-${Date.now()}.db`;

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
      command: `cd ../api && NETLAB_DATABASE_URL=sqlite:///${DB} NETLAB_BOOTSTRAP_ADMIN_EMAIL=admin@example.com .venv/bin/alembic upgrade head && NETLAB_DATABASE_URL=sqlite:///${DB} NETLAB_BOOTSTRAP_ADMIN_EMAIL=admin@example.com .venv/bin/uvicorn app.main:app --port 8000`,
      url: 'http://localhost:8000/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    { command: 'npx vite --port 5173 --strictPort', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 60_000 },
  ],
});
