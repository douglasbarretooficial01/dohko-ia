import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { hashPassword, hashToken, newToken, signSession, verifyPassword, verifySession, type Session } from "../auth.js";
import { LogMailer, resetEmail, type Mailer } from "../mail.js";
import { createPlanCheckout, createTopupCheckout, type BillingDeps } from "../billing/stripe.js";
import { PLANS } from "../credits/config.js";
import type { CreditEngine } from "../credits/engine.js";
import { InsufficientCreditsError } from "../credits/engine.js";
import { ceil2, creditsFor, realCostBRL } from "../credits/pricing.js";
import type { ModelCatalog } from "../llm/models.js";
import { BUILDER_SYSTEM, CHAT_SYSTEM, extractHtml, stripHtmlBlock } from "../llm/prompts.js";
import { approxInputTokens, approxTokens, type ChatMsg, type ContentPart, type LLMProvider } from "../llm/provider.js";
import { CONFIG } from "../credits/config.js";
import { attachmentBlock, extract, slugify, UploadError } from "../uploads.js";
import { expertRoutes, expertSystemPrompt, loadExpertContext } from "./experts.js";
import { acceptInvite, checkInvite, teamRoutes } from "./team.js";
import { routeTier } from "../llm/router.js";

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
    role?: "owner" | "member";
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
  adminEmails?: string[];
  mailer?: Mailer;
  appUrl?: string;
}

const RESET_TTL_MIN = 60;
const RESET_MAX_PER_HOUR = 3;

