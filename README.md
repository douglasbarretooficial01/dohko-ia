# Dohko IA

A IA de trabalho da Dohko Technology:

- **Chat multimodelo**: GPT, Claude e Gemini num só lugar. O **Dohko One** escolhe o modelo certo para cada pedido (rápido e barato para o simples, forte para análise e código).
- **Construtor de apps**: a pessoa descreve um app e recebe um app web funcionando, com prévia ao vivo (computador e celular), versões, código e download.
- **Publicar com um clique**: o app ganha um link público (`/p/nome-do-app`) que qualquer pessoa abre. Editar o app não muda o que está no ar até você clicar em "Atualizar".
- **Anexos no chat**: PDF, Word (.docx), Excel (.xlsx), CSV, TXT, Markdown, JSON e imagens (PNG, JPG, WebP). Arraste para o chat, cole uma imagem ou use o 📎.
- **Especialistas**: assistentes com instruções, modelo padrão e base de conhecimento (até 20 documentos) da empresa. Há modelos prontos (copywriter, analista financeiro, atendimento, social media). Toda a equipe usa.
- **Equipe**: o dono gera links de convite (válidos por 7 dias, 1 pessoa cada). Todos compartilham créditos e especialistas; as conversas de cada um são privadas. Quem participa de mais de uma empresa troca de workspace no menu.
- **Créditos em reais**: o custo estimado aparece antes de enviar; a cobrança é pelo custo real, com margem; créditos grátis diários, planos e recargas pelo Stripe.
- **Painel de uso e margem** (para administradores): receita, custo real de IA, margem por modelo e por dia, usuários e assinaturas.

Stack: Node 22 + TypeScript + Fastify + Postgres 16 + React (Vite), tudo num Docker Compose. O mesmo comando roda no MacBook e na VPS.

---

## 1. Rodar no MacBook

