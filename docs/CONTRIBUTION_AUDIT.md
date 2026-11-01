# Contribution audit

This audit records where the code came from and how the Git history was produced, so a reviewer can check originality without trusting commit messages alone.

## Source and starting point

| Item | Value |
|---|---|
| HydraLoom repository | https://github.com/DEEPESH-845/HydraLoom |
| HydraLoom source commit | `d59308e17ff483a54512bc340f6351e779fb26e7`, 2026-09-15, 32 commits since 2026-05-25 |
| HydraLoom checkout used | `../reference/HydraLoom`, push URL disabled, never modified |
| AquaSentinal repository | https://github.com/DEEPESH-845/AquaSentinal |
| AquaSentinal work started | 2026-11-01 |
| Initial AquaSentinal state | No repository existed before 2026-11-01; HydraLoom files were copied into a fresh directory and extended |
| First AquaSentinal commit | `f7b4acc` chore: initialize Next.js project manifest |

## How the Git history was created (read this before reading `git log`)

- The first 49 commits (`f7b4acc` to `c4628ca`) were all created on 2026-11-02 between 03:22:45 and 03:22:46 +0530, after the work of 2026-11-01 was complete.
- They split one finished working tree into logical commits by area; they are not a record of the order in which work happened.
- Several of those commits add inherited HydraLoom files under a `feat:` prefix, for example `72fdd08 feat(lab): add aquarium, gantry and electronics models` adds three files that are byte-identical to HydraLoom.
  Commit messages therefore do not distinguish inherited from new code.
- History has not been rewritten to change this, and no timestamps have been altered.
- Use `docs/evidence/provenance.tsv` (regenerate with `scripts/provenance.sh`) and docs/HACKATHON_CONTRIBUTIONS.md to judge origin, not commit prefixes.
- Commits from `0590788` onward were made one logical change at a time as the work happened.

## Inherited files (byte-identical to HydraLoom)

`app/favicon.ico`, `app/page.tsx`, `components/lab/Aquarium.tsx`, `components/lab/CameraRig.tsx`, `components/lab/Electronics.tsx`, `components/lab/Gantry.tsx`, `lib/sim/detection.ts`, `lib/sim/gantry.ts`, `lib/sim/policy.ts`, `lib/sim/rng.ts`, `next.config.ts`, `postcss.config.mjs`, `tsconfig.json`, and `package-lock.json` until it was resynchronised with the renamed package on 2026-11-02.

## Substantially modified HydraLoom files

Line counts are additions and removals against the source file, from `provenance.tsv`.

| File | Source lines | Added | Removed | New functionality |
|---|---:|---:|---:|---|
| `lib/sim/engine.ts` | 490 | 515 | 11 | MISSION mode executing compiled plans, capture queue, adaptive visibility controller, re-observation, latching e-stop, disturbances, environment telemetry, mission result |
| `lib/sim/types.ts` | 135 | 146 | 3 | Inspection classes, mission plan, perception state, capture request, mission result types |
| `lib/sim/scenario.ts` | 90 | 100 | 79 | Pipeline layout, presets A to J |
| `lib/sim/selfcheck.ts` | 595 | 200 | 32 | Missions, perception, fixture sections; HydraLoom sections kept on the reference scenario |
| `components/ui/scenes.tsx` | 632 | 189 | 427 | RL control and result cards removed; environment comparison and service status added |
| `components/lab/TestObjects.tsx` | 323 | 171 | 6 | Pipe, flange, valve, cable, rope, wrench, panel models |
| `e2e/redteam.spec.ts` | 98 | 174 | 73 | Hostile instruction text, reset during mission, e-stop spam, demo interrupts |
| `components/ui/CameraFeed.tsx` | 117 | 73 | 33 | SIM labels on detector boxes, no-signal state, perception badge |
| `lib/sim/store.ts` | 165 | 71 | 7 | Mission, preset, e-stop and demo actions, scene 08 |
| `components/ui/LabUI.tsx` | 185 | 60 | 29 | New scenes, status chips, e-stop, provenance badges, backend bridge |
| `components/lab/Overlays.tsx` | 413 | 54 | 5 | Mission target ring, plan path overlay |

`README.md` (60 added, 69 removed) is rewritten; `vercel.json` is adapted (microphone allowed for push-to-talk, frontend-only build command); the remaining modified files change by a few lines (imports, metadata, configuration).

## New files

All of `backend/app/` and `backend/tests/` (FastAPI service, Meta clients, mission compiler and tools, perception pipeline, tracking, quality, hardware drivers, SQLite repository, reporting, evaluation), `lib/api/`, `lib/audio/`, `lib/store/`, `lib/hackathon/`, `lib/sim/perception.ts`, `compare.ts`, `fixtures.ts`, `components/lab/capture.ts`, `components/ui/mission.tsx`, `perception.tsx`, `report.tsx`, `bridge.tsx`, `intelligence.tsx`, `shared/`, `scripts/`, `public/demo/instruction.wav`, the new e2e specs (`backend-offline`, `environment`, `estop`, `intelligence`, `mission`, `perception`) and everything under `docs/` except where noted in MIGRATION_MAP.md.
The full list is the NEW rows of `docs/evidence/provenance.tsv`.

## Commits made under the hackathon directive (2026-11-02)

| Commit | Change |
|---|---|
| `0590788` | fix(perception): reuse a near-duplicate segmentation only for identical inputs and a successful result |
| `e353590` | feat(hackathon): log every Meta model execution and add a judge preflight (also carries the `DEMO_SCRIPT.md` to `FINAL_DEMO_SCRIPT.md` rename, staged early by mistake) |
| `10deb72` | feat(hackathon): add contribution registry and per-file provenance against HydraLoom |
| `4c452e0` | feat(demo): add the new inspection intelligence view and judge demo mode |
| `474af28` | test(hackathon): add reproducible evaluation of parsing, segmentation and adaptive control |
| `a9d8fcc` | docs(hackathon): add contribution, evidence, evaluation, impact, judging and demo documents |
| later | see `git log --oneline a9d8fcc..` |

The table is completed by `git log --oneline 0590788^..HEAD`; this file is not regenerated automatically.

## Consistency checks

- `scripts/provenance.sh` refuses to run unless the HydraLoom checkout is at the recorded commit.
- The IDENTICAL, MODIFIED and NEW counts quoted in docs/HACKATHON_CONTRIBUTIONS.md come from the same TSV and must be refreshed after adding files.
- No HydraLoom file was modified in `../reference/HydraLoom` (`git -C ../reference/HydraLoom status` is clean).
