# Development With Podman

This project uses `pnpm`, but the recommended local workflow does not require installing `pnpm`, Node.js or Postgres on the host machine.

## Start The Environment

```bash
podman compose -f .devcontainer/compose.yml up -d
podman compose -f .devcontainer/compose.yml exec app pnpm install --frozen-lockfile
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm db:migrate
podman compose -f .devcontainer/compose.yml exec app pnpm dev --host 0.0.0.0
```

Open `http://localhost:5173`.

## Run Verification

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm verify
```

## Run E2E Tests

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm test:e2e
```

## Run Quality Gates

The quality gates add screenshot regression, performance budget, infrastructure failure and smoke coverage on top of the functional E2E suite:

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm test:visual
podman compose -f .devcontainer/compose.yml exec app pnpm test:performance
podman compose -f .devcontainer/compose.yml exec app pnpm test:infrastructure
podman compose -f .devcontainer/compose.yml exec app pnpm test:smoke
podman compose -f .devcontainer/compose.yml exec app pnpm test:quality
```

Update visual baselines only after intentionally reviewing UI changes:

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright test \
  --config playwright.visual.config.ts \
  --update-snapshots
```

## Reset The Local Database

```bash
podman compose -f .devcontainer/compose.yml down -v
podman compose -f .devcontainer/compose.yml up -d
podman compose -f .devcontainer/compose.yml exec app pnpm install --frozen-lockfile
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm db:migrate
```