interface AttachmentRow {
  id: string;
  name: string;
  mime: string;
  kind: "text" | "image";
  text_content: string | null;
  data: Buffer | null;
  truncated: boolean;
  message_id?: string | null;
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
  const admins = new Set((d.adminEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  const isAdmin = (email: string) => admins.has(email.toLowerCase());

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
    if (["/api/auth/signup", "/api/auth/login", "/api/auth/forgot", "/api/auth/reset"].some((p) => req.url.startsWith(p))) return;
    if (req.method === "GET" && req.url.startsWith("/api/invites/")) return;
    const s = verifySession(req.cookies[COOKIE], d.sessionSecret);
    if (!s) throw err(401, "SESSAO_INVALIDA");
    // quem foi removido da equipe perde o acesso na hora, mesmo com o cookie válido;
    // depois de uma troca de senha, sessões emitidas antes dela deixam de valer
    const m = await pool.query(
      "select m.role, u.password_changed_at from memberships m join users u on u.id = m.user_id where m.user_id = $1 and m.workspace_id = $2",
      [s.uid, s.wid],
    );
    if (!m.rowCount) throw err(401, "SESSAO_INVALIDA");
    const changed = m.rows[0].password_changed_at as Date | null;
    if (changed && (s.iat ?? 0) < Math.floor(changed.getTime() / 1000)) throw err(401, "SESSAO_INVALIDA");
    req.session = s;
    req.role = m.rows[0].role;
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
    const ws = await pool.query(
      `select w.id, w.name, w.plan_id, m.role from memberships m join workspaces w on w.id = m.workspace_id where m.user_id = $1 order by m.created_at`,
      [uid],
    );
    return {
      workspaces: ws.rows.map((w) => ({ id: w.id, name: w.name, planId: w.plan_id, role: w.role })),
      role: ws.rows.find((w) => w.id === wid)?.role ?? "member",
      user: { id: x.id, name: x.name, email: x.email },
      isAdmin: isAdmin(x.email),
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
        inviteToken: z.string().optional(),
      })
      .parse(req.body);
    const exists = await pool.query("select 1 from users where email = $1", [b.email]);
    if (exists.rowCount) throw err(409, "EMAIL_JA_CADASTRADO");
    if (b.inviteToken) await checkInvite(pool, b.inviteToken); // erro claro antes de criar a conta
    const uid = `usr_${randomUUID()}`;
    let wid = `ws_${randomUUID()}`;
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("insert into users (id, name, email, password_hash) values ($1,$2,$3,$4)", [uid, b.name, b.email, await hashPassword(b.password)]);
      if (b.inviteToken) {
        wid = await acceptInvite(c, b.inviteToken, uid); // entra na equipe de quem convidou
      } else {
        await c.query("insert into workspaces (id, name) values ($1,$2)", [wid, b.company ?? b.name]);
        await c.query("insert into memberships (user_id, workspace_id) values ($1,$2)", [uid, wid]);
      }
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
    const b = z.object({ email: z.string().trim().toLowerCase(), password: z.string(), inviteToken: z.string().optional() }).parse(req.body);
    const r = await pool.query(
      `select u.id, u.password_hash, m.workspace_id from users u join memberships m on m.user_id = u.id
       where u.email = $1 order by m.created_at limit 1`,
      [b.email],
    );
    if (!r.rowCount || !(await verifyPassword(b.password, r.rows[0].password_hash))) throw err(401, "EMAIL_OU_SENHA_INVALIDOS");
    const wid = b.inviteToken ? await acceptInvite(pool, b.inviteToken, r.rows[0].id) : r.rows[0].workspace_id;
    setSession(reply, r.rows[0].id, wid);
    return me(r.rows[0].id, wid);
  });

  // ---------- Recuperação de senha ----------

  const mailer = d.mailer ?? new LogMailer((msg) => app.log.info(msg));

  // Sempre responde igual, exista ou não a conta (não revela quais e-mails estão cadastrados)
  app.post("/api/auth/forgot", async (req) => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email() }).parse(req.body);
    const u = await pool.query("select id, name, email from users where email = $1", [email]);
    if (u.rowCount) {
      const user = u.rows[0];
      const recent = await pool.query("select count(*)::int as n from password_resets where user_id = $1 and created_at > now() - interval '1 hour'", [user.id]);
      if (recent.rows[0].n < RESET_MAX_PER_HOUR) {
        const token = newToken();
        await pool.query("insert into password_resets (token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(mins => $3))", [
          hashToken(token),
          user.id,
          RESET_TTL_MIN,
        ]);
        const link = `${(d.appUrl ?? "").replace(/\/$/, "")}/?redefinir=${token}`;
        try {
          await mailer.send({ to: user.email, ...resetEmail(user.name, link) });
        } catch (e) {
          req.log.error(e, "falha ao enviar e-mail de redefinição");
        }
      }
    }
    return { ok: true };
  });

  const findReset = async (token: string) => {
    const r = await pool.query(
      "select r.user_id, r.expires_at, r.used_at, u.email from password_resets r join users u on u.id = r.user_id where r.token_hash = $1",
      [hashToken(token)],
    );
    if (!r.rowCount) throw err(404, "LINK_INVALIDO");
    if (r.rows[0].used_at) throw err(410, "LINK_JA_USADO");
    if (new Date(r.rows[0].expires_at) < new Date()) throw err(410, "LINK_EXPIRADO");
    return r.rows[0] as { user_id: string; email: string };
  };

  app.get("/api/auth/reset/:token", async (req) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.params);
    const r = await findReset(token);
    return { email: r.email };
  });

  app.post("/api/auth/reset", async (req, reply) => {
    const b = z.object({ token: z.string().min(10), password: z.string().min(8, "A senha precisa de pelo menos 8 caracteres") }).parse(req.body);
    const r = await findReset(b.token);
    const hash = await hashPassword(b.password);
    const c = await pool.connect();
    try {
      await c.query("begin");
      // marca o link como usado de forma atômica (dois cliques simultâneos não trocam a senha duas vezes)
      const used = await c.query("update password_resets set used_at = now() where token_hash = $1 and used_at is null", [hashToken(b.token)]);
      if (!used.rowCount) throw err(410, "LINK_JA_USADO");
      await c.query("update users set password_hash = $2, password_changed_at = now() where id = $1", [r.user_id, hash]);
      await c.query("update password_resets set used_at = now() where user_id = $1 and used_at is null", [r.user_id]); // invalida outros links
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
    const m = await pool.query("select workspace_id from memberships where user_id = $1 order by created_at limit 1", [r.user_id]);
    if (!m.rowCount) throw err(409, "CONTA_SEM_WORKSPACE");
    setSession(reply, r.user_id, m.rows[0].workspace_id);
    return me(r.user_id, m.rows[0].workspace_id);
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
      `select c.id, c.kind, c.title, c.artifact_version, c.updated_at, c.expert_id, e.emoji as expert_emoji, e.name as expert_name
       from conversations c left join experts e on e.id = c.expert_id
       where c.workspace_id = $1 and c.user_id = $2 and ($3::text is null or c.kind = $3)
       order by c.updated_at desc limit 100`,
      [req.session!.wid, req.session!.uid, kind ?? null],
    );
    return r.rows;
  });

  app.post("/api/conversations", async (req, reply) => {
    const b = z
      .object({ kind: z.enum(["chat", "build"]), title: z.string().trim().min(1).max(120).optional(), expertId: z.string().optional() })
      .parse(req.body);
    let expert: { emoji: string; name: string } | null = null;
    if (b.expertId) {
      if (b.kind !== "chat") throw err(400, "ESPECIALISTA_SO_NO_CHAT");
      const e = await pool.query("select emoji, name from experts where id = $1 and workspace_id = $2", [b.expertId, req.session!.wid]);
      if (!e.rowCount) throw err(404, "ESPECIALISTA_NAO_ENCONTRADO");
      expert = e.rows[0];
    }
    const id = `cv_${randomUUID()}`;
    const title = b.title ?? (b.kind === "build" ? "Novo app" : "Nova conversa");
    await pool.query("insert into conversations (id, workspace_id, user_id, kind, title, expert_id) values ($1,$2,$3,$4,$5,$6)", [
      id,
      req.session!.wid,
      req.session!.uid,
      b.kind,
      title,
      b.expertId ?? null,
    ]);
    return reply.code(201).send({ id, kind: b.kind, title, artifact_version: 0, expert_id: b.expertId ?? null, expert_emoji: expert?.emoji ?? null, expert_name: expert?.name ?? null });
  });

  app.get("/api/conversations/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const c = await loadConv(req, id);
    const m = await pool.query("select id, role, content, model, credits, created_at from messages where conversation_id = $1 order by created_at", [id]);
    const att = await pool.query(
      `select a.id, a.name, a.kind, a.message_id from attachments a join messages m on m.id = a.message_id where m.conversation_id = $1 order by a.created_at`,
      [id],
    );
    const byMsg = new Map<string, { id: string; name: string; kind: string }[]>();
    for (const a of att.rows) byMsg.set(a.message_id, [...(byMsg.get(a.message_id) ?? []), { id: a.id, name: a.name, kind: a.kind }]);
    return {
      id: c.id,
      kind: c.kind,
      title: c.title,
      artifactHtml: c.artifact_html,
      artifactVersion: c.artifact_version,
      published: c.published_slug ? { slug: c.published_slug, version: c.published_version, at: c.published_at } : null,
      expert: c.expert_id ? (await pool.query("select id, name, emoji, description from experts where id = $1", [c.expert_id])).rows[0] ?? null : null,
      messages: m.rows.map((r) => ({ ...r, attachments: byMsg.get(r.id) ?? [] })),
    };
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

  const buildTurn = async (conv: any, content: string, modelChoice: string, attachments: AttachmentRow[] = []) => {
    const kind: Kind = conv.kind;
    const hist = await pool.query(
      `select id, role, content from (select id, role, content, created_at from messages where conversation_id = $1 order by created_at desc limit $2) t order by created_at`,
      [conv.id, HISTORY_LIMIT],
    );
    // anexos de mensagens anteriores entram como texto (imagens viram uma nota)
    const histAtt = hist.rowCount
      ? (await pool.query("select message_id, name, kind, text_content, truncated from attachments where message_id = any($1)", [hist.rows.map((r) => r.id)])).rows
      : [];
    const history: ChatMsg[] = hist.rows.map((r) => {
      const extra = histAtt
        .filter((a) => a.message_id === r.id)
        .map((a) => (a.kind === "text" ? attachmentBlock(a) : `\n\n[imagem enviada antes: ${a.name}]`))
        .join("");
      return { role: r.role, content: r.content + extra };
    });
    const attText = attachments.filter((a) => a.kind === "text").map(attachmentBlock).join("");
    const images = attachments.filter((a) => a.kind === "image");
    const historyChars = history.reduce((s, m) => s + (m.content as string).length, 0) + attText.length;

    const expert = conv.expert_id ? await loadExpertContext(pool, conv.expert_id) : null;
    if (expert && modelChoice === "auto" && expert.model !== "auto" && catalog.get(expert.model)) modelChoice = expert.model;
    const knowledgeChars = expert?.knowledge.length ?? 0;

    let modelId: string;
    let reason: string;
    if (modelChoice === "auto") {
      if (kind === "build") {
        modelId = catalog.tierDefault.build;
        reason = "construção de app";
      } else {
        const r = images.length ? { tier: "balanced" as const, reason: "pedido com imagem" } : routeTier(content, historyChars + knowledgeChars);
        modelId = catalog.tierDefault[r.tier];
        reason = r.reason;
      }
    } else {
      if (!catalog.get(modelChoice)) throw err(400, "MODELO_DESCONHECIDO");
      modelId = modelChoice;
      reason = expert && expert.model === modelChoice ? `padrão do especialista ${expert.name}` : "escolhido por você";
    }

    const system = kind === "build" ? BUILDER_SYSTEM(conv.artifact_html) : expert ? expertSystemPrompt(CHAT_SYSTEM, expert) : CHAT_SYSTEM;
    const userContent: ChatMsg["content"] = images.length
      ? [
          { type: "text", text: content + attText } as ContentPart,
          ...images.map((a) => ({ type: "image_url", image_url: { url: `data:${a.mime};base64,${a.data!.toString("base64")}` } }) as ContentPart),
        ]
      : content + attText;
    const messages: ChatMsg[] = [{ role: "system", content: system }, ...history, { role: "user", content: userContent }];
    const inputTokens = approxInputTokens(messages);
    const expected = creditsFor({ mode: kind, calls: [{ model: modelId, inputTokens, outputTokens: LIMITS[kind].expectedOut }] });
    const reserve = ceil2(Math.max(expected * 1.5, kind === "build" ? 0.5 : 0.05));
    return { kind, modelId, reason, messages, inputTokens, expected, reserve };
  };

  const loadPending = async (req: FastifyRequest, ids: string[]) => {
    if (!ids.length) return [] as AttachmentRow[];
    const r = await pool.query(
      `select id, name, mime, kind, text_content, data, truncated from attachments
       where id = any($1) and workspace_id = $2 and user_id = $3 and message_id is null`,
      [ids, req.session!.wid, req.session!.uid],
    );
    if (r.rowCount !== ids.length) throw err(400, "ANEXO_INVALIDO");
    return r.rows as AttachmentRow[];
  };

  app.post("/api/estimate", async (req) => {
    const b = z
      .object({ conversationId: z.string(), content: z.string(), model: z.string().default("auto"), attachmentIds: z.array(z.string()).max(5).default([]) })
      .parse(req.body);
    const conv = await loadConv(req, b.conversationId);
    const t = await buildTurn(conv, b.content || " ", b.model, await loadPending(req, b.attachmentIds));
    const m = catalog.get(t.modelId)!;
    return { model: { id: m.id, label: m.label }, reason: t.reason, expected: t.expected };
  });

  // ---------- Enviar mensagem (resposta em streaming via SSE) ----------

  app.post("/api/conversations/:id/messages", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = z
      .object({ content: z.string().trim().min(1).max(50_000), model: z.string().default("auto"), attachmentIds: z.array(z.string()).max(5).default([]) })
      .parse(req.body);
    const { wid } = req.session!;
    const conv = await loadConv(req, id);
    const attachments = await loadPending(req, b.attachmentIds);
    const turn = await buildTurn(conv, b.content, b.model, attachments);
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

    const userMsgId = `msg_${randomUUID()}`;
    await pool.query("insert into messages (id, conversation_id, role, content) values ($1,$2,'user',$3)", [userMsgId, id, b.content]);
    if (attachments.length) await pool.query("update attachments set message_id = $1 where id = any($2)", [userMsgId, attachments.map((a) => a.id)]);
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

  // ---------- Anexos ----------

  app.post("/api/uploads", async (req, reply) => {
    const file = await req.file();
    if (!file) throw err(400, "ARQUIVO_AUSENTE");
    let buf: Buffer;
    try {
      buf = await file.toBuffer();
    } catch {
      throw err(413, "ARQUIVO_MAIOR_QUE_10MB");
    }
    let ex;
    try {
      ex = await extract(buf, file.filename, file.mimetype);
    } catch (e) {
      if (e instanceof UploadError) throw err(e.statusCode, e.message);
      throw e;
    }
    const id = `att_${randomUUID()}`;
    await pool.query(
      `insert into attachments (id, workspace_id, user_id, name, mime, kind, size_bytes, text_content, data, truncated)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, req.session!.wid, req.session!.uid, file.filename.slice(0, 200), ex.mime, ex.kind, buf.length, ex.text, ex.kind === "image" ? buf : null, ex.truncated],
    );
    return reply.code(201).send({ id, name: file.filename, kind: ex.kind, size: buf.length, chars: ex.text?.length ?? 0, truncated: ex.truncated });
  });

  app.get("/api/attachments/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const r = await pool.query("select mime, kind, data, name from attachments where id = $1 and workspace_id = $2", [id, req.session!.wid]);
    if (!r.rowCount || r.rows[0].kind !== "image") throw err(404, "ANEXO_NAO_ENCONTRADO");
    return reply.header("content-type", r.rows[0].mime).header("cache-control", "private, max-age=86400").send(r.rows[0].data);
  });

  // ---------- Publicação de apps ----------

  app.post("/api/conversations/:id/publish", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const c = await loadConv(req, id);
    if (c.kind !== "build" || !c.artifact_html) throw err(400, "NADA_PARA_PUBLICAR");
    const slug = c.published_slug ?? `${slugify(c.title)}-${randomUUID().slice(0, 6)}`;
    await pool.query(
      "update conversations set published_slug = $2, published_html = artifact_html, published_version = artifact_version, published_at = now() where id = $1",
      [id, slug],
    );
    return { slug, url: `/p/${slug}`, version: c.artifact_version };
  });

  app.delete("/api/conversations/:id/publish", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await loadConv(req, id);
    await pool.query("update conversations set published_slug = null, published_html = null, published_version = null, published_at = null where id = $1", [id]);
    return { ok: true };
  });

  // ---------- Painel de administração ----------

  app.get("/api/admin/stats", async (req) => {
    const u = await pool.query("select email from users where id = $1", [req.session!.uid]);
    if (!u.rowCount || !isAdmin(u.rows[0].email)) throw err(403, "SOMENTE_ADMIN");
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const since = `now() - make_interval(days => ${days})`;
    const value = CONFIG.creditValueBRL;

    const [totals, byModel, byDay, users, plans, paid] = await Promise.all([
      pool.query(`select count(*)::int as actions, coalesce(sum(credits),0) as credits, coalesce(sum(real_cost_brl),0) as cost,
                         coalesce(sum(writeoff),0) as writeoff, count(distinct workspace_id)::int as active_workspaces
                  from action_usage where created_at > ${since}`),
      pool.query(`select split_part(task_type, ':', 1) as mode, split_part(task_type, ':', 2) as model, count(*)::int as actions,
                         sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens,
                         coalesce(sum(credits),0) as credits, coalesce(sum(real_cost_brl),0) as cost
                  from action_usage where created_at > ${since} and task_type like '%:%'
                  group by 1, 2 order by cost desc`),
      pool.query(`select to_char(date_trunc('day', created_at at time zone 'America/Sao_Paulo'), 'YYYY-MM-DD') as day, count(*)::int as actions,
                         coalesce(sum(credits),0) as credits, coalesce(sum(real_cost_brl),0) as cost
                  from action_usage where created_at > ${since} group by 1 order by 1`),
      pool.query(`select count(*)::int as total, count(*) filter (where created_at > ${since})::int as new from users`),
      pool.query(`select plan_id, count(*)::int as n from workspaces group by 1 order by 2 desc`),
      pool.query(`select coalesce(sum(-l.amount) filter (where b.kind in ('plan','topup','bonus')),0) as paid,
                         coalesce(sum(-l.amount) filter (where b.kind in ('daily_chat','daily_build')),0) as free
                  from credit_ledger l join credit_buckets b on b.id = l.bucket_id
                  where l.type = 'debit' and l.created_at > ${since}`),
    ]);

    const t = totals.rows[0];
    const revenue = t.credits * value;
    const mrr = plans.rows.reduce((s, p) => s + (PLANS[p.plan_id]?.priceBRL ?? 0) * p.n, 0);
    return {
      days,
      creditValueBRL: value,
      totals: {
        actions: t.actions,
        credits: t.credits,
        creditsPaid: paid.rows[0].paid,
        creditsFree: paid.rows[0].free,
        revenueNominalBRL: revenue,
        costBRL: t.cost,
        grossMargin: revenue > 0 ? 1 - t.cost / revenue : null,
        writeoffCredits: t.writeoff,
        activeWorkspaces: t.active_workspaces,
      },
      users: users.rows[0],
      plans: plans.rows.map((p) => ({ planId: p.plan_id, name: PLANS[p.plan_id]?.name ?? p.plan_id, workspaces: p.n })),
      mrrBRL: mrr,
      byModel: byModel.rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), margin: r.credits > 0 ? 1 - r.cost / (r.credits * value) : null })),
      byDay: byDay.rows,
    };
  });

  // ---------- Cobrança ----------

  app.post("/api/billing/checkout", async (req) => {
    if (req.role !== "owner") throw err(403, "SOMENTE_DONO");
    const b = z.object({ planId: z.string() }).parse(req.body);
    return { url: await createPlanCheckout(d.billing(), req.session!.wid, b.planId) };
  });

  app.post("/api/billing/topup", async (req) => {
    if (req.role !== "owner") throw err(403, "SOMENTE_DONO");
    const b = z.object({ credits: z.number().int() }).parse(req.body);
    return { url: await createTopupCheckout(d.billing(), req.session!.wid, b.credits) };
  });

  await expertRoutes(app, { pool, catalog });
  await teamRoutes(app, { pool, setSession });
}
