# Example NLP Testing Brief for MCP

This demo brief shows how you might describe desired regression checks in plain English so an MCP server (or a teammate) can translate them into the structured `mcp-playwright-plan.json`. Adjust the wording to match your product’s terminology.

---

## Scenario A — Contact form lead capture

- **Audience in plain language:** “As a first‑time visitor, I want to reach the `/contact` page and submit the lead form so that sales receives my message.”
- **Route expectations:** Navigating to `/contact` should render the marketing contact form with the hero headline “Talk to sales”.
- **Happy-path steps:**
  1. Open the contact page from a clean session.
  2. Wait for the form that has `data-test="contact-form"` to appear.
  3. Fill the name, email, and message fields with realistic looking data.
  4. Submit via the button that carries `data-test="contact-submit"`.
- **Success criteria:** A success banner with `data-test="contact-success"` appears and contains a thank-you message (“Thanks” or similar).
- **Failure signals:** Missing selectors, validation errors, or network failures should abort the scenario immediately so Codex can inspect the generated logs.

## Scenario B — Authenticated avatar upload

- **Audience in plain language:** “As an existing customer, I should be able to log in and update my profile picture.”
- **Route expectations:** Starting at `/login`, entering valid credentials should redirect me to `/dashboard/profile`.
- **Happy-path steps:**
  1. Load the login page and wait for `data-test="login-form"`.
  2. Fill the email/password fields (see `.env.local` test credentials).
  3. Submit with `data-test="login-submit"` and wait for the dashboard profile shell (`data-test="profile-page"`).
  4. Attach `playwright/fixtures/avatar.png` to the avatar file input.
  5. Press the save button (`data-test="profile-save"`).
- **Success criteria:** The toast region (`data-test="toast"`) should mention “Profile updated” and the avatar preview should show the newly uploaded file.
- **Failure signals:** Any validation prompt, network error, or missing toast should stop the run and emit logs for Codex repair.

## Scenario C — File upload validation edge case (optional)

- **Audience:** “As a user, I should receive a friendly error when I upload an unsupported file format.”
- **Expectations:**
  1. Navigate to `/dashboard/profile`.
  2. Attempt to upload a `.txt` file.
  3. Verify that the form displays the validation text “Unsupported file type” near the file input.
- **Success criteria:** The profile should **not** update, and the validation text must be visible so the front-end change is verifiable.

---

Use this brief as a template when communicating with your MCP server: paste it into the MCP request so it can derive selectors, actions, and assertions before writing to `mcp-playwright-plan.json`.
