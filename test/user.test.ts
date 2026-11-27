import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { CreditEngine } from "../src/credits/engine.js";
import { PostgresRepo } from "../src/credits/pg-repo.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { ModelCatalog } from "../src/llm/models.js";
import { MockProvider, type LLMProvider } from "../src/llm/provider.js";
import { extractHtml } from "../src/llm/prompts.js";
import { routeTier } from "../src/llm/router.js";

describe("roteador Dohko One", () => {
  it("pergunta curta → rápido; código/análise → forte; média → equilibrado", () => {
    expect(routeTier("oi, tudo bem?").tier).toBe("fast");
    expect(routeTier("Corrija esse bug no meu código Python que dá erro de índice").tier).toBe("deep");
    expect(routeTier("Faça uma análise de fluxo de caixa para minha padaria").tier).toBe("deep");
    expect(routeTier("Me ajude a escrever um e-mail educado para um cliente que atrasou o pagamento da fatura do mês passado e pedir uma nova data de pagamento").tier).toBe("balanced");
    expect(routeTier("x".repeat(1500)).tier).toBe("deep");
  });
});

describe("extração do HTML do construtor", () => {
  it("pega o último bloco html, inclusive sem fechar no fim", () => {
    expect(extractHtml("ok\n```html\n<p>1</p>\n```\n```html\n<p>2</p>\n```")).toBe("<p>2</p>");
    expect(extractHtml("```html\n<!DOCTYPE html><html></html>")).toBe("<!DOCTYPE html><html></html>");
    expect(extractHtml("sem código")).toBeNull();
  });
});

