# Desenvolvimento com Podman

Este projeto usa `pnpm`, mas o fluxo recomendado nao exige instalar `pnpm`, Node.js ou Postgres no host.

## Subir ambiente

```bash
podman compose -f .devcontainer/compose.yml up -d
podman compose -f .devcontainer/compose.yml exec app pnpm install --frozen-lockfile
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm db:migrate
podman compose -f .devcontainer/compose.yml exec app pnpm dev --host 0.0.0.0
```

Acesse `http://localhost:5173`.

## Rodar verificacoes

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm verify
```

## Rodar E2E

```bash
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm test:e2e
```

## Resetar banco local

```bash
podman compose -f .devcontainer/compose.yml down -v
podman compose -f .devcontainer/compose.yml up -d
podman compose -f .devcontainer/compose.yml exec app pnpm install --frozen-lockfile
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm db:migrate
```
