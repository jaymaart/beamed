"""
Playwright-based middleman:
- Detects hCaptcha on the current page
- Sends sitekey/rqdata to backend /api/tasks
- Polls /api/task-result until solved
- Injects the token back into the captcha frame

Prereqs:
  pip install playwright requests
  python -m playwright install chromium

Env:
  API_BASE        (default: http://localhost:8000)
  PAGE_URL        (required) target page to automate
  WORKER_ID       (optional) assign task to a specific worker
  SUBMIT_SELECTOR (optional) CSS selector to click after solving
"""

import asyncio
import os
import time
from typing import Optional, Tuple
from urllib.parse import urlparse, parse_qs

import requests
from playwright.async_api import async_playwright, Frame, Page

API_BASE = os.getenv("API_BASE", "http://localhost:8000").rstrip("/")
PAGE_URL = os.getenv("PAGE_URL")
WORKER_ID = os.getenv("WORKER_ID")
SUBMIT_SELECTOR = os.getenv("SUBMIT_SELECTOR")

POLL_INTERVAL = 2
POLL_TIMEOUT = 120  # seconds


def submit_task(site_key: str, rqdata: Optional[str]) -> str:
    payload = {"siteKey": site_key}
    if rqdata:
        payload["rqdata"] = rqdata
    if WORKER_ID:
        payload["assigned_to"] = WORKER_ID
    resp = requests.post(f"{API_BASE}/api/tasks", json=payload, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(f"API error: {data}")
    return data["task"]["id"]


def poll_for_solution(task_id: str) -> str:
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        resp = requests.get(f"{API_BASE}/api/task-result", params={"taskId": task_id}, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if data.get("success") and data.get("status") == "solved":
            token = data.get("token")
            if token:
                return token
        time.sleep(POLL_INTERVAL)
    raise TimeoutError("No solution received before timeout")


async def find_hcaptcha(page: Page) -> Tuple[str, Optional[str], Frame]:
    # Look for iframe containing hcaptcha
    await page.wait_for_timeout(1000)
    for frame in page.frames:
        url = frame.url
        if "hcaptcha.com" in url:
            qs = parse_qs(urlparse(url).query)
            sitekey = qs.get("sitekey", [None])[0]
            rqdata = qs.get("rqdata", [None])[0] if "rqdata" in qs else None
            if sitekey:
                return sitekey, rqdata, frame
    # Fallback: data-sitekey in main frame
    elem = await page.query_selector("[data-sitekey]")
    if elem:
        sitekey = await elem.get_attribute("data-sitekey")
        rqdata = await elem.get_attribute("data-rqdata")
        return sitekey, rqdata, page.main_frame
    raise RuntimeError("No hCaptcha found on page")


async def inject_solution(frame: Frame, token: str):
    await frame.evaluate(
        """(tok) => {
            const ta = document.querySelector('textarea[name="h-captcha-response"]');
            if (ta) {
                ta.value = tok;
                ta.dispatchEvent(new Event('input', { bubbles: true }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
            }
            // Also update any hidden input if present
            const hidden = document.querySelector('input[name="h-captcha-response"]');
            if (hidden) {
                hidden.value = tok;
                hidden.dispatchEvent(new Event('input', { bubbles: true }));
                hidden.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }""",
        token,
    )


async def main():
    if not PAGE_URL:
        raise SystemExit("Set PAGE_URL env to the target page URL")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        page = await browser.new_page()
        print(f"[+] Navigating to {PAGE_URL}")
        await page.goto(PAGE_URL, wait_until="networkidle")

        sitekey, rqdata, frame = await find_hcaptcha(page)
        print(f"[+] Found hCaptcha sitekey={sitekey}, rqdata={rqdata}")

        task_id = submit_task(sitekey, rqdata)
        print(f"[+] Task submitted: {task_id}")

        token = poll_for_solution(task_id)
        print(f"[+] Received token, injecting...")
        await inject_solution(frame, token)

        if SUBMIT_SELECTOR:
            try:
                await page.click(SUBMIT_SELECTOR, timeout=3000)
                print(f"[+] Clicked submit selector: {SUBMIT_SELECTOR}")
            except Exception as exc:
                print(f"[!] Submit click failed: {exc}")

        await page.wait_for_timeout(5000)
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())

