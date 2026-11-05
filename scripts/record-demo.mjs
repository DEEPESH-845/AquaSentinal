// Scripted product demo: drives the real app (prod build + local backend) and records 1920x1080 video.
// Usage: SITE=http://localhost:3000 API=http://localhost:8000 node scripts/record-demo.mjs <out-dir>
// Writes <out>/raw.webm and <out>/marks.json (segment boundaries in seconds; speed up wait-start..wait-end in post).
// Captions describe offline mode; edit them once MODEL_API_KEY is set so they match what the panels show.
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("@playwright/test");

const SITE = process.env.SITE ?? "http://localhost:3200";
const API = process.env.API ?? "http://localhost:8200";
const OUT = process.argv[2] ?? "demo-out";
fs.mkdirSync(OUT, { recursive: true });

const overlay = () => {
  const css = `
  #dm-cur{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
    background:rgba(255,255,255,.18);border:2px solid rgba(255,255,255,.9);box-shadow:0 0 0 1px rgba(0,0,0,.35),0 4px 14px rgba(0,0,0,.4);
    pointer-events:none;transition:transform .12s ease,background .12s ease;left:-50px;top:-50px}
  #dm-cur.down{transform:scale(.72);background:rgba(45,212,191,.55)}
  #dm-cap{position:fixed;z-index:2147483646;left:50%;top:76px;transform:translate(-50%,-8px);opacity:0;pointer-events:none;
    transition:opacity .5s ease,transform .5s ease;text-align:center;max-width:1100px;padding:14px 26px;border-radius:14px;
    background:rgba(8,14,22,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    border:1px solid rgba(94,234,212,.22);box-shadow:0 18px 50px rgba(0,0,0,.45);font-family:var(--font-inter),Inter,system-ui,sans-serif}
  #dm-cap.on{opacity:1;transform:translate(-50%,0)}
  #dm-cap .k{font:600 11px/1 var(--font-plex-mono),ui-monospace,monospace;letter-spacing:.22em;color:#5eead4;text-transform:uppercase;margin-bottom:8px}
  #dm-cap .t{font-size:24px;line-height:1.3;color:#f1f5f9;font-weight:500;letter-spacing:-.01em}
  #dm-card{position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;justify-content:center;flex-direction:column;
    background:radial-gradient(1200px 700px at 50% 40%,rgba(13,36,48,.94),rgba(3,7,12,.985));opacity:0;pointer-events:none;
    transition:opacity .9s ease;font-family:var(--font-inter),Inter,system-ui,sans-serif;color:#f1f5f9;text-align:center}
  #dm-card.on{opacity:1}
  #dm-card .eyebrow{font:600 13px/1 var(--font-plex-mono),ui-monospace,monospace;letter-spacing:.32em;color:#5eead4;text-transform:uppercase}
  #dm-card h1{font-size:92px;font-weight:600;letter-spacing:-.035em;margin:22px 0 10px;
    background:linear-gradient(180deg,#ffffff,#9adfe0);-webkit-background-clip:text;background-clip:text;color:transparent}
  #dm-card h2{font-size:44px;font-weight:500;letter-spacing:-.02em;margin:20px 0 8px;max-width:1300px;line-height:1.2}
  #dm-card p{font-size:26px;color:#a7b4c2;margin:8px 0;max-width:1200px;line-height:1.45}
  #dm-card .row{display:flex;gap:16px;margin-top:34px;justify-content:center;flex-wrap:wrap}
  #dm-card .pill{font:500 15px/1 var(--font-plex-mono),ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;
    padding:13px 18px;border:1px solid rgba(94,234,212,.35);border-radius:999px;color:#ccfbf1;background:rgba(20,184,166,.08)}
  #dm-card .line{width:120px;height:2px;margin:26px auto 0;background:linear-gradient(90deg,transparent,#5eead4,transparent)}
  #dm-card .small{font:500 15px/1.5 var(--font-plex-mono),ui-monospace,monospace;color:#7c8a99;letter-spacing:.06em;margin-top:30px}
  `;
  const install = () => {
    if (document.getElementById("dm-cur")) return;
    const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s);
    const cur = document.createElement("div"); cur.id = "dm-cur"; document.body.appendChild(cur);
    const cap = document.createElement("div"); cap.id = "dm-cap"; document.body.appendChild(cap);
    const card = document.createElement("div"); card.id = "dm-card"; document.body.appendChild(card);
    addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => cur.classList.add("down"), true);
    addEventListener("mouseup", () => cur.classList.remove("down"), true);
    window.__cap = (k, t) => {
      if (!t) { cap.classList.remove("on"); return; }
      cap.classList.remove("on");
      setTimeout(() => { cap.innerHTML = `<div class="k">${k}</div><div class="t">${t}</div>`; cap.classList.add("on"); }, k === cap.dataset.k ? 0 : 250);
      cap.dataset.k = k;
    };
    window.__card = (html) => { cur.style.opacity = html ? "0" : "1"; if (html) { card.innerHTML = html; card.classList.add("on"); } else card.classList.remove("on"); };
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install); else install();
};