**Pré-requisito:** [OrbStack](https://orbstack.dev) (ou Docker Desktop) instalado.

```bash
cd ~/dohko-ia
./scripts/setup-mac.sh
```

O script abre o OrbStack, cria o `.env` com chaves novas, sobe o banco e a API, e abre **http://localhost:3000** no navegador. Crie sua conta e use.

Sem chave de IA, o sistema roda em **modo simulado**: respostas e apps de exemplo, sem custo, bons para testar a interface e os créditos.

### Atualizar para a última versão

```bash
cd ~/dohko-ia && sh scripts/update-mac.sh
```

Baixa a versão mais nova do GitHub, mantém o seu `.env` e o banco, recompila e reinicia.

### Painel de administração

No `.env`, coloque seu e-mail em `ADMIN_EMAILS=voce@empresa.com` (vários separados por vírgula) e rode `docker compose up -d`. O link **📊 Painel de uso e margem** aparece no menu lateral.

### Ligar a IA de verdade

1. Crie uma conta em [openrouter.ai](https://openrouter.ai), adicione créditos e gere uma chave em [openrouter.ai/keys](https://openrouter.ai/keys).
2. No `.env`, preencha `OPENROUTER_API_KEY=sk-or-...`.
3. Aplique: `docker compose up -d`.

Uma única chave do OpenRouter dá acesso a todos os modelos. O OpenRouter informa o custo real de cada resposta, e é esse valor que o motor de créditos cobra (com a margem configurada).

### Comandos úteis

```bash
docker compose logs -f api            # ver o que a API está fazendo
docker compose down                   # parar tudo
docker compose up -d --build          # subir de novo (depois de atualizar o código)
```

### Desenvolvimento (hot reload)

```bash
npm install && npm --prefix web install
docker compose up -d db
npm run dev          # API em :3000
npm run dev:web      # interface em :5173 (repassa /api para a :3000)
```

### Testes

```bash
docker compose exec db createdb -U dohko dohko_test
TEST_DATABASE_URL=postgresql://dohko:dohko@localhost:5432/dohko_test npm test
```

---

## 2. Stripe (pagamentos)

1. No [painel do Stripe](https://dashboard.stripe.com/test/products), em modo teste, crie um produto por plano (Pro 100, Pro 200, Pro 400, Pro 800) com **preço recorrente mensal em BRL**. Copie os IDs `price_…` para `STRIPE_PRICES` no `.env`.
2. Coloque a chave `sk_test_…` em `STRIPE_SECRET_KEY`.
3. No Mac, encaminhe os webhooks com o [Stripe CLI](https://docs.stripe.com/stripe-cli):
   ```bash
   stripe login
   stripe listen --forward-to localhost:3000/webhooks/stripe
   ```
   Copie o `whsec_…` exibido para `STRIPE_WEBHOOK_SECRET` e rode `docker compose up -d`.
4. No app, clique em **Ver planos → Assinar** e pague com o cartão de teste `4242 4242 4242 4242`. Os créditos do plano entram assim que o Stripe confirma.

---

## 3. Subir na VPS

Recomendado: Ubuntu 24.04 com 2 GB de RAM ou mais e um domínio (por exemplo `ia.dohko.com.br`) apontando para o IP da VPS.

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/douglasbarretooficial01/dohko-ia.git && cd dohko-ia
cp .env.example .env
```

No `.env` da VPS, defina:

| Variável | Valor |
| :- | :- |
| `NODE_ENV` | `production` |
| `POSTGRES_PASSWORD` | uma senha forte (`openssl rand -hex 24`) |
| `API_KEY` e `SESSION_SECRET` | chaves novas (`openssl rand -hex 32`) |
| `APP_URL` | `https://ia.dohko.com.br` |
| `DOMAIN` | `ia.dohko.com.br` |
| `OPENROUTER_API_KEY` | sua chave |
| `ADMIN_EMAILS` | e-mails com acesso ao painel |
| `STRIPE_*` | chaves **live** e o segredo do endpoint `https://ia.dohko.com.br/webhooks/stripe` (eventos `invoice.paid`, `checkout.session.completed`, `customer.subscription.deleted`) |

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
ufw allow 22,80,443/tcp && ufw enable
```

O Caddy emite o HTTPS sozinho. O banco e a API ficam presos ao `127.0.0.1`, e só as portas 80 e 443 ficam públicas.

**Atualizar:** `git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`

**Backup diário** (crontab):

```
0 3 * * * cd /root/dohko-ia && docker compose exec -T db pg_dump -U dohko dohko | gzip > /root/backups/dohko-$(date +\%F).sql.gz
```

---

## 4. Onde ajustar

| O quê | Onde |
| :- | :- |
| Modelos disponíveis e IDs no OpenRouter | `src/llm/models.ts` ou `DOHKO_MODELS` no `.env` |
| Qual modelo o Dohko One usa em cada nível | `TIER_DEFAULT` em `src/llm/models.ts` ou `DOHKO_TIER_DEFAULT` |
| Regras do Dohko One (quando usar modelo forte) | `src/llm/router.ts` |
| Personalidade da IA e regras do construtor | `src/llm/prompts.ts` |
| Margem, valor do crédito, créditos diários, validades | `CONFIG` em `src/credits/config.ts` |
| Planos e preço da recarga em R$ | `PLANS` em `src/credits/config.ts` |
| Câmbio | `USD_TO_BRL` no `.env` |

---

## 5. Arquitetura

```
web/                 interface (React + Vite), servida pela própria API em produção
src/
  routes/user.ts     /api: conta, conversas, chat em streaming, construtor, anexos, publicação, painel, cobrança
  routes/experts.ts  especialistas e base de conhecimento
  routes/team.ts     convites, membros e troca de workspace
  uploads.ts         leitura de PDF, Word, Excel, CSV, texto e imagens
  llm/               catálogo de modelos, Dohko One, OpenRouter, modo simulado, prompts
  credits/           motor de créditos (preço, reserva, cobrança, ledger)
  billing/           Stripe (checkout, recarga, webhooks)
  app.ts             servidor HTTP, rotas internas e entrega do front
  jobs.ts            expiração de créditos e reservas órfãs (a cada 15 min)
migrations/          SQL versionado (aplicado automaticamente ao subir)
test/                unitários + integração com Postgres + provedor
```

**Fluxo de uma mensagem:** estimativa de custo (mostrada ao digitar) → reserva de créditos (bloqueia com aviso se faltar saldo) → resposta em streaming → cobrança do custo real informado pelo provedor → devolução do que sobrou da reserva. Se o modelo falhar sem responder, nada é cobrado.

**Segurança dos apps publicados:** a página `/p/...` é servida com `Content-Security-Policy: sandbox`, ou seja, numa origem isolada. Um app publicado não consegue usar a sessão nem chamar a API de quem está logado na Dohko.

**Rotas internas** (`/workspaces`, `/actions`, `/plans`, `/billing/*`) continuam disponíveis com o header `x-api-key`, para outros serviços da Dohko usarem o motor de créditos.
