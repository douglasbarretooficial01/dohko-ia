import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type pg from "pg";
import { z } from "zod";

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
export const INVITE_TTL_DAYS = 7;

/** Valida um convite e devolve o workspace e o papel. Lança erro se inválido. */
export async function checkInvite(db: pg.Pool | pg.PoolClient, token: string) {
  const r = await db.query(
    `select i.workspace_id, i.role, i.expires_at, i.used_by, w.name as workspace_name, u.name as inviter
     from workspace_invites i join workspaces w on w.id = i.workspace_id join users u on u.id = i.created_by
     where i.token = $1`,
    [token],
  );
  if (!r.rowCount) throw err(404, "CONVITE_INVALIDO");
  const i = r.rows[0];
  if (i.used_by) throw err(410, "CONVITE_JA_USADO");
  if (new Date(i.expires_at) < new Date()) throw err(410, "CONVITE_EXPIRADO");
  return i as { workspace_id: string; role: "owner" | "member"; workspace_name: string; inviter: string };
}

/** Coloca o usuário no workspace do convite e marca o convite como usado (idempotente para quem já é membro). */
export async function acceptInvite(db: pg.Pool | pg.PoolClient, token: string, userId: string) {
  const i = await checkInvite(db, token);
  await db.query("insert into memberships (user_id, workspace_id, role) values ($1,$2,$3) on conflict do nothing", [userId, i.workspace_id, i.role]);
  await db.query("update workspace_invites set used_by = $2, used_at = now() where token = $1", [token, userId]);
  return i.workspace_id;
}

export async function teamRoutes(app: FastifyInstance, d: { pool: pg.Pool; setSession: (reply: FastifyReply, uid: string, wid: string) => void }) {
  const { pool } = d;
  const ownerOnly = (role?: string) => {
    if (role !== "owner") throw err(403, "SOMENTE_DONO");
  };

  // público: mostra de quem é o convite antes de cadastrar/entrar
  app.get("/api/invites/:token", async (req) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const i = await checkInvite(pool, token);
    return { workspaceName: i.workspace_name, inviter: i.inviter };
  });

  app.post("/api/team/accept", async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.body);
    const wid = await acceptInvite(pool, token, req.session!.uid);
    d.setSession(reply, req.session!.uid, wid);
    return { workspaceId: wid };
  });

  app.get("/api/team", async (req) => {
    const { wid } = req.session!;
    const members = await pool.query(
      `select u.id, u.name, u.email, m.role, m.created_at as joined_at from memberships m join users u on u.id = m.user_id
       where m.workspace_id = $1 order by m.created_at`,
      [wid],
    );
    const invites =
      req.role === "owner"
        ? (
            await pool.query(
              "select token, role, expires_at, created_at from workspace_invites where workspace_id = $1 and used_by is null and expires_at > now() order by created_at desc",
              [wid],
            )
          ).rows
        : [];
    return { role: req.role, members: members.rows, invites };
  });

  app.post("/api/team/invites", async (req, reply) => {
    ownerOnly(req.role);
    const { role } = z.object({ role: z.enum(["member", "owner"]).default("member") }).parse(req.body ?? {});
    const token = randomBytes(18).toString("base64url");
    await pool.query("insert into workspace_invites (token, workspace_id, created_by, role, expires_at) values ($1,$2,$3,$4, now() + make_interval(days => $5))", [
      token,
      req.session!.wid,
      req.session!.uid,
      role,
      INVITE_TTL_DAYS,
    ]);
    return reply.code(201).send({ token, path: `/?convite=${token}`, role, expiresInDays: INVITE_TTL_DAYS });
  });

  app.delete("/api/team/invites/:token", async (req) => {
    ownerOnly(req.role);
    const { token } = z.object({ token: z.string() }).parse(req.params);
    await pool.query("delete from workspace_invites where token = $1 and workspace_id = $2 and used_by is null", [token, req.session!.wid]);
    return { ok: true };
  });

  app.delete("/api/team/members/:userId", async (req) => {
    ownerOnly(req.role);
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    if (userId === req.session!.uid) throw err(400, "NAO_PODE_REMOVER_A_SI_MESMO");
    const r = await pool.query("delete from memberships where user_id = $1 and workspace_id = $2", [userId, req.session!.wid]);
    if (!r.rowCount) throw err(404, "MEMBRO_NAO_ENCONTRADO");
    return { ok: true };
  });

  app.post("/api/workspaces/switch", async (req, reply) => {
    const { workspaceId } = z.object({ workspaceId: z.string() }).parse(req.body);
    const r = await pool.query("select 1 from memberships where user_id = $1 and workspace_id = $2", [req.session!.uid, workspaceId]);
    if (!r.rowCount) throw err(404, "WORKSPACE_NAO_ENCONTRADO");
    d.setSession(reply, req.session!.uid, workspaceId);
    return { workspaceId };
  });
}
