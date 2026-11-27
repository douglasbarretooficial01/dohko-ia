import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { CreditEngine } from "../src/credits/engine.js";
import { PostgresRepo } from "../src/credits/pg-repo.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { ModelCatalog } from "../src/llm/models.js";
import { MockProvider, msgText, type ChatMsg, type LLMProvider } from "../src/llm/provider.js";
import { extract, slugify } from "../src/uploads.js";

const FX = join(import.meta.dirname, "fixtures");
const fx = (f: string) => readFileSync(join(FX, f));

describe("slug do link público", () => {
  it("sem acentos, sem hífen sobrando ao cortar", () => {
    expect(slugify("Uma página de agendamento para um salão de beleza")).toBe("uma-pagina-de-agendamento-para-um-salao");
    expect(slugify("!!!")).toBe("app");
  });
});

describe("extração de arquivos", () => {
  it("PDF, DOCX, CSV e imagem", async () => {
    expect((await extract(fx("relatorio.pdf"), "relatorio.pdf", "application/pdf")).text).toContain("faturamento de R$ 120.000");
    expect((await extract(fx("contrato.docx"), "contrato.docx", "")).text).toContain("Contrato de prestacao");
    expect((await extract(fx("vendas.csv"), "vendas.csv", "text/csv")).text).toContain("out,120000");
    const img = await extract(fx("logo.png"), "logo.png", "image/png");
    expect(img).toMatchObject({ kind: "image", mime: "image/png", text: null });
  });

  it("Excel: todas as abas, com cabeçalho e valores", async () => {
    const t = (await extract(fx("financeiro.xlsx"), "financeiro.xlsx", "")).text!;
    expect(t).toContain("## Aba: Vendas");
    expect(t).toContain("Mês | Faturamento | Clientes");
    expect(t).toContain("Outubro | 120000 | 52");
    expect(t).toContain("## Aba: Custos");
    await expect(extract(Buffer.from("PK\u0003\u0004lixo"), "x.xlsx", "")).rejects.toThrow(/XLSX_ILEGIVEL/);
  });

  it("recusa formato desconhecido e corta texto gigante", async () => {
    await expect(extract(Buffer.from([0, 1, 2]), "apresentacao.pptx", "application/octet-stream")).rejects.toThrow(/FORMATO_NAO_SUPORTADO/);
    const big = await extract(Buffer.from("a".repeat(200_000)), "grande.txt", "text/plain");
    expect(big.truncated).toBe(true);
    expect(big.text!.length).toBe(120_000);
  });
});

