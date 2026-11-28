# Dohko IA

IA de trabalho para PMEs brasileiras (concorrentes diretos: Lovable e Adapta One). Um app único com:
chat multimodelo com roteador automático (Dohko One), construtor de apps com prévia e publicação,
especialistas com base de conhecimento, equipes, anexos, créditos em reais e painel de margem.

Idioma: **tudo que o usuário vê é em português do Brasil** (interface, mensagens de erro exibidas, prompts dos modelos, README). Código e nomes de variáveis em inglês.

## Comandos

```bash
docker compose up -d --build                # sobe Postgres + API (que também serve o front) em :3000
docker compose logs -f api                  # logs
npm run dev                                 # API com hot reload (com `docker compose up -d db`)
npm run dev:web                             # front em :5173, repassa /api para :3000
npm run typecheck && (cd web && npx tsc --noEmit)
TEST_DATABASE_URL=postgresql://dohko:dohko@localhost:5432/dohko_test npm test   # criar antes: docker compose exec db createdb -U dohko dohko_test
```

Sempre rode typecheck (API e web) e a suíte completa com `TEST_DATABASE_URL` antes de dizer que algo está pronto. Sem `TEST_DATABASE_URL`, os testes de integração são pulados silenciosamente.

Sem `OPENROUTER_API_KEY`, o app roda em **modo simulado** (`MockProvider`): respostas e apps de exemplo, sem custo. Os testes usam o mock.

## Arquitetura

```
src/
  app.ts               Fastify: rotas internas (x-api-key), /p/:slug público, front estático (SPA)
  server.ts            bootstrap: env, migrations, catálogo, provedor, jobs
  routes/user.ts       /api com sessão: conta, conversas, chat em streaming (SSE), construtor, anexos, publicação, painel, cobrança
  routes/experts.ts    especialistas e base de conhecimento
  routes/team.ts       convites, membros, troca de workspace
  credits/             motor de créditos (pricing, engine, repo em memória e Postgres)
  llm/                 models.ts (catálogo + IDs do OpenRouter), router.ts (Dohko One), provider.ts (OpenRouter + mock), prompts.ts
  billing/stripe.ts    checkout, recarga, webhooks
  uploads.ts           extração de PDF/DOCX/XLSX/CSV/texto e imagens
  jobs.ts              expiração de créditos e reservas órfãs (15 min)
migrations/            SQL numerado, aplicado ao subir (com pg_advisory_lock)
web/                   React + Vite, sem framework de CSS (web/src/styles.css)
test/                  vitest; fixtures em test/fixtures
```

## Regras que não podem quebrar

- **Créditos**: todo uso de IA segue `estimate → reserve → (modelo roda) → settle | release`. Saldo nunca fica negativo (excesso vira `writeoff`). `credit_ledger` é só de inserção e precisa fechar com a soma dos `credit_buckets`. Concessões e `settle` são idempotentes por chave (`idempotency_keys`). Toda operação do motor roda dentro de `withWorkspaceLock` (SELECT … FOR UPDATE).
- **Falha do modelo sem resposta não cobra nada** (release). Resposta parcial cobra só o que foi gerado.
- **Migrations**: nunca edite uma migration existente; crie a próxima numerada (`005_...sql`).
- **Sessão**: o preHandler de `/api` confere a associação ao workspace em todo pedido (membro removido perde acesso na hora). Não remova isso.
- **Apps publicados** (`/p/:slug`) são servidos com `Content-Security-Policy: sandbox` sem `allow-same-origin`. Nunca adicione `allow-same-origin` (o app publicado passaria a poder usar a sessão de quem está logado).
- **Isolamento**: toda consulta filtra por `workspace_id` da sessão; conversas também por `user_id`.
- **Erros da API**: códigos em MAIÚSCULAS_COM_UNDERLINE em português (`SALDO_INSUFICIENTE`, `SOMENTE_DONO`), via `Object.assign(new Error(code), { statusCode })`. O front traduz para frases.
- **Validação**: toda entrada com zod.
- Não coloque segredos no código nem no git (`.env` é ignorado).

## Onde ajustar negócio

- Margem, valor do crédito, créditos diários, validades: `CONFIG` em `src/credits/config.ts`
- Planos e preço da recarga (R$): `PLANS` no mesmo arquivo (valores atuais são **exemplos**, não aprovados)
- Modelos e IDs do OpenRouter: `src/llm/models.ts` ou `DOHKO_MODELS` no `.env`
- Regras do Dohko One: `src/llm/router.ts`
- Personalidade e regras do construtor: `src/llm/prompts.ts`

## Pendências conhecidas (decisões do dono do produto)

1. Chave do OpenRouter e primeira validação com modelos reais (IDs em `models.ts` podem ter mudado).
2. Preços reais dos planos.
3. Stripe (produtos em BRL, webhook) — fluxo já implementado e testado com Stripe falso.
4. Deploy na VPS (`docker-compose.prod.yml` + Caddy com HTTPS; passo a passo no README).
5. Não implementado ainda: recuperação de senha (precisa de provedor de e-mail), WhatsApp como canal, PDF escaneado (OCR).
