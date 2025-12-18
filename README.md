# Beamed Admin & Solver + Discord DM Tool Integration

In-memory backend with admin/solver UIs, a Playwright middleman, and a Discord mass-DM tool wired to forward captchas.

## Prerequisites
- Node.js 18+
- (Optional) Python 3.10+ if using Playwright middleman
- `.env` in repo root with `ADMIN_PASSWORD` (e.g., `ADMIN_PASSWORD=error111`)

## Backend (serves HTML + API)
From repo root:
```
npm install
npm start
```
Defaults: `PORT=8000`, `ALLOWED_ORIGINS` empty (allow all).

### Key URLs
- Admin dashboard: `http://localhost:8000/admin`
- Solver UI: `http://localhost:8000/captcha-solver`
- Google reCAPTCHA manual test: `http://localhost:8000/recaptcha-test`

### API Summary (in-memory)
- Admin auth: `POST /api/admin/login { password }` -> `session_id`
- Admin stats: `GET /api/admin/stats?session_id=...`
- Admin actions: `POST /api/admin/reset-worker`, `remove-worker`, `reset-all-workers` (need session)
- Tasks:
  - Ingest: `POST /api/tasks` { siteKey, rqdata? }
  - Solver report: `POST /api/solve-task` { taskId, token, workerId }
  - Poll result: `GET /api/task-result?taskId=...`
  - List (admin): `GET /api/tasks?session_id=...`
- WS: same host; query `workerId`, `name`, `deviceInfo`; supports `refresh` and `solved` messages.

Data is in-memory; restart clears tasks/workers/sessions.

## Admin Manual Solve (live hCaptcha)
In the dashboard stats area, “Manual Solve (live tasks)” renders the first pending task’s real hCaptcha (sitekey/rqdata). Solve it and click “Submit Token” to post to `/api/solve-task` as `workerId: admin-manual`.

## Solver UI
Open `http://localhost:8000/captcha-solver`. It pulls unassigned tasks (or those assigned to its workerId) and reports via WS/HTTP.

## Mock Discord-style task sender
From repo root:
```
$env:API_BASE="http://localhost:8000"   # optional
node mock-discord-captcha.js
```
Creates a task with the hCaptcha test sitekey (no assignment so any worker can solve).

## Discord DM Tool (forwards captchas)
Location: `tool/`
1) Files required in `tool/`: `tokens.txt` (one token/line), `serverId.txt` (single line), `members.txt` (one user ID/line).
2) Install deps:
```
cd tool
npm install
```
3) Run (forwards captchas to backend `/api/tasks`):
```
$env:API_BASE="http://localhost:8000"   # optional if using default
node dm.js
```
When Discord presents an hCaptcha, it POSTs `{ siteKey, rqdata? }` to the backend. Solver/admin can then handle it.

## Playwright Middleman (optional)
File: `middleman.py`
Purpose: Detect hCaptcha on an arbitrary page, send to `/api/tasks`, poll `/api/task-result`, inject token.

Setup:
```
pip install playwright requests
python -m playwright install chromium
```
Run (example):
```
$env:API_BASE="http://localhost:8000"
$env:PAGE_URL="https://your-target-page.example"
# optional: $env:WORKER_ID, $env:SUBMIT_SELECTOR
python middleman.py
```

## Google reCAPTCHA Test Page
`/recaptcha-test` lets you enter a real reCAPTCHA site key, render the widget, and copy the token. It does not auto-submit; use tokens for your own verification flow.

## Notes & Tips
- If solver shows “No tasks assigned”: ensure tasks are posted without `assigned_to`, or match the solver’s `workerId`.
- Admin endpoints require `session_id`; log in via `/api/admin/login` or through the admin UI.
- Keep backend running to avoid losing in-memory data.

