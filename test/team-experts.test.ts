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

const DB = process.env.TEST_DATABASE_URL;
const fx = (f: string) => readFileSync(join(import.meta.dirname, "fixtures", f));

describe.skipIf(!DB)("especialistas e equipe", () => {
  const pool = createPool(DB!);
  const engine = new CreditEngine(new PostgresRepo(pool));
  let last: { model: string; messages: ChatMsg[] } | null = null;
  const mock = new MockProvider(0);
  const provider: LLMProvider = {
    name: "test",
    stream: (opts, onDelta) => {
      last = { model: opts.model, messages: opts.messages };
      return mock.stream(opts, onDelta);
    },
  };
  const app = buildApp({ pool, engine, apiKey: "k".repeat(20), catalog: new ModelCatalog(), provider, sessionSecret: "s".repeat(40) });
  const cookies: Record<string, string> = {};
  const keep = (who: string, r: any) => {
    const sc = r.headers["set-cookie"];
    if (sc) cookies[who] = String(sc).split(";")[0];
    return r;
  };
  const as = (who: string) => ({
    call: async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown) =>
      keep(who, await app.inject({ method, url, headers: { cookie: cookies[who] ?? "", "content-type": "application/json" }, payload: body ? JSON.stringify(body) : undefined })),
    upload: (url: string, name: string, data: Buffer, mime: string) => {
      const boundary = "----dohko" + Math.random().toString(16).slice(2);
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return app.inject({ method: "POST", url, headers: { cookie: cookies[who], "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    },
  });
  const signup = async (who: string, email: string, extra: object = {}) =>
    (await as(who).call("POST", "/api/auth/signup", { name: who, email, password: "senha-forte-1", ...extra })).json();

  let dono: any;
  beforeAll(async () => {
    await pool.query("drop schema public cascade; create schema public;");
    await migrate(pool, () => {});
    dono = await signup("Dono", "dono@empresa.com", { company: "Empresa X" });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // ---------- especialistas ----------

  let expertId = "";

  it("cria especialista a partir de modelo pronto, com base de conhecimento (Excel)", async () => {
    const tpl = (await as("Dono").call("GET", "/api/expert-templates")).json();
    expect(tpl.length).toBeGreaterThanOrEqual(4);
    const fin = tpl.find((t: any) => t.key === "financeiro");
    const r = await as("Dono").call("POST", "/api/experts", { name: fin.name, emoji: fin.emoji, description: fin.description, instructions: fin.instructions, model: "gpt-sol" });
    expect(r.statusCode).toBe(201);
    expertId = r.json().id;

    const up = await as("Dono").upload(`/api/experts/${expertId}/files`, "financeiro.xlsx", fx("financeiro.xlsx"), "");
    expect(up.statusCode).toBe(201);
    const img = await as("Dono").upload(`/api/experts/${expertId}/files`, "logo.png", fx("logo.png"), "image/png");
    expect(img.statusCode).toBe(415); // base aceita só documentos

    const e = (await as("Dono").call("GET", `/api/experts/${expertId}`)).json();
    expect(e.files.map((f: any) => f.name)).toEqual(["financeiro.xlsx"]);
    expect(e.canEdit).toBe(true);
  });

  it("conversa com especialista usa as instruções, a base e o modelo padrão dele", async () => {
    const conv = (await as("Dono").call("POST", "/api/conversations", { kind: "chat", expertId })).json();
    expect(conv.expert_emoji).toBe("📊");
    await as("Dono").call("POST", `/api/conversations/${conv.id}/messages`, { content: "Como foi outubro?" });
    expect(last!.model).toBe("openai/gpt-6.2-sol"); // modelo padrão do especialista ("gpt-sol")
    const system = msgText(last!.messages[0]);
    expect(system).toContain('especialista "Analista financeiro de PME"');
    expect(system).toContain("Outubro | 120000 | 52");

    const got = (await as("Dono").call("GET", `/api/conversations/${conv.id}`)).json();
    expect(got.expert.name).toBe("Analista financeiro de PME");
    expect(got.messages[1].content).toBeTruthy();
  });

  it("especialista não vale no construtor e modelo inválido é recusado", async () => {
    expect((await as("Dono").call("POST", "/api/conversations", { kind: "build", expertId })).statusCode).toBe(400);
    expect((await as("Dono").call("POST", "/api/experts", { name: "X yz", instructions: "faça algo útil aqui", model: "nao-existe" })).statusCode).toBe(400);
  });

  // ---------- equipe ----------

  let token = "";

  it("dono gera convite; link mostra empresa e quem convidou; cadastro pelo convite entra na equipe", async () => {
    const inv = await as("Dono").call("POST", "/api/team/invites", {});
    expect(inv.statusCode).toBe(201);
    token = inv.json().token;
    expect(inv.json().path).toBe(`/?convite=${token}`);

    const info = await app.inject({ method: "GET", url: `/api/invites/${token}` });
    expect(info.json()).toEqual({ workspaceName: "Empresa X", inviter: "Dono" });

    const ana = await signup("Ana", "ana@empresa.com", { inviteToken: token });
    expect(ana.workspace.id).toBe(dono.workspace.id); // mesmo workspace, mesmos créditos
    expect(ana.role).toBe("member");

    // convite não pode ser usado de novo
    const again = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { name: "Beto", email: "beto@x.com", password: "senha-forte-1", inviteToken: token } });
    expect(again.statusCode).toBe(410);
    expect((await pool.query("select 1 from users where email = 'beto@x.com'")).rowCount).toBe(0); // não criou conta pela metade
  });

  it("membro vê e usa os especialistas da equipe, mas não edita nem convida nem paga", async () => {
    const list = (await as("Ana").call("GET", "/api/experts")).json();
    expect(list.map((e: any) => e.id)).toContain(expertId);
    expect((await as("Ana").call("PATCH", `/api/experts/${expertId}`, { name: "Hack", instructions: "outra instrução qualquer" })).statusCode).toBe(403);
    expect((await as("Ana").call("POST", "/api/team/invites", {})).statusCode).toBe(403);
    expect((await as("Ana").call("POST", "/api/billing/checkout", { planId: "pro_100" })).statusCode).toBe(403);
    const team = (await as("Ana").call("GET", "/api/team")).json();
    expect(team.members.map((m: any) => m.email)).toEqual(["dono@empresa.com", "ana@empresa.com"]);
    expect(team.invites).toEqual([]);
  });

  it("conversas continuam privadas dentro da equipe", async () => {
    const convs = (await as("Ana").call("GET", "/api/conversations")).json();
    expect(convs).toEqual([]);
  });

  it("usuário existente aceita convite pelo login e passa a ter dois workspaces; troca entre eles", async () => {
    const carlos = await signup("Carlos", "carlos@outra.com", { company: "Outra" });
    const inv = (await as("Dono").call("POST", "/api/team/invites", {})).json();
    const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "carlos@outra.com", password: "senha-forte-1", inviteToken: inv.token } });
    keep("Carlos", r);
    const me = r.json();
    expect(me.workspace.id).toBe(dono.workspace.id);
    expect(me.workspaces.map((w: any) => w.name).sort()).toEqual(["Empresa X", "Outra"]);

    await as("Carlos").call("POST", "/api/workspaces/switch", { workspaceId: carlos.workspace.id });
    expect((await as("Carlos").call("GET", "/api/me")).json().workspace.name).toBe("Outra");
    expect((await as("Carlos").call("POST", "/api/workspaces/switch", { workspaceId: "ws_qualquer" })).statusCode).toBe(404);
  });

  it("dono remove membro e o acesso cai na hora, mesmo com o cookie antigo", async () => {
    const team = (await as("Dono").call("GET", "/api/team")).json();
    const ana = team.members.find((m: any) => m.email === "ana@empresa.com");
    expect((await as("Dono").call("DELETE", `/api/team/members/${dono.user.id}`)).statusCode).toBe(400); // não remove a si mesmo
    expect((await as("Dono").call("DELETE", `/api/team/members/${ana.id}`)).statusCode).toBe(200);
    expect((await as("Ana").call("GET", "/api/experts")).statusCode).toBe(401);
  });

  it("convite expirado é recusado", async () => {
    const inv = (await as("Dono").call("POST", "/api/team/invites", {})).json();
    await pool.query("update workspace_invites set expires_at = now() - interval '1 minute' where token = $1", [inv.token]);
    expect((await app.inject({ method: "GET", url: `/api/invites/${inv.token}` })).statusCode).toBe(410);
  });
});
