# Writing NLP briefs for MCP Playwright

Use this guide when you want to describe regression checks in plain English before converting them into `mcp-playwright-plan.json`. The goal is to tell an MCP server (or another teammate) exactly what the smoke tests should cover without touching code.

1. Start with a short scenario summary (“As a user I can submit the contact form”).
2. Specify the route/URL the scenario should start on.
3. List the key steps in order (click this button, fill that field, upload this file).
4. State the exact success signal (toast text, redirect, DOM selector visibility).
5. Mention failure signals that should abort the run (validation errors, missing selectors, etc.).

See `testing_nlp_demo.md` for a concrete example you can copy/paste into an MCP request.
