# Deploy em VPS

## Requisitos

- Docker Engine com Docker Compose
- pnpm nao precisa ser instalado na VPS; a imagem Docker instala dependencias durante o build
- Dominio apontado para a VPS
- Portas 80 e 443 liberadas
- SMTP configurado para reset de senha e convites
- Storage externo para copiar backups
- Espaco persistente para o volume `uploads`, usado pelos comprovantes anexados

## Variaveis obrigatorias

- `APP_DOMAIN`
- `ORIGIN`
- `BETTER_AUTH_SECRET`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`

## Variaveis recomendadas

- `UPLOAD_DIR`: caminho dos anexos dentro do container. O compose usa `/app/uploads` por padrao.
- `DB_POOL_MAX`: tamanho maximo do pool de conexoes da aplicacao.
- `TRUST_PROXY_HEADERS`: use `true` somente quando o app nao estiver exposto diretamente e receber trafego apenas por proxy confiavel. No `docker-compose.yml` padrao fica `true` porque o Caddy e o unico servico publicado.
- `TRUSTED_ORIGINS`: origens extras separadas por virgula para acessos por URL alternativa, VPN ou Tailscale. Use origens completas como `https://financeiro.example.com` ou `http://100.x.y.z:5173`.
- `BACKUP_OFFSITE_DIR`: diretorio opcional dentro do container de backup para copiar dumps e checksums ja validados. Monte esse caminho em storage externo pela sua politica operacional.
- `APP_MEM_LIMIT`, `APP_CPUS`, `POSTGRES_MEM_LIMIT`, `POSTGRES_CPUS`, `CADDY_MEM_LIMIT`, `BACKUP_MEM_LIMIT`: limites operacionais opcionais para ajustar consumo na VPS.

## Primeira publicacao

```bash
cp .env.example .env
docker compose up -d postgres
docker compose --profile tools run --rm migrate
docker compose up -d app caddy backup
```

O servico `backup` grava dumps do Postgres, arquivos `uploads_*.tar.gz` com comprovantes anexados e checksums `.sha256`. O dump e validado com `pg_restore --list` e o pacote de uploads e validado com `tar -tzf` antes da copia opcional para `BACKUP_OFFSITE_DIR`.

## Restore

Restaure o Postgres primeiro:

```bash
docker compose exec -T postgres pg_restore \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --clean \
  --if-exists \
  /path/to/backup.dump
```

Depois restaure os anexos correspondentes ao mesmo timestamp do dump:

```bash
docker compose stop app
docker compose run --rm --no-deps \
  -v "$(pwd)/backups:/restore:ro" \
  app sh -lc 'rm -rf /app/uploads/* && tar -C /app/uploads -xzf /restore/uploads_YYYYMMDDTHHMMSSZ.tar.gz'
docker compose up -d app
```

Valide o restore em uma base separada antes de depender dele em producao.

## Atualizacao

```bash
git pull
docker compose build app migrate
docker compose --profile tools run --rm migrate
docker compose up -d app
docker compose exec app wget -qO- http://localhost:3000/api/health
```

## Diagnostico operacional

Para revisar queries lentas, lock waits, tamanho de indices, tuplas mortas e candidatos a indices nao usados:

```bash
docker compose exec -T postgres psql \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  < scripts/postgres-observability.sql
```

Detalhes e criterios de acao ficam em `docs/operations.md`.

## Rollback

Mantenha tags de release no GitHub. Para voltar:

```bash
git checkout <tag-anterior>
docker compose build app
docker compose up -d app
```

Migrations destrutivas exigem plano especifico de rollback de banco.
