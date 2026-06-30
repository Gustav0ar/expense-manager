# Expense Manager

Sistema web self-hosted para gestao de despesas, categorias, usuarios, dashboards, relatorios e planejamento financeiro.

## Stack

- SvelteKit 2 + Svelte 5
- PostgreSQL 18
- Drizzle ORM
- Better Auth
- Tailwind CSS 4
- pnpm 11
- Docker Compose + Caddy

## Recursos

- Autenticacao por email e senha
- Verificacao de email configuravel
- Recuperacao de senha por SMTP
- Workspaces multiusuario
- Papeis: owner, admin, member, viewer
- Categorias
- Despesas em BRL armazenadas em centavos
- Parcelamento de despesas
- Orcamentos por categoria com alertas
- Despesas recorrentes com geracao idempotente sob demanda
- Importacao CSV e OFX
- Anexos de comprovantes com download autenticado
- Upload e download de anexos por streaming
- Dashboard por periodo
- Relatorios por categoria, semana, mes, ano e pagamento
- Exportacao CSV
- Convites por email
- MFA/TOTP com recovery codes
- Auditoria de operacoes principais com tela dedicada
- Healthcheck com status do banco e duracao
- Backup diario com `pg_dump`, validacao e checksums SHA-256
- Script operacional de observabilidade do Postgres

## Desenvolvimento

O fluxo local recomendado usa Dev Container com Podman. Assim voce nao precisa instalar Node.js, pnpm ou Postgres na maquina.

### Com Dev Containers

Configure sua ferramenta de Dev Containers para usar Podman como runtime e abra este repositorio no container. O container executa:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm db:migrate
```

Depois, dentro do container:

```bash
pnpm dev --host 0.0.0.0
```

A aplicacao fica em `http://localhost:5173`.

### Com Podman Compose puro

Se preferir nao usar uma extensao de Dev Containers:

```bash
podman compose -f .devcontainer/compose.yml up -d
podman compose -f .devcontainer/compose.yml exec app pnpm install --frozen-lockfile
podman compose -f .devcontainer/compose.yml exec app pnpm exec playwright install chromium
podman compose -f .devcontainer/compose.yml exec app pnpm db:migrate
podman compose -f .devcontainer/compose.yml exec app pnpm dev --host 0.0.0.0
```

O Postgres de desenvolvimento roda no service `postgres` e usa a URL definida no compose do devcontainer.

Mais detalhes em `docs/development.md`.

## Scripts

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm build
pnpm verify
pnpm db:generate
pnpm db:migrate
```

## Deploy em VPS

1. Aponte o DNS do dominio para a VPS.
2. Copie `.env.example` para `.env`.
3. Preencha `APP_DOMAIN`, `ORIGIN`, `BETTER_AUTH_SECRET`, `POSTGRES_PASSWORD`, `REQUIRE_EMAIL_VERIFICATION`, `UPLOAD_DIR` se quiser customizar o caminho, e SMTP.
4. Suba o banco:

```bash
docker compose up -d postgres
```

5. Rode migrations:

```bash
docker compose --profile tools run --rm migrate
```

6. Suba a aplicacao:

```bash
docker compose up -d app caddy backup
```

7. Verifique:

```bash
curl -fsS https://seu-dominio.example/api/health
```

Operacao e diagnosticos de producao ficam em `docs/operations.md`.

## Backup e restore

Backups diarios do Postgres e dos comprovantes anexados sao salvos no volume `backups` com arquivos `.sha256`. Se `BACKUP_OFFSITE_DIR` apontar para um diretorio montado, o job tambem copia os arquivos verificados para esse destino.

Restore do banco:

```bash
docker compose exec -T postgres pg_restore \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --clean \
  --if-exists \
  /path/to/backup.dump
```

Restore dos anexos:

```bash
docker compose stop app
docker compose run --rm --no-deps \
  -v "$(pwd)/backups:/restore:ro" \
  app sh -lc 'rm -rf /app/uploads/* && tar -C /app/uploads -xzf /restore/uploads_YYYYMMDDTHHMMSSZ.tar.gz'
docker compose up -d app
```

Teste restore periodicamente em um banco separado.

## Seguranca

- Nunca commite `.env`.
- Gere `BETTER_AUTH_SECRET` com `openssl rand -base64 32`.
- Use HTTPS em producao.
- Configure SMTP para reset de senha e convites.
- Rode migrations antes de publicar uma nova versao.
- Monitore `/api/health`, uso de disco, logs do Postgres, idade dos backups e `pg_stat_statements`.

## Licenca

MIT. Consulte `LICENSE`.
