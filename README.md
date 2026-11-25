# Dohko IA

Backend da Dohko IA. Por enquanto contém o **motor de créditos**: precificação pelo custo real com margem, reserva antes de executar, acerto depois, créditos diários, plano e recargas via Stripe, e um registro de movimentos (ledger) auditável.

Stack: Node 22 + TypeScript + Fastify + Postgres 16, empacotado em Docker Compose. O mesmo comando roda no MacBook e na VPS.

---

## 1. Rodar no MacBook

**Pré-requisitos:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) ou [OrbStack](https://orbstack.dev) (mais leve no Mac), Git e, para testar pagamentos, o [Stripe CLI](https://docs.stripe.com/stripe-cli) (`brew install stripe/stripe-cli/stripe`).

```bash
git clone git@github.com:<owner>/dohko-ia.git
cd dohko-ia
cp .env.example .env
# edite o .env: no mínimo troque API_KEY  →  openssl rand -hex 32
docker compose up -d --build
curl localhost:3000/health          # {"ok":true}
```

As migrations do banco rodam sozinhas quando a API sobe.

**Teste rápido:**

```bash
K="x-api-key: $(grep ^API_KEY .env | cut -d= -f2)"; J="content-type: application/json"
curl -s -X POST localhost:3000/workspaces -H "$K" -H "$J" -d '{"id":"ws_demo","name":"Demo"}'
curl -s localhost:3000/workspaces/ws_demo/balance -H "$K"
```

**Desenvolvimento com hot reload** (API fora do Docker, banco no Docker):

```bash
npm install
docker compose up -d db
npm run dev
```

**Testes:**

```bash
npm test                                                             # testes unitários
TEST_DATABASE_URL=postgresql://dohko:dohko@localhost:5432/dohko_test npm test   # + integração com Postgres
# (crie o banco antes: docker compose exec db createdb -U dohko dohko_test)
```

### Stripe no Mac (modo teste)

1. No [painel do Stripe](https://dashboard.stripe.com/test/products), em modo teste, crie um produto para cada plano (Pro 100, Pro 200…) com **preço recorrente mensal em BRL**. Copie os IDs `price_…` para `STRIPE_PRICES` no `.env`.
2. Coloque a chave `sk_test_…` em `STRIPE_SECRET_KEY`.
3. Encaminhe os webhooks para a sua máquina:
   ```bash
   stripe login
   stripe listen --forward-to localhost:3000/webhooks/stripe
   ```
   Copie o `whsec_…` exibido para `STRIPE_WEBHOOK_SECRET` e reinicie: `docker compose up -d`.
4. Gere um checkout e pague com o cartão de teste `4242 4242 4242 4242`:
   ```bash
   curl -s -X POST localhost:3000/billing/checkout -H "$K" -H "$J" -d '{"workspaceId":"ws_demo","planId":"pro_100"}'
   ```
   Após o pagamento, o saldo do workspace ganha os 100 créditos do plano.

---

## 2. Subir na VPS

Recomendado: Ubuntu 24.04, 2 GB de RAM ou mais, com um domínio (por exemplo `api.dohko.com.br`) apontando para o IP da VPS.

```bash
# na VPS
curl -fsSL https://get.docker.com | sh
git clone git@github.com:<owner>/dohko-ia.git && cd dohko-ia
cp .env.example .env
```

No `.env` da VPS, troque:
- `NODE_ENV=production`
- `POSTGRES_PASSWORD` por uma senha forte (`openssl rand -hex 24`)
- `API_KEY` por uma chave nova
- `APP_URL=https://api.dohko.com.br` e `DOMAIN=api.dohko.com.br`
- `STRIPE_SECRET_KEY` pela chave **live** quando for para valer
- `STRIPE_WEBHOOK_SECRET` pelo segredo do endpoint criado no painel do Stripe, apontando para `https://api.dohko.com.br/webhooks/stripe` com os eventos `invoice.paid`, `checkout.session.completed` e `customer.subscription.deleted`

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

O Caddy emite o certificado HTTPS sozinho. O Postgres e a API ficam presos ao `127.0.0.1`, e só as portas 80 e 443 ficam públicas. Libere-as no firewall: `ufw allow 22,80,443/tcp && ufw enable`.

**Atualizar:** `git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`

**Backup diário do banco** (crontab da VPS):

```
0 3 * * * cd /root/dohko-ia && docker compose exec -T db pg_dump -U dohko dohko | gzip > /root/backups/dohko-$(date +\%F).sql.gz
```

---

## 3. API

Todas as rotas, exceto `/health` e `/webhooks/stripe`, exigem o header `x-api-key`.

| Método | Rota | Para quê |
| :- | :- | :- |
| GET | `/health` | Verificar se a API e o banco estão no ar |
| GET | `/plans` | Listar os planos em R$ |
| POST | `/workspaces` | Criar workspace `{id?, name}`; já recebe os créditos diários |
| GET | `/workspaces/:id/balance` | Consultar o saldo (total, diários, gerais, próximo vencimento) |
| GET | `/workspaces/:id/ledger` | Ver o extrato de movimentos |
| POST | `/actions/estimate` | Estimar o custo `{mode, taskType \| profile}` → `{expected, reserve}` |
| POST | `/actions/reserve` | Reservar créditos antes de rodar `{workspaceId, actionId, mode, amount \| taskType}` → **402** se faltar saldo |
| POST | `/actions/settle` | Cobrar o custo real `{workspaceId, actionId, mode, calls[], toolCostsUSD?, completedFraction?}` |
| POST | `/actions/release` | Cancelar a reserva (a ação falhou antes de rodar) |
| POST | `/billing/checkout` | Gerar o link de pagamento da assinatura `{workspaceId, planId}` |
| POST | `/billing/topup` | Gerar o link de pagamento da recarga `{workspaceId, credits}` (50 a 1000) |
| POST | `/webhooks/stripe` | Receber os eventos do Stripe (assinatura verificada) |

### Como o agente da Dohko usa

```
1. POST /actions/estimate   → mostra ao usuário "deve custar ~0,8 crédito"
2. POST /actions/reserve    → 402? mostra "sem saldo" + botão de recarga
3. roda o LLM e soma os tokens de todas as chamadas
4. POST /actions/settle     → cobra o real e devolve o resto da reserva
   (falhou antes de rodar? POST /actions/release)
```

---

## 4. Onde ajustar

| O quê | Onde |
| :- | :- |
| Margem, valor do crédito, créditos diários e validades | `src/credits/config.ts` → `CONFIG` |
| Preço dos modelos (US$ por 1M tokens) | `src/credits/config.ts` → `MODEL_COST_USD_PER_MTOK` |
| Planos e preço da recarga em R$ | `src/credits/config.ts` → `PLANS` |
| Perfis de estimativa por tipo de tarefa | `src/credits/config.ts` → `TASK_PROFILES` (recalibrar com a tabela `action_usage`) |
| Câmbio | `.env` → `USD_TO_BRL` |

## Estrutura

```
src/
  credits/      motor de créditos (pricing, engine, repo em memória e Postgres)
  billing/      integração com o Stripe
  db/           pool e migrations
  app.ts        rotas HTTP
  server.ts     inicialização
  jobs.ts       expiração e reservas órfãs (a cada 15 min)
migrations/     SQL versionado
test/           unitários + integração com Postgres
```
