import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { CreditEngine } from "../src/credits/engine.js";
import { PostgresRepo } from "../src/credits/pg-repo.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { ModelCatalog } from "../src/llm/models.js";
import { MockProvider } from "../src/llm/provider.js";
import type { MailMessage, Mailer } from "../src/mail.js";

const DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB)("recuperação de senha", () => {
  const pool = createPool(DB!);
  const engine = new CreditEngine(new PostgresRepo(pool));
  const sent: MailMessage[] = [];
  const mailer: Mailer = { name: "test", send: async (m) => void sent.push(m) };
  const app = buildApp({
    pool,
    engine,
    apiKey: "k".repeat(20),
    catalog: new ModelCatalog(),
    provider: new MockProvider(0),
    sessionSecret: "s".repeat(40),
    mailer,
    appUrl: "https://ia.dohko.com.br",
  });
  const post = (url: string, payload: object, cookie = "") => app.inject({ method: "POST", url, payload, headers: { cookie } });
  const tokenFrom = (m: MailMessage) => m.text.match(/redefinir=([\w-]+)/)![1];
  let oldCookie = "";

  beforeAll(async () => {
    await pool.query("drop schema public cascade; create schema public;");
    await migrate(pool, () => {});
    const r = await post("/api/auth/signup", { name: "Douglas Barreto", email: "douglas@dohko.com", password: "senha-antiga-1" });
    oldCookie = String(r.headers["set-cookie"]).split(";")[0];
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("e-mail desconhecido: mesma resposta, nenhum e-mail enviado", async () => {
    const r = await post("/api/auth/forgot", { email: "ninguem@x.com" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it("envia o link em português; no banco fica só o hash do token", async () => {
    await post("/api/auth/forgot", { email: "DOUGLAS@dohko.com" });
    expect(sent).toHaveLength(1);
    const m = sent[0];
    expect(m.to).toBe("douglas@dohko.com");
    expect(m.subject).toBe("Redefinir sua senha da Dohko IA");
    expect(m.text).toContain("Olá, Douglas!");
    expect(m.text).toContain("https://ia.dohko.com.br/?redefinir=");
    const token = tokenFrom(m);
    const rows = (await pool.query("select token_hash from password_resets")).rows;
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("link válido mostra o e-mail; troca a senha, entra logado e invalida a sessão antiga e os outros links", async () => {
    await post("/api/auth/forgot", { email: "douglas@dohko.com" });
    const [first, second] = sent.slice(-2).map(tokenFrom);
    expect((await app.inject({ method: "GET", url: `/api/auth/reset/${second}` })).json()).toEqual({ email: "douglas@dohko.com" });

    expect((await post("/api/auth/reset", { token: second, password: "curta" })).statusCode).toBe(400);
    await new Promise((r) => setTimeout(r, 1100)); // a sessão antiga foi emitida num segundo anterior à troca
    const r = await post("/api/auth/reset", { token: second, password: "senha-nova-123" });
    expect(r.statusCode).toBe(200);
    expect(r.json().user.email).toBe("douglas@dohko.com");
    const newCookie = String(r.headers["set-cookie"]).split(";")[0];

    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: newCookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: oldCookie } })).statusCode).toBe(401); // sessão antiga caiu

    expect((await post("/api/auth/reset", { token: second, password: "outra-senha-1" })).statusCode).toBe(410); // uso único
    expect((await post("/api/auth/reset", { token: first, password: "outra-senha-1" })).statusCode).toBe(410); // links anteriores invalidados

    expect((await post("/api/auth/login", { email: "douglas@dohko.com", password: "senha-antiga-1" })).statusCode).toBe(401);
    expect((await post("/api/auth/login", { email: "douglas@dohko.com", password: "senha-nova-123" })).statusCode).toBe(200);
  });

  it("link expirado ou inventado é recusado", async () => {
    await pool.query("delete from password_resets");
    await post("/api/auth/forgot", { email: "douglas@dohko.com" });
    const t = tokenFrom(sent.at(-1)!);
    await pool.query("update password_resets set expires_at = now() - interval '1 minute'");
    expect((await post("/api/auth/reset", { token: t, password: "senha-nova-456" })).statusCode).toBe(410);
    expect((await post("/api/auth/reset", { token: "inventado-123456", password: "senha-nova-456" })).statusCode).toBe(404);
  });

  it("no máximo 3 pedidos por hora por conta (os seguintes não enviam e-mail)", async () => {
    await pool.query("delete from password_resets");
    const before = sent.length;
    for (let i = 0; i < 5; i++) expect((await post("/api/auth/forgot", { email: "douglas@dohko.com" })).statusCode).toBe(200);
    expect(sent.length - before).toBe(3);
  });

  it("sem provedor de e-mail, o link vai para o log (desenvolvimento)", async () => {
    const logs: string[] = [];
    const { LogMailer, resetEmail } = await import("../src/mail.js");
    await new LogMailer((m) => logs.push(m)).send({ to: "a@b.com", ...resetEmail("Ana", "http://localhost:3000/?redefinir=abc") });
    expect(logs[0]).toContain("redefinir=abc");
  });
});
