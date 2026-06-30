# Operacao

## Observabilidade do Postgres

O compose ja carrega `pg_stat_statements` e logs de queries lentas. Para uma passagem manual de diagnostico na VPS, rode:

```bash
docker compose exec -T postgres psql \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  < scripts/postgres-observability.sql
```

O script e somente-leitura e cobre:

- saude geral do banco, conexoes, cache hit, arquivos temporarios e deadlocks;
- transacoes longas e lock waits com bloqueadores;
- queries mais caras por tempo total e medio via `pg_stat_statements`;
- tamanho de tabelas/indices, mistura de scans, tuplas mortas e frescor de vacuum/analyze;
- candidatos a indices nao usados, indices duplicados e indices invalidos.

Nao remova indices apenas porque aparecem como nao usados em um ambiente novo. Valide depois de trafego real, jobs de importacao, relatorios e fechamento de mes. Para uma decisao segura, compare:

```sql
explain (analyze, buffers)
select ...
```

antes e depois em uma copia do banco ou em uma janela operacional.

## Hardening do Compose

O `docker-compose.yml` de producao roda o app como usuario nao-root, com filesystem somente-leitura, `/tmp` em `tmpfs`, capabilities removidas, `no-new-privileges`, limites basicos de CPU/memoria e healthcheck real em `/api/health`.

O Caddy tambem usa filesystem somente-leitura e preserva apenas `NET_BIND_SERVICE`, necessario para publicar portas 80/443. O Postgres fica mais conservador porque o entrypoint oficial precisa preparar o volume de dados com permissoes corretas.

Os limites podem ser ajustados por variaveis de ambiente sem editar o compose:

```bash
APP_MEM_LIMIT=768m
APP_CPUS=1.5
POSTGRES_MEM_LIMIT=2g
POSTGRES_CPUS=2
CADDY_MEM_LIMIT=256m
BACKUP_MEM_LIMIT=256m
```

Depois de qualquer ajuste operacional, valide a configuracao:

```bash
docker compose config
docker compose up -d
docker compose ps
curl -fsS "$ORIGIN/api/health"
```

## Backups verificaveis

O job de backup gera um dump custom do Postgres, valida o arquivo com `pg_restore --list`, cria `.sha256` e repete o processo para o pacote de comprovantes quando existem uploads. Configure `BACKUP_OFFSITE_DIR` apenas se esse caminho estiver montado em storage externo ou outro volume persistente.

Para validar manualmente um backup antes de restaurar:

```bash
sha256sum -c /backups/expense_manager_YYYYMMDDTHHMMSSZ.dump.sha256
pg_restore --list /backups/expense_manager_YYYYMMDDTHHMMSSZ.dump >/dev/null
sha256sum -c /backups/uploads_YYYYMMDDTHHMMSSZ.tar.gz.sha256
tar -tzf /backups/uploads_YYYYMMDDTHHMMSSZ.tar.gz >/dev/null
```