const browser = await chromium.launch({ headless: false, args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--window-size=1920,1160"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
await ctx.addInitScript(overlay);
const page = await ctx.newPage();
const t0 = Date.now();
const marks = [];
const mark = (name) => { marks.push({ name, t: (Date.now() - t0) / 1000 }); console.log("mark", name, marks.at(-1).t.toFixed(1)); };
const wait = (ms) => page.waitForTimeout(ms);
const cap = async (k, t) => page.evaluate(([k, t]) => window.__cap(k, t), [k, t]);
const card = async (html) => page.evaluate((h) => window.__card(h), html);
let mx = 960, my = 540;
const moveTo = async (x, y, steps = 28) => { await page.mouse.move(x, y, { steps }); mx = x; my = y; };
const click = async (loc, pause = 350) => {
  await loc.scrollIntoViewIfNeeded();
  const b = await loc.boundingBox();
  await moveTo(b.x + b.width / 2, b.y + b.height / 2);
  await wait(pause);
  await page.mouse.down(); await wait(90); await page.mouse.up();
};
const nav = () => page.locator("nav[aria-label='Scenes']");
const scene = (n) => click(nav().getByRole("button", { name: new RegExp("^0" + n) }));
const drag = async (x1, y1, x2, y2, steps = 90) => { await moveTo(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps }); await page.mouse.up(); mx = x2; my = y2; };

try {
  await page.goto(SITE);
  await page.locator("canvas").first().waitFor({ timeout: 60_000 });
  await page.getByTestId("chip-backend").filter({ hasText: "ONLINE" }).waitFor({ timeout: 60_000 });
  await card(`<div class="eyebrow">Meta hackathon - AI for the physical world</div><h1>AquaSentinal</h1>
    <p>Describe an underwater inspection in plain words. Meta models plan it, see it, and explain it.</p>
    <div class="row"><span class="pill">Muse Spark</span><span class="pill">SAM 3.1</span><span class="pill">Voice Transcribe</span></div>`);
  await wait(1500);
  mark("start");
  await wait(4200);
  await card(`<div class="eyebrow">The problem</div><h2>Pipelines, hulls and dams are still inspected by divers squinting through murky water.</h2>
    <p>It is slow, risky, and the findings live in someone's notes.</p><div class="line"></div>`);
  await wait(5200);
  await card(`<div class="eyebrow">The idea</div><h2>An inspection rig you can talk to, that adapts to the water and proves every finding.</h2>
    <p>Shown here on a live digital twin of a camera gantry over a pipeline test tank.</p><div class="line"></div>`);
  await wait(5200);
  await card(null);
  await wait(900);

  // 1. the twin
  await cap("Digital twin", "A real-time twin of the gantry rig: XY camera carriage, test tank, pipeline and planted defects.");
  await drag(1100, 600, 820, 560, 140);
  await wait(800);
  await drag(820, 560, 1000, 600, 110);
  await wait(1500);

  // 2. credits + honesty
  await cap("Meta credits, governed", "Every Meta call passes a governor: response cache, a hard budget cap and a passcode live lock.");
  await click(page.getByTestId("chip-credits"));
  await page.getByTestId("credits-popover").waitFor();
  await wait(4200);
  await page.keyboard.press("Escape");
  await wait(600);
  await cap("Honest by design", "No key is set in this recording, so every panel says OFFLINE. Nothing is shown as live Meta output unless a live call was logged.");
  await wait(5200);

  // 3. scenario, then mission in Hindi/English
  await scene(6);
  await cap("Test scenarios", "Ten reproducible scenarios. This one clouds the water halfway through the inspection.");
  await click(page.getByRole("button", { name: /turbidity increase/i }));
  await wait(3200);
  await scene(5);
  await wait(900);
  await cap("Speak or type the inspection", "Muse Spark turns plain language into a structured mission through allowlisted tools, in English or Hindi.");
  const hi = page.getByRole("radio", { name: /हिन्दी/ }).or(page.getByRole("button", { name: /हिन्दी/ })).first();
  await click(hi);
  await wait(2600);
  await cap("Hindi and Hinglish", "Voice Transcribe is biased to Hindi and English. Offline, the app says plainly that Hindi needs Meta models.");
  await wait(3800);
  await click(page.getByRole("radio", { name: /^EN$/ }).or(page.getByRole("button", { name: /^EN$/ })).first());
  await wait(600);
  const box = page.locator("textarea").first();
  await click(box);
  await page.keyboard.type("Inspect the pipeline left to right for loose cables and foreign objects.", { delay: 34 });
  await wait(700);
  await cap("Plan", "The backend validates the plan and compiles bounded waypoints. Nothing moves until a human approves.");
  await click(page.getByRole("button", { name: /plan mission/i }));
  await page.getByRole("button", { name: /approve and run/i }).waitFor({ timeout: 60_000 });
  await wait(4500);
  await click(page.getByRole("button", { name: /approve and run/i }));
  mark("run");
  await cap("Execute", "The gantry scans the pipeline. The camera feed and telemetry are live from the twin.");
  await wait(6000);

  // 4. adaptive control while running
  await scene(6);
  await cap("Adaptive control", "The water turns murky. Below the safe visibility threshold the controller slows, then pauses for the operator. Deterministic logic, not the model.");
  await moveTo(760, 900);
  await wait(4000);
  console.log("turbidity now", await page.locator("input[type=range]").first().inputValue());
  await wait(5500);
  await scene(4);
  await cap("Navigation", "Bounded waypoints, soft limits and an E-stop. The model never drives the motors directly.");
  await wait(5000);
  await scene(1);
  await cap("Scanning", "The mission keeps running. Fast-forwarding to the end.");
  mark("wait-start");
  const tWait = Date.now();
  let status = "";
  while (Date.now() - tWait < 600_000) {
    const list = await (await fetch(`${API}/api/missions`)).json();
    const arr = Array.isArray(list) ? list : list.missions ?? list.items ?? [];
    const m = arr.sort((a, b) => String(b.createdAt ?? b.created_at).localeCompare(String(a.createdAt ?? a.created_at)))[0];
    status = m?.status ?? "?";
    if (status === "COMPLETED" || status === "ABORTED") break;
    await wait(2000);
  }
  mark("wait-end");
  console.log("mission status", status);
  await wait(1500);
  await scene(3);
  await cap("SAM 3.1 perception", "Each capture is segmented. Masks are tracked across frames, so one cable is one finding, not twenty.");
  await wait(6500);

  // 5. report + ask
  await scene(7);
  await page.getByRole("heading", { name: /Inspection report/ }).waitFor({ timeout: 30_000 });
  await cap("Evidence report", "Every finding links to its frame, mask, track and the model execution that produced it.");
  await wait(5000);
  const ask = page.getByTestId("ask-panel");
  await ask.scrollIntoViewIfNeeded();
  await cap("Ask the inspector", "Ask a question. Muse Spark answers with read-only tools, and every claim must cite a capture.");
  await wait(2500);
  await click(page.getByTestId("ask-suggestion").first());
  await page.getByTestId("ask-answer").first().waitFor({ timeout: 30_000 });
  await wait(4500);
  const cite = page.getByTestId("ask-citation").first();
  if (await cite.count()) {
    await cap("Cited, then shown", "Click a citation and the twin flies to that asset.");
    await click(cite);
    await wait(5000);
  }
  const wo = page.getByTestId("workorders-panel");
  if (await wo.count()) {
    await wo.scrollIntoViewIfNeeded();
    const gen = page.getByTestId("workorders-generate");
    if (await gen.count()) { await click(gen); await wait(2500); }
    await cap("Work orders", "Findings become prioritised, field-ready work orders with evidence, and print cleanly in one click.");
    await moveTo(960, 700);
    await wait(6000);
  }

  // 6. intelligence + system
  await scene(8);
  await cap("Inspection intelligence", "Each step shows exactly where its output came from: Meta model, cache, offline rule or simulation.");
  await wait(6500);
  await scene(2);
  await cap("System", "Provider status, hardware path and safety, all visible. Plug in a key and the same flow runs on live Meta models.");
  await wait(5500);
  await cap("", "");
  await card(`<div class="eyebrow">AquaSentinal</div><h2>Talk to the rig. Trust the findings.</h2>
    <div class="row"><span class="pill">Muse Spark - plans and explains</span><span class="pill">SAM 3.1 - sees</span><span class="pill">Voice Transcribe - listens</span></div>
    <div class="small">aquasentinal-meta.vercel.app<br/>Recorded in offline mode; every output is labelled by its source.</div>`);
  await wait(6500);
  mark("end");
} catch (e) {
  console.log("FAIL", e.message);
  await page.screenshot({ path: `${OUT}/fail.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(`${OUT}/marks.json`, JSON.stringify(marks, null, 2));
  const v = page.video();
  await ctx.close();
  if (v) fs.renameSync(await v.path(), `${OUT}/raw.webm`);
  await browser.close();
}
