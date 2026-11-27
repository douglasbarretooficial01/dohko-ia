import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { hashPassword, signSession, verifyPassword, verifySession, type Session } from "../auth.js";
import { createPlanCheckout, createTopupCheckout, type BillingDeps } from "../billing/stripe.js";
import { PLANS } from "../credits/config.js";
import type { CreditEngine } from "../credits/engine.js";
import { InsufficientCreditsError } from "../credits/engine.js";
import { ceil2, creditsFor, realCostBRL } from "../credits/pricing.js";
import type { ModelCatalog } from "../llm/models.js";
import { BUILDER_SYSTEM, CHAT_SYSTEM, extractHtml, stripHtmlBlock } from "../llm/prompts.js";
import { approxTokens, type ChatMsg, type LLMProvider } from "../llm/provider.js";
import { routeTier } from "../llm/router.js";

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

export interface UserRoutesDeps {
  pool: pg.Pool;
  engine: CreditEngine;
  catalog: ModelCatalog;
  provider: LLMProvider;
  sessionSecret: string;
  secureCookies: boolean;
  billing: () => BillingDeps;
}

const COOKIE = "dohko_session";
const HISTORY_LIMIT = 30;
const LIMITS = {
  chat: { maxTokens: 4_000, expectedOut: 900 },
  build: { maxTokens: 16_000, expectedOut: 7_000 },
};

