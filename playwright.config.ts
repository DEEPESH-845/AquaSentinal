import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level verification of AquaSentinal. Runs against `next dev` plus the FastAPI backend in offline SIMULATION mode
 * (no MODEL_API_KEY), with its own throwaway database so tests never touch the development data.
 * The dev-only window.__labStore and window.__missionStore hooks are used to read canonical state; actions go through the UI.
 * Software GL flags let the WebGL scene render on machines without a GPU.
 */
const BACKEND_DATA = "../e2e/.backend-data";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "e2e/.results",
  snapshotPathTemplate: "e2e/__screenshots__/{testFilePath}/{arg}{ext}",
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    launchOptions: { args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      // a fresh database per run; outside e2e/.results because Playwright empties that folder after servers start
      command: `rm -rf ${BACKEND_DATA} && .venv/bin/uvicorn app.main:app --port 8000`,
      cwd: "backend",
      url: "http://localhost:8000/api/health",
      reuseExistingServer: true,
      timeout: 60_000,
      env: { MODEL_API_KEY: "", APP_MODE: "SIMULATION", AQUA_HARDWARE_ENABLE: "false", AQUA_DATA_DIR: BACKEND_DATA, DATABASE_URL: `sqlite:///${BACKEND_DATA}/e2e.db` },
    },
    {
      command: "npm run dev",
      url: "http://localhost:3000",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
