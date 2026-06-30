# Seguranca

## Controles implementados

- Autenticacao com Better Auth
- Verificacao de email obrigatoria em producao por padrao
- Cookies seguros configurados pela biblioteca de auth
- Rate limit persistente para login, cadastro e reset de senha
- Rate limit usa IP real do proxy apenas quando `TRUST_PROXY_HEADERS=true`
- Isolamento por `workspace_id` em todos os servicos de dominio
- RBAC por workspace
- Valores financeiros em centavos
- Convites com token hashado
- MFA/TOTP opcional por usuario, com segredo criptografado, recovery codes hashados e gate global para sessoes autenticadas
- Anexos com limite de tamanho, allowlist de MIME type, download autenticado e bloqueio quando a despesa foi removida
- Anexos gravados e baixados por streaming para evitar buffers grandes no processo Node
- Soft delete de despesas
- Auditoria de acoes principais com filtros por acao e entidade
- Request ID e `Server-Timing` em respostas HTTP
- Headers de seguranca no hook global e no Caddy
- CSP em producao
- Compose de producao com app em filesystem somente-leitura, `tmpfs` para temporarios, capabilities removidas, `no-new-privileges`, limites de recursos e healthcheck de aplicacao

## Checklist antes de producao

- `BETTER_AUTH_SECRET` gerado com alta entropia
- SMTP testado
- `REQUIRE_EMAIL_VERIFICATION=true` em producao, salvo decisao operacional documentada
- HTTPS ativo
- `TRUST_PROXY_HEADERS=true` apenas se o app estiver isolado atras de proxy reverso confiavel
- Backups copiados para fora da VPS
- Restore testado
- Backup do volume `uploads` conferido e copiado para fora da VPS se comprovantes forem usados
- `pnpm audit --prod` revisado
- `pnpm verify` passando
- `docker compose config` valido para o `.env` de producao
- Diagnostico em `scripts/postgres-observability.sql` revisado quando houver trafego real
- Acesso SSH da VPS limitado por chave
- Firewall permitindo apenas SSH, 80 e 443

## Audit exceptions

O `pnpm-workspace.yaml` ignora dois advisories conhecidos no audit de producao:

- `GHSA-67mh-4wv8-2f99`: `esbuild` abaixo de `0.24.3` aparece via peer/tooling de `drizzle-kit`, usado para migrations/build, nao pelo servidor Node final.
- `GHSA-pxg6-pf52-xh8x`: `cookie@0.6.0` aparece via peer de `@sveltejs/kit`. O risco reportado e baixo e deve ser removido quando SvelteKit atualizar a dependencia.

Essas excecoes devem ser reavaliadas a cada atualizacao de dependencias.

## Modelo de permissoes

- `owner`: gerencia workspace, usuarios, categorias e despesas
- `admin`: gerencia usuarios, categorias e despesas
- `member`: cria e edita despesas
- `viewer`: apenas visualiza
