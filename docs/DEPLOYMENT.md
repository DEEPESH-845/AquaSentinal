# Deployment

Recommended free setup: the Next.js frontend on **Vercel** and the FastAPI backend on **Render** (free web service, Docker).

## Why two hosts

The frontend is a static Next.js build (both routes prerender), which is exactly what Vercel's free Hobby plan serves best.
The backend cannot run on Vercel's serverless functions:

- it keeps a WebSocket open to every browser (`/ws/events`), which serverless functions do not hold;
- it is a long-lived process with in-memory state (event bus, perception queue, duplicate detection, motion controller);
- it writes SQLite and frame files to disk, and runs OpenCV and numpy, which are heavy for a function bundle.

Render's free plan runs a Docker container as a normal long-lived process with WebSockets, which matches the backend.

| Option for the backend | Fit |
|---|---|
| Render free web service | Chosen: Docker, WebSockets, blueprint in `render.yaml`; sleeps after 15 idle minutes, about a minute to wake; disk resets on restart; 750 free instance hours a month |
| Hugging Face Spaces (Docker) | Good hardware, but the current Hub docs say Docker Spaces need a paid plan to create; check before relying on it |
| Koyeb free instance | Works similarly; scales to zero after an hour idle; one free service |
| Google Cloud Run | Free tier with WebSockets, but needs a billing account |
| Fly.io, Railway | No ongoing free tier for new accounts |

Free tiers change often; the comparison above was checked in November 2026.

## What the free backend means for a demo

- **Cold start:** after 15 minutes without traffic the backend sleeps; the next visit wakes it in about a minute. Mission control shows the backend OFFLINE until then and switches to ONLINE by itself. Open the site a minute before a demo.
- **No persistence:** the disk is ephemeral, so missions, frames and reports reset on every restart, redeploy or sleep. Export reports (JSON or Markdown) you want to keep. A persistent disk needs a paid Render instance.
- **One instance, 512 MB:** enough for the offline pipeline and the Meta API clients, which do the heavy model work remotely.
- The twin, the walkthrough and the tour run entirely in the browser and work even while the backend sleeps.

## 1. Backend on Render

1. Push the repository to GitHub.
2. In the Render dashboard choose New, then Blueprint, and select the repository. Render reads `render.yaml` and creates `aquasentinal-backend` on the free plan from `backend/Dockerfile` (build context: the repository root; `.dockerignore` sends only `backend/` and `shared/`).
3. Fill in the values the blueprint asks for:
   - `CORS_ORIGINS`: the production frontend URL, for example `https://aquasentinal.vercel.app` (comma-separated if there are several).
   - `CORS_ORIGIN_REGEX`: optional, for Vercel preview deployments, for example `https://aquasentinal-[a-z0-9-]+\.vercel\.app` (a full match is required, so look-alike domains are refused).
   - `MODEL_API_KEY`: optional; leave empty for labelled offline mode. It stays on the server and is never sent to the browser.
4. Wait for the deploy, then check `https://<service>.onrender.com/api/health` returns `{"status":"ok",...}`.

The container runs as an unprivileged user, listens on Render's `$PORT`, trusts the proxy's forwarded headers, and has a health check on `/api/health`.
Hardware stays disabled (`APP_MODE=SIMULATION`, `AQUA_HARDWARE_ENABLE=false`).

## 2. Frontend on Vercel

1. In Vercel, Add New, then Project, and import the repository. `vercel.json` already sets the framework, `npm ci`, a build that runs typecheck, lint and `next build`, security headers, and skips rebuilds for backend-only or docs-only commits.
2. Under Environment Variables add `NEXT_PUBLIC_BACKEND_URL` = the Render URL, for example `https://aquasentinal-backend.onrender.com` (no trailing slash), for Production and Preview.
   It is inlined at build time, so redeploy after changing it. A Vercel build without it fails on purpose, with a message saying what to set, instead of shipping a site that points visitors at their own localhost.
3. Deploy, then put the production URL into the backend's `CORS_ORIGINS` on Render if you had not already.

With the CLI instead of the dashboard:

```bash
npx vercel link
npx vercel env add NEXT_PUBLIC_BACKEND_URL production   # paste the Render URL
npx vercel env add NEXT_PUBLIC_BACKEND_URL preview
npx vercel --prod
```

## 3. Check the deployment

- Open the Vercel URL: the Backend chip turns ONLINE (give a sleeping backend a minute) and the AI chip shows OFFLINE or META LIVE depending on the key.
- Scene 08 (Intelligence): the judge preflight lists every dependency.
- Plan the example instruction in scene 05 and approve it; the report appears in scene 07.
- `/walkthrough` renders over the twin.

## Verified locally

Before writing this guide the deployment shape was exercised without Docker or accounts:
the files the `.dockerignore` lets through were copied to a clean directory, `backend/requirements.txt` was installed into a fresh Python 3.13 environment, and the server was started with the image's exact command and `PORT`;
health, status, preflight and history answered, the configured origin and a preview origin were allowed and a foreign origin refused, and the event WebSocket sent its hello.
A production build (`NEXT_PUBLIC_BACKEND_URL` pointing at that server, served with `next start` on a different origin) loaded, showed the backend ONLINE, planned a mission through it and rendered the walkthrough with no console errors.
The Docker image itself was not built here (Docker is not installed on the development machine); Render builds it on deploy.