const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)("publicação, anexos e painel", () => {
  const pool = createPool(DB!);
  const engine = new CreditEngine(new PostgresRepo(pool));
  let lastMessages: ChatMsg[] = [];
  const mock = new MockProvider(0);
  const provider: LLMProvider = {
    name: "test",
    stream: (opts, onDelta) => {
      lastMessages = opts.messages;
      return mock.stream(opts, onDelta);
    },
  };
  const app = buildApp({ pool, engine, apiKey: "k".repeat(20), catalog: new ModelCatalog(), provider, sessionSecret: "s".repeat(40), adminEmails: ["admin@dohko.com"] });
  const cookies: Record<string, string> = {};

  const as = (who: string) => ({
    call: (method: "GET" | "POST" | "DELETE", url: string, body?: unknown) =>
      app.inject({ method, url, headers: { cookie: cookies[who], "content-type": "application/json" }, payload: body ? JSON.stringify(body) : undefined }),
    upload: (name: string, data: Buffer, mime: string) => {
      const boundary = "----dohko" + Math.random().toString(16).slice(2);
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({ method: "POST", url: "/api/uploads", headers: { cookie: cookies[who], "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    },
  });
  const signup = async (who: string, email: string) => {
    const r = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { name: who, email, password: "senha-forte-1" } });
    cookies[who] = String(r.headers["set-cookie"]).split(";")[0];
    return r.json();
  };

  beforeAll(async () => {
    await pool.query("drop schema public cascade; create schema public;");
    await migrate(pool, () => {});
    await signup("ana", "ana@x.com");
    await signup("admin", "admin@dohko.com");
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // ---------- publicação ----------

  let appId = "";
  let slug = "";

  it("não publica app sem versão; publica com versão e serve em /p/:slug isolado", async () => {
    const ana = as("ana");
    appId = (await ana.call("POST", "/api/conversations", { kind: "build" })).json().id;
    expect((await ana.call("POST", `/api/conversations/${appId}/publish`)).statusCode).toBe(400);

    await ana.call("POST", `/api/conversations/${appId}/messages`, { content: "Agenda do Salão Bela Vista" });
    const pub = await ana.call("POST", `/api/conversations/${appId}/publish`);
    expect(pub.statusCode).toBe(200);
    slug = pub.json().slug;
    expect(slug).toMatch(/^agenda-do-salao-bela-vista-[0-9a-f]{6}$/);

    const page = await app.inject({ method: "GET", url: `/p/${slug}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<!DOCTYPE html>");
    expect(page.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(page.headers["content-security-policy"]).not.toContain("allow-same-origin");
  });

  it("editar o app não altera a versão publicada até republicar", async () => {
    const ana = as("ana");
    await ana.call("POST", `/api/conversations/${appId}/messages`, { content: "Mude o título para Studio Nova" });
    const conv = (await ana.call("GET", `/api/conversations/${appId}`)).json();
    expect(conv.artifactVersion).toBe(2);
    expect(conv.published.version).toBe(1);
    expect((await app.inject({ method: "GET", url: `/p/${slug}` })).body).toContain("Bela Vista");

    const again = await ana.call("POST", `/api/conversations/${appId}/publish`);
    expect(again.json().slug).toBe(slug); // mesmo link
    expect((await app.inject({ method: "GET", url: `/p/${slug}` })).body).toContain("Studio Nova");
  });

  it("outro usuário não publica o app; despublicar derruba o link", async () => {
    expect((await as("admin").call("POST", `/api/conversations/${appId}/publish`)).statusCode).toBe(404);
    await as("ana").call("DELETE", `/api/conversations/${appId}/publish`);
    expect((await app.inject({ method: "GET", url: `/p/${slug}` })).statusCode).toBe(404);
  });

  // ---------- anexos ----------

  it("envia PDF e imagem; o modelo recebe o texto do PDF e a imagem; anexos ficam na mensagem", async () => {
    const ana = as("ana");
    const pdf = await ana.upload("relatorio.pdf", fx("relatorio.pdf"), "application/pdf");
    expect(pdf.statusCode).toBe(201);
    expect(pdf.json()).toMatchObject({ kind: "text", name: "relatorio.pdf" });
    const img = await ana.upload("logo.png", fx("logo.png"), "image/png");
    expect(img.json().kind).toBe("image");

    const chat = (await ana.call("POST", "/api/conversations", { kind: "chat" })).json().id;
    const auto = (await ana.call("POST", "/api/estimate", { conversationId: chat, content: "resuma", attachmentIds: [pdf.json().id, img.json().id] })).json();
    expect(auto.reason).toBe("pedido com imagem");
    const noAtt = (await ana.call("POST", "/api/estimate", { conversationId: chat, content: "resuma", model: "gpt" })).json();
    const withAtt = (await ana.call("POST", "/api/estimate", { conversationId: chat, content: "resuma", model: "gpt", attachmentIds: [pdf.json().id, img.json().id] })).json();
    expect(withAtt.expected).toBeGreaterThan(noAtt.expected); // anexos encarecem a estimativa

    const r = await ana.call("POST", `/api/conversations/${chat}/messages`, { content: "Resuma o relatório", attachmentIds: [pdf.json().id, img.json().id] });
    expect(r.payload).toContain("relatorio.pdf");
    const user = lastMessages.at(-1)!;
    expect(Array.isArray(user.content)).toBe(true);
    expect(msgText(user)).toContain("faturamento de R$ 120.000");
    expect((user.content as any[]).some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/png;base64,"))).toBe(true);

    const conv = (await ana.call("GET", `/api/conversations/${chat}`)).json();
    expect(conv.messages[0].attachments.map((a: any) => a.name)).toEqual(["relatorio.pdf", "logo.png"]);

    // imagem acessível só pelo dono
    expect((await ana.call("GET", `/api/attachments/${img.json().id}`)).headers["content-type"]).toBe("image/png");
    expect((await as("admin").call("GET", `/api/attachments/${img.json().id}`)).statusCode).toBe(404);

    // próxima pergunta: o PDF continua no contexto, a imagem vira nota
    await ana.call("POST", `/api/conversations/${chat}/messages`, { content: "E o faturamento?" });
    const hist = lastMessages.map(msgText).join("\n");
    expect(hist).toContain("faturamento de R$ 120.000");
    expect(hist).toContain("[imagem enviada antes: logo.png]");
  });

  it("anexo já usado ou de outra pessoa é recusado", async () => {
    const ana = as("ana");
    const csv = (await ana.upload("vendas.csv", fx("vendas.csv"), "text/csv")).json();
    const chat = (await ana.call("POST", "/api/conversations", { kind: "chat" })).json().id;
    await ana.call("POST", `/api/conversations/${chat}/messages`, { content: "analise", attachmentIds: [csv.id] });
    expect((await ana.call("POST", `/api/conversations/${chat}/messages`, { content: "de novo", attachmentIds: [csv.id] })).statusCode).toBe(400);

    const adminChat = (await as("admin").call("POST", "/api/conversations", { kind: "chat" })).json().id;
    const fresh = (await ana.upload("vendas.csv", fx("vendas.csv"), "text/csv")).json();
    expect((await as("admin").call("POST", `/api/conversations/${adminChat}/messages`, { content: "x", attachmentIds: [fresh.id] })).statusCode).toBe(400);
  });

  it("formato não suportado → 415", async () => {
    const r = await as("ana").upload("apresentacao.pptx", Buffer.from("PK\u0003\u0004xx"), "application/vnd.ms-powerpoint");
    expect(r.statusCode).toBe(415);
  });

  // ---------- painel ----------

  it("painel: só admin; mostra ações, custo, margem, modelos e dias", async () => {
    expect((await as("ana").call("GET", "/api/me")).json().isAdmin).toBe(false);
    expect((await as("ana").call("GET", "/api/admin/stats")).statusCode).toBe(403);

    const me = (await as("admin").call("GET", "/api/me")).json();
    expect(me.isAdmin).toBe(true);
    const s = (await as("admin").call("GET", "/api/admin/stats?days=7")).json();
    expect(s.totals.actions).toBeGreaterThanOrEqual(5);
    expect(s.totals.credits).toBeGreaterThan(0);
    expect(s.totals.costBRL).toBeGreaterThan(0);
    expect(s.totals.grossMargin).toBeGreaterThan(0.6);
    expect(s.totals.creditsFree).toBeGreaterThan(0);
    expect(s.users.total).toBe(2);
    expect(s.byModel.find((m: any) => m.mode === "build" && m.model === "claude-sonnet")).toBeTruthy();
    expect(s.byDay.length).toBeGreaterThanOrEqual(1);
    expect(s.plans[0]).toMatchObject({ planId: "free", workspaces: 2 });
  });
});
