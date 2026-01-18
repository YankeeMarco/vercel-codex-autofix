# Next.js Runtime Harness (Test Base Container)

This repository provides a **fixed, lightweight Docker image** acting as a **stable Next.js runtime harness** (test base container).  

It serves as an isolated, reproducible environment for testing any Next.js project — especially the `business_repo` repository — without baking application code into the image.

- **Image** = Fixed test platform (Node.js + pnpm + minimal utils)  
- **Volume** = The actual code under test (mounted at runtime)

Perfect for agent-driven debugging (e.g. Codex), iterative fixes, regression testing, and MCP/web-based access.

## Features

- Based on official `node:24.13.0-alpine` (latest in 24.x LTS "Krypton" branch as of Jan 2026)
- pnpm installed & activated via corepack (latest version)
- Minimal system dependencies for Next.js compatibility
- No business code included — 100% generic
- Exposes port 3000 consistently
- All output to stdout (easy `docker logs`)
- Designed for volume-mounted Next.js projects

## Prerequisites

- Docker installed
- Docker permissions for the user/agent (e.g. `sudo usermod -aG docker $USER`)
- Your Next.js project repository (e.g. `/Users/your-hostname/Documents/business_repo`)

## Dockerfile

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24.13.0-alpine

# Minimal system utilities needed for most Next.js projects
RUN apk add --no-cache bash libc6-compat git openssh

# Working directory for mounted project
WORKDIR /workspace

# Enable & prepare latest pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Standard Next.js runtime environment variables
ENV NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    PNPM_HOME=/root/.local/share/pnpm \
    PNPM_STORE_PATH=/pnpm-store

EXPOSE 3000

# No default command — overridden at runtime
CMD ["sh"]
```

## Building the Image

From this repository root:

```bash
docker build -t nextjs-harness:node24 .
```

→ Builds once (or rarely), acts like a "test OS"

## Usage – Testing a Next.js Project (e.g. business_repo)

Replace `/Users/your-hostname/Documents/business_repo` with your actual project path.

### 1. Quick Dev Mode Test (Interactive)

```bash
docker run --rm -it \
  -p 3000:3000 \
  -v /Users/your-hostname/Documents/business_repo:/workspace \
  -v pnpm-cache:/pnpm-store \
  -w /workspace \
  --health-cmd="curl -f http://localhost:3000 || exit 1" \
  --health-interval=5s \
  nextjs-harness:node24 \
  sh -c "pnpm install && pnpm dev"
```

### 2. Build + Production Start Test

```bash
docker run --rm -it \
  -p 3000:3000 \
  -v /Users/your-hostname/Documents/business_repo:/workspace \
  -v pnpm-cache:/pnpm-store \
  -w /workspace \
  --health-cmd="curl -f http://localhost:3000 || exit 1" \
  --health-interval=5s \
  nextjs-harness:node24 \
  sh -c "pnpm install && pnpm build && pnpm start"
```

### 3. Background Run (ideal for agents / Codex)

```bash
docker run -d \
  --name your-business-test \
  -p 3000:3000 \
  -v /Users/your-hostname/Documents/business_repo:/workspace \
  -v pnpm-cache:/pnpm-store \
  -w /workspace \
  --health-cmd="curl -f http://localhost:3000 || exit 1" \
  --health-interval=5s \
  nextjs-harness:node24 \
  sh -c "pnpm install && pnpm dev"

# Follow logs in real-time
docker logs -f your-business-test

# Check container health
docker inspect --format "{{json .State.Health}}" your-business-test
```

Stop & clean up:
```bash
docker stop your-business-test && docker rm your-business-test
```

## For Codex / Automation Agents

Recommended prompt snippet:

```
You control a fixed Next.js runtime harness image: nextjs-harness:node24
Mount the project under test at /workspace.
Use persistent pnpm cache: -v pnpm-cache:/pnpm-store
Always include healthcheck: --health-cmd="curl -f http://localhost:3000 || exit 1" --health-interval=5s

Default flow:
1. docker run -d ... sh -c "pnpm install && pnpm dev"
2. Monitor logs + health + port 3000
3. On failure → analyze logs → suggest fixes to project code → re-run

Output structured JSON per phase:
{"phase": "install|dev|build|start", "status": "success|fail", "logs": "...", "suggested_fixes": [...]}
```

## Why This Design?

- Complete decoupling: runtime environment ≠ application code
- Fast iteration: pnpm cache survives across runs
- Reliable health signals for MCP/agents
- Isolated from host OS quirks (FSEvents, permissions, etc.)
- Professional-grade test harness for AI-driven development & CI

Happy debugging & auto-fixing! 🚀