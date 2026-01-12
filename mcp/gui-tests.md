# GUI intent spec for MCP Playwright

**Target URL:**  
https://zedavideo.vercel.app

## Critical flows

### 1. Homepage loads
- Open the root URL.
- Page title should contain “Zeda”.
- There must be no visible error banner, alert, or toast containing “error”/“failed”.

### 2. Sign-in flow
- Navigate to `/login`.
- Enter invalid credentials (e.g., `invalid@example.com` / `bad-password`).
- An inline error message should appear.
- The browser must remain on `/login` after submitting.

### 3. Pricing page
- Navigate to `/pricing`.
- A pricing card labeled “Pro” should be visible.
- The “Start trial” button inside that card must be enabled/clickable.

## Failure rules
- Missing critical copy.
- Navigation errors / unexpected redirects.
- Disabled or missing CTA buttons.
- Error banners or console text rendered in the UI.

## Output expectations
- Produce a short PASS/FAIL list for every scenario.
- When a failure occurs, include the element/selector name and the active URL in the report.
