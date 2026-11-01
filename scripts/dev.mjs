// Starts the backend (uvicorn on :8000) and the Next.js dev server (:3000) together; Ctrl+C stops both.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const py = existsSync("backend/.venv/bin/uvicorn") ? "backend/.venv/bin/uvicorn" : "uvicorn";
const procs = [
  spawn(py.startsWith("backend/") ? py.replace("backend/", "") : py, ["app.main:app", "--port", "8000", "--reload"], { cwd: "backend", stdio: "inherit" }),
  spawn("npx", ["next", "dev"], { stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill("SIGINT"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => code && code !== 130 && (console.error(`process exited with ${code}`), stop())));