type Kind = "chat" | "build";

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export async function userRoutes(app: FastifyInstance, d: UserRoutesDeps) {
  const { pool, engine, catalog } = d;

  const setSession = (reply: FastifyReply, uid: string, wid: string) =>
    reply.setCookie(COOKIE, signSession({ uid, wid }, d.sessionSecret), {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: d.secureCookies,
      maxAge: 30 * 86400,
    });

  // Tudo em /api exige sessão, exceto cadastro e login
  app.addHook("preHandler", async (req) => {
    if (req.url.startsWith("/api/auth/signup") || req.url.startsWith("/api/auth/login")) return;
    const s = verifySession(req.cookies[COOKIE], d.sessionSecret);
    if (!s) throw err(401, "SESSAO_INVALIDA");
    req.session = s;
  });

  const me = async (uid: string, wid: string) => {
    await engine.grantDaily(wid);
    const r = await pool.query(
      `select u.id, u.name, u.email, w.id as wid, w.name as wname, w.plan_id
       from users u join memberships m on m.user_id = u.id join workspaces w on w.id = m.workspace_id
       where u.id = $1 and w.id = $2`,
      [uid, wid],
    );
    if (!r.rowCount) throw err(401, "SESSAO_INVALIDA");
    const x = r.rows[0];
    return {
      user: { id: x.id, name: x.name, email: x.email },
      workspace: { id: x.wid, name: x.wname, planId: x.plan_id, plan: PLANS[x.plan_id] },
      balance: await engine.balance(wid),
    };
  };

  // ---------- Conta ----------

  app.post("/api/auth/signup", async (req, reply) => {
    const b = z
      .object({
        name: z.string().trim().min(2),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(8, "A senha precisa de pelo menos 8 caracteres"),
        company: z.string().trim().min(1).optional(),
      })
      .parse(req.body);
    const exists = await pool.query("select 1 from users where email = $1", [b.email]);
    if (exists.rowCount) throw err(409, "EMAIL_JA_CADASTRADO");
    const uid = `usr_${randomUUID()}`;
    const wid = `ws_${randomUUID()}`;
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("insert into users (id, name, email, password_hash) values ($1,$2,$3,$4)", [uid, b.name, b.email, await hashPassword(b.password)]);
      await c.query("insert into workspaces (id, name) values ($1,$2)", [wid, b.company ?? b.name]);
      await c.query("insert into memberships (user_id, workspace_id) values ($1,$2)", [uid, wid]);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
    setSession(reply, uid, wid);
    return reply.code(201).send(await me(uid, wid));
  });

  app.post("/api/auth/login", async (req, reply) => {
    const b = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(req.body);
    const r = await pool.query(
      `select u.id, u.password_hash, m.workspace_id from users u join memberships m on m.user_id = u.id
       where u.email = $1 order by m.created_at limit 1`,
      [b.email],
    );
    if (!r.rowCount || !(await verifyPassword(b.password, r.rows[0].password_hash))) throw err(401, "EMAIL_OU_SENHA_INVALIDOS");
    setSession(reply, r.rows[0].id, r.rows[0].workspace_id);
    return me(r.rows[0].id, r.rows[0].workspace_id);
  });

  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", async (req) => me(req.session!.uid, req.session!.wid));

  app.get("/api/models", async () => ({
    auto: { id: "auto", label: "Dohko One", description: "Escolhe automaticamente o melhor modelo para cada pedido" },
    models: catalog.list(),
  }));

  app.get("/api/plans", async () => Object.values(PLANS).filter((p) => p.priceBRL > 0));

  app.get("/api/ledger", async (req) => {
    const r = await pool.query(
      `select l.type, l.amount, l.action_id, l.created_at, b.kind
       from credit_ledger l left join credit_buckets b on b.id = l.bucket_id
       where l.workspace_id = $1 and l.type in ('grant','debit','expire','writeoff')
       order by l.created_at desc limit 100`,
      [req.session!.wid],
    );
    return r.rows;
  });

  // ---------- Conversas ----------

  const loadConv = async (req: FastifyRequest, id: string) => {
    const r = await pool.query("select * from conversations where id = $1 and workspace_id = $2 and user_id = $3", [id, req.session!.wid, req.session!.uid]);
    if (!r.rowCount) throw err(404, "CONVERSA_NAO_ENCONTRADA");
    return r.rows[0];
  };

  app.get("/api/conversations", async (req) => {
    const { kind } = z.object({ kind: z.enum(["chat", "build"]).optional() }).parse(req.query);
    const r = await pool.query(
      `select id, kind, title, artifact_version, updated_at from conversations
       where workspace_id = $1 and user_id = $2 and ($3::text is null or kind = $3)
       order by updated_at desc limit 100`,
      [req.session!.wid, req.session!.uid, kind ?? null],
    );
    return r.rows;
  });

  app.post("/api/conversations", async (req, reply) => {
    const b = z.object({ kind: z.enum(["chat", "build"]), title: z.string().trim().min(1).max(120).optional() }).parse(req.body);
    const id = `cv_${randomUUID()}`;
    const title = b.title ?? (b.kind === "build" ? "Novo app" : "Nova conversa");
    await pool.query("insert into conversations (id, workspace_id, user_id, kind, title) values ($1,$2,$3,$4,$5)", [id, req.session!.wid, req.session!.uid, b.kind, title]);
    return reply.code(201).send({ id, kind: b.kind, title, artifact_version: 0 });
  });

  app.get("/api/conversations/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const c = await loadConv(req, id);
    const m = await pool.query("select id, role, content, model, credits, created_at from messages where conversation_id = $1 order by created_at", [id]);
    return { id: c.id, kind: c.kind, title: c.title, artifactHtml: c.artifact_html, artifactVersion: c.artifact_version, messages: m.rows };
  });

  app.patch("/api/conversations/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ title: z.string().trim().min(1).max(120) }).parse(req.body);
    await loadConv(req, id);
    await pool.query("update conversations set title = $2 where id = $1", [id, b.title]);
    return { ok: true };
  });

  app.delete("/api/conversations/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadConv(req, id);
    await pool.query("delete from conversations where id = $1", [id]);
    return { ok: true };
  });

  // ---------- Montagem do pedido ao modelo ----------

  const buildTurn = async (conv: any, content: string, modelChoice: string) => {
    const kind: Kind = conv.kind;
    const hist = await pool.query(
      `select role, content from (select role, content, created_at from messages where conversation_id = $1 order by created_at desc limit $2) t order by created_at`,
      [conv.id, HISTORY_LIMIT],
    );
    const historyChars = hist.rows.reduce((s, m) => s + m.content.length, 0);

    let modelId: string;
    let reason: string;
    if (modelChoice === "auto") {
      if (kind === "build") {
        modelId = catalog.tierDefault.build;
        reason = "construção de app";
      } else {
        const r = routeTier(content, historyChars);
        modelId = catalog.tierDefault[r.tier];
        reason = r.reason;
      }
    } else {
      if (!catalog.get(modelChoice)) throw err(400, "MODELO_DESCONHECIDO");
      modelId = modelChoice;
      reason = "escolhido por você";
    }

    const system = kind === "build" ? BUILDER_SYSTEM(conv.artifact_html) : CHAT_SYSTEM;
    const messages: ChatMsg[] = [{ role: "system", content: system }, ...hist.rows, { role: "user", content }];
    const inputTokens = approxTokens(messages.map((m) => m.content).join("\n"));
    const expected = creditsFor({ mode: kind, calls: [{ model: modelId, inputTokens, outputTokens: LIMITS[kind].expectedOut }] });
    const reserve = ceil2(Math.max(expected * 1.5, kind === "build" ? 0.5 : 0.05));
    return { kind, modelId, reason, messages, inputTokens, expected, reserve };
  };

  app.post("/api/estimate", async (req) => {
    const b = z.object({ conversationId: z.string(), content: z.string(), model: z.string().default("auto") }).parse(req.body);
    const conv = await loadConv(req, b.conversationId);
    const t = await buildTurn(conv, b.content || " ", b.model);
    const m = catalog.get(t.modelId)!;
    return { model: { id: m.id, label: m.label }, reason: t.reason, expected: t.expected };
  });

  // ---------- Enviar mensagem (resposta em streaming via SSE) ----------

  app.post("/api/conversations/:id/messages", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z.object({ content: z.string().trim().min(1).max(50_000), model: z.string().default("auto") }).parse(req.body);
    const { wid } = req.session!;
    const conv = await loadConv(req, id);
    const turn = await buildTurn(conv, b.content, b.model);
    const model = catalog.get(turn.modelId)!;
    const actionId = `act_${randomUUID()}`;

    // 1. reserva antes de chamar o modelo (402 se faltar saldo)
    await engine.grantDaily(wid);
    try {
      await engine.reserve(wid, actionId, turn.kind, turn.reserve);
    } catch (e) {
      if (!(e instanceof InsufficientCreditsError)) throw e;
      // sem saldo para a folga, mas com saldo para o custo esperado: reserva o que há
      if (e.available >= turn.expected) {
        await engine.reserve(wid, actionId, turn.kind, e.available);
      } else {
        return reply.code(402).send({ error: "SALDO_INSUFICIENTE", needed: turn.expected, available: e.available });
      }
    }

    await pool.query("insert into messages (id, conversation_id, role, content) values ($1,$2,'user',$3)", [`msg_${randomUUID()}`, id, b.content]);
    if (conv.title === "Nova conversa" || conv.title === "Novo app") {
      const title = b.content.replace(/\s+/g, " ").slice(0, 60);
      await pool.query("update conversations set title = $2 where id = $1", [id, title]);
    }

    // 2. abre o stream
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    send("meta", { model: { id: model.id, label: model.label, vendor: model.vendor }, reason: turn.reason, expected: turn.expected });

    let output = "";
    let usage: { inputTokens: number; outputTokens: number; costUSD?: number } | null = null;
    let failure: unknown = null;
    try {
      usage = await d.provider.stream(
        { model: model.providerModel, messages: turn.messages, maxTokens: LIMITS[turn.kind].maxTokens, signal: abort.signal },
        (t) => {
          output += t;
          send("delta", { t });
        },
      );
    } catch (e) {
      failure = e;
    }

    // 3. cobra o real (ou libera se nada foi gerado)
    try {
      if (!output) {
        await engine.release(wid, actionId);
        if (failure) {
          req.log.error(failure, "falha no provedor");
          send("error", { error: abort.signal.aborted ? "CANCELADO" : "FALHA_NO_MODELO", message: "O modelo não respondeu. Nenhum crédito foi cobrado." });
        }
        return res.end();
      }

      const u = usage ?? { inputTokens: turn.inputTokens, outputTokens: approxTokens(output) };
      const usageEvent = {
        mode: turn.kind,
        calls: [{ model: model.id, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUSD: u.costUSD }],
      };
      const settle = await engine.settle(wid, actionId, usageEvent);

      let artifactVersion: number | null = null;
      let html: string | null = null;
      if (turn.kind === "build") {
        html = extractHtml(output);
        if (html) {
          const r = await pool.query(
            "update conversations set artifact_html = $2, artifact_version = artifact_version + 1 where id = $1 returning artifact_version",
            [id, html],
          );
          artifactVersion = r.rows[0].artifact_version;
        }
      }
      const stored = turn.kind === "build" ? stripHtmlBlock(output, artifactVersion) : output;
      const msgId = `msg_${randomUUID()}`;
      await pool.query("insert into messages (id, conversation_id, role, content, model, credits) values ($1,$2,'assistant',$3,$4,$5)", [msgId, id, stored, model.id, settle.charged]);
      await pool.query("update conversations set updated_at = now() where id = $1", [id]);
      await pool.query(
        `insert into action_usage (action_id, workspace_id, mode, task_type, input_tokens, output_tokens, tool_cost_usd, real_cost_brl, credits, writeoff)
         values ($1,$2,$3,$4,$5,$6,0,$7,$8,$9) on conflict do nothing`,
        [actionId, wid, turn.kind, `${turn.kind}:${model.id}`, u.inputTokens, u.outputTokens, realCostBRL(usageEvent), settle.charged, settle.writeoff],
      );

      send("done", {
        messageId: msgId,
        content: stored,
        credits: settle.charged,
        artifactVersion,
        artifactHtml: html,
        partial: !!failure,
        balance: await engine.balance(wid),
      });
    } catch (e) {
      req.log.error(e, "falha ao fechar a cobrança");
      send("error", { error: "ERRO_INTERNO" });
    }
    res.end();
  });

  // ---------- Cobrança ----------

  app.post("/api/billing/checkout", async (req) => {
    const b = z.object({ planId: z.string() }).parse(req.body);
    return { url: await createPlanCheckout(d.billing(), req.session!.wid, b.planId) };
  });

  app.post("/api/billing/topup", async (req) => {
    const b = z.object({ credits: z.number().int() }).parse(req.body);
    return { url: await createTopupCheckout(d.billing(), req.session!.wid, b.credits) };
  });
}