const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)("app do usuário (/api)", () => {
  const pool = createPool(DB!);
  const engine = new CreditEngine(new PostgresRepo(pool));
  const catalog = new ModelCatalog();
  let failNext = false;
  const mock = new MockProvider(0);
  const provider: LLMProvider = {
    name: "test",
    async stream(opts, onDelta) {
      if (failNext) {
        failNext = false;
        throw new Error("provedor fora do ar");
      }
      return mock.stream(opts, onDelta);
    },
  };
  const app = buildApp({ pool, engine, apiKey: "k".repeat(20), catalog, provider, sessionSecret: "s".repeat(40) });
  let cookie = "";

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown) =>
    app.inject({ method, url, headers: { cookie, "content-type": "application/json" }, payload: body ? JSON.stringify(body) : undefined });

  const sse = (payload: string) =>
    payload
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const ev = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        return { event: ev, data: data ? JSON.parse(data) : null };
      });

  beforeAll(async () => {
    await pool.query("drop schema public cascade; create schema public;");
    await migrate(pool, () => {});
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("bloqueia /api sem login", async () => {
    expect((await call("GET", "/api/me")).statusCode).toBe(401);
  });

  it("cadastro cria conta, workspace, créditos diários e sessão", async () => {
    const r = await call("POST", "/api/auth/signup", { name: "Douglas", email: "Douglas@Dohko.com", password: "senha-forte-1", company: "Dohko" });
    expect(r.statusCode).toBe(201);
    cookie = String(r.headers["set-cookie"]).split(";")[0];
    const me = r.json();
    expect(me.user.email).toBe("douglas@dohko.com");
    expect(me.workspace.name).toBe("Dohko");
    expect(me.balance.daily).toEqual({ build: 5, chat: 3 });
  });

  it("e-mail repetido → 409; senha curta → 400", async () => {
    expect((await call("POST", "/api/auth/signup", { name: "Xavier", email: "douglas@dohko.com", password: "12345678" })).statusCode).toBe(409);
    expect((await call("POST", "/api/auth/signup", { name: "Ana", email: "ana@x.com", password: "123" })).statusCode).toBe(400);
  });

  it("login com senha errada → 401; certa → 200", async () => {
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "douglas@dohko.com", password: "errada" } })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "DOUGLAS@dohko.com", password: "senha-forte-1" } });
    expect(ok.statusCode).toBe(200);
  });

  it("sessão adulterada é recusada", async () => {
    const r = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: cookie.slice(0, -3) + "abc" } });
    expect(r.statusCode).toBe(401);
  });

  let chatId = "";

  it("chat: stream com meta → deltas → done, cobra o real e salva as mensagens", async () => {
    chatId = (await call("POST", "/api/conversations", { kind: "chat" })).json().id;
    const est = (await call("POST", "/api/estimate", { conversationId: chatId, content: "oi", model: "auto" })).json();
    expect(est.model.id).toBe("gemini-flash");

    const r = await call("POST", `/api/conversations/${chatId}/messages`, { content: "oi, quem é você?", model: "auto" });
    expect(r.headers["content-type"]).toContain("text/event-stream");
    const events = sse(r.payload);
    expect(events[0].event).toBe("meta");
    expect(events[0].data.model.id).toBe("gemini-flash");
    expect(events.some((e) => e.event === "delta")).toBe(true);
    const done = events.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data.credits).toBeGreaterThan(0);
    expect(done.data.balance.daily.chat).toBeLessThan(3); // chat usa a cota diária de chat primeiro

    const conv = (await call("GET", `/api/conversations/${chatId}`)).json();
    expect(conv.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(conv.title).toBe("oi, quem é você?");
    const deltas = events.filter((e) => e.event === "delta").map((e) => e.data.t).join("");
    expect(conv.messages[1].content).toBe(deltas);
  });

  it("modelo escolhido manualmente é respeitado; desconhecido → 400", async () => {
    const r = await call("POST", `/api/conversations/${chatId}/messages`, { content: "teste", model: "claude-sonnet" });
    expect(sse(r.payload)[0].data.model.id).toBe("claude-sonnet");
    expect((await call("POST", `/api/conversations/${chatId}/messages`, { content: "x", model: "nao-existe" })).statusCode).toBe(400);
  });

  it("falha do provedor: avisa e não cobra nada", async () => {
    const before = (await call("GET", "/api/me")).json().balance.total;
    failNext = true;
    const r = await call("POST", `/api/conversations/${chatId}/messages`, { content: "vai falhar", model: "auto" });
    const last = sse(r.payload).at(-1)!;
    expect(last.event).toBe("error");
    expect(last.data.error).toBe("FALHA_NO_MODELO");
    expect((await call("GET", "/api/me")).json().balance.total).toBe(before);
  });

  let appId = "";

  it("construtor: gera o app, guarda a versão e tira o código da mensagem", async () => {
    appId = (await call("POST", "/api/conversations", { kind: "build" })).json().id;
    const r = await call("POST", `/api/conversations/${appId}/messages`, { content: "um app de lista de tarefas", model: "auto" });
    const events = sse(r.payload);
    expect(events[0].data.model.id).toBe("claude-sonnet");
    const done = events.at(-1)!.data;
    expect(done.artifactVersion).toBe(1);
    expect(done.artifactHtml).toContain("<!DOCTYPE html>");
    expect(done.content).toContain("Versão 1 do app gerada");
    expect(done.content).not.toContain("<html");

    const conv = (await call("GET", `/api/conversations/${appId}`)).json();
    expect(conv.artifactVersion).toBe(1);
    expect(conv.artifactHtml).toContain("lista de tarefas");

    // segunda iteração → versão 2
    const r2 = await call("POST", `/api/conversations/${appId}/messages`, { content: "deixe o fundo branco", model: "auto" });
    expect(sse(r2.payload).at(-1)!.data.artifactVersion).toBe(2);
  });

  it("sem saldo → 402 antes de chamar o modelo", async () => {
    // zera o saldo do workspace
    const me = (await call("GET", "/api/me")).json();
    await pool.query("update credit_buckets set balance = 0 where workspace_id = $1", [me.workspace.id]);
    const r = await call("POST", `/api/conversations/${appId}/messages`, { content: "mais uma mudança", model: "auto" });
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe("SALDO_INSUFICIENTE");
  });

  it("um usuário não acessa a conversa do outro", async () => {
    const other = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { name: "Outro", email: "outro@x.com", password: "senha-forte-2" } });
    const otherCookie = String(other.headers["set-cookie"]).split(";")[0];
    const r = await app.inject({ method: "GET", url: `/api/conversations/${chatId}`, headers: { cookie: otherCookie } });
    expect(r.statusCode).toBe(404);
  });

  it("lista, renomeia e apaga conversas", async () => {
    const list = (await call("GET", "/api/conversations")).json();
    expect(list.length).toBe(2);
    await call("PATCH", `/api/conversations/${chatId}`, { title: "Renomeada" });
    expect((await call("GET", `/api/conversations/${chatId}`)).json().title).toBe("Renomeada");
    await call("DELETE", `/api/conversations/${chatId}`);
    expect((await call("GET", "/api/conversations")).json().length).toBe(1);
  });

  it("modelos e planos disponíveis", async () => {
    const m = (await call("GET", "/api/models")).json();
    expect(m.auto.label).toBe("Dohko One");
    expect(m.models.length).toBeGreaterThan(3);
    expect(m.models[0].providerModel).toBeUndefined(); // não expõe o ID do provedor
    expect((await call("GET", "/api/plans")).json().every((p: any) => p.priceBRL > 0)).toBe(true);
  });
});
