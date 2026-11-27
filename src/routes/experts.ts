import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { EXPERT_TEMPLATES } from "../llm/expert-templates.js";
import type { ModelCatalog } from "../llm/models.js";
import { attachmentBlock, extract, UploadError } from "../uploads.js";

/** Limite de texto da base de conhecimento enviada ao modelo (~37 mil tokens). */
export const KNOWLEDGE_MAX_CHARS = 150_000;
const MAX_FILES = 20;

const err = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export interface ExpertContext {
  name: string;
  emoji: string;
  instructions: string;
  model: string;
  knowledge: string;
}

/** Monta o contexto de um especialista para a conversa (instruções + base de conhecimento). */
export async function loadExpertContext(pool: pg.Pool, expertId: string): Promise<ExpertContext | null> {
  const e = await pool.query("select name, emoji, instructions, model from experts where id = $1", [expertId]);
  if (!e.rowCount) return null;
  const files = await pool.query("select name, text_content, truncated from attachments where expert_id = $1 and kind = 'text' order by created_at", [expertId]);
  let knowledge = "";
  for (const f of files.rows) {
    const block = attachmentBlock(f);
    if (knowledge.length + block.length > KNOWLEDGE_MAX_CHARS) {
      knowledge += attachmentBlock({ name: f.name, text_content: block.slice(0, Math.max(0, KNOWLEDGE_MAX_CHARS - knowledge.length)), truncated: true });
      break;
    }
    knowledge += block;
  }
  return { ...e.rows[0], knowledge };
}

export function expertSystemPrompt(base: string, x: ExpertContext) {
  return `${base}

Você está atuando como o especialista "${x.name}" configurado por esta empresa. Siga estas instruções acima das regras gerais de estilo:
<instrucoes>
${x.instructions}
</instrucoes>${
    x.knowledge
      ? `

Base de conhecimento da empresa (use como fonte principal; se a resposta não estiver aqui, diga isso):
<base_de_conhecimento>${x.knowledge}
</base_de_conhecimento>`
      : ""
  }`;
}

export async function expertRoutes(app: FastifyInstance, d: { pool: pg.Pool; catalog: ModelCatalog }) {
  const { pool } = d;
  const Body = z.object({
    name: z.string().trim().min(2).max(60),
    emoji: z.string().trim().min(1).max(8).default("🤖"),
    description: z.string().trim().max(200).default(""),
    instructions: z.string().trim().min(10, "Escreva instruções com pelo menos 10 caracteres").max(20_000),
    model: z.string().default("auto"),
  });

  const load = async (req: FastifyRequest, id: string, forEdit = false) => {
    const r = await pool.query("select * from experts where id = $1 and workspace_id = $2", [id, req.session!.wid]);
    if (!r.rowCount) throw err(404, "ESPECIALISTA_NAO_ENCONTRADO");
    if (forEdit && r.rows[0].created_by !== req.session!.uid && req.role !== "owner") throw err(403, "SOMENTE_CRIADOR_OU_DONO");
    return r.rows[0];
  };
  const checkModel = (m: string) => {
    if (m !== "auto" && !d.catalog.get(m)) throw err(400, "MODELO_DESCONHECIDO");
  };

  app.get("/api/expert-templates", async () => EXPERT_TEMPLATES);

  app.get("/api/experts", async (req) => {
    const r = await pool.query(
      `select e.id, e.name, e.emoji, e.description, e.model, e.created_by, u.name as created_by_name,
              (select count(*)::int from attachments a where a.expert_id = e.id) as files
       from experts e join users u on u.id = e.created_by
       where e.workspace_id = $1 order by e.updated_at desc`,
      [req.session!.wid],
    );
    return r.rows;
  });

  app.post("/api/experts", async (req, reply) => {
    const b = Body.parse(req.body);
    checkModel(b.model);
    const id = `exp_${randomUUID()}`;
    await pool.query(
      "insert into experts (id, workspace_id, created_by, name, emoji, description, instructions, model) values ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, req.session!.wid, req.session!.uid, b.name, b.emoji, b.description, b.instructions, b.model],
    );
    return reply.code(201).send({ id, ...b });
  });

  app.get("/api/experts/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const e = await load(req, id);
    const files = await pool.query("select id, name, size_bytes, truncated, length(text_content)::int as chars from attachments where expert_id = $1 order by created_at", [id]);
    const totalChars = files.rows.reduce((s, f) => s + (f.chars ?? 0), 0);
    return {
      id: e.id,
      name: e.name,
      emoji: e.emoji,
      description: e.description,
      instructions: e.instructions,
      model: e.model,
      canEdit: e.created_by === req.session!.uid || req.role === "owner",
      files: files.rows,
      knowledgeChars: totalChars,
      knowledgeLimit: KNOWLEDGE_MAX_CHARS,
    };
  });

  app.patch("/api/experts/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await load(req, id, true);
    const b = Body.parse(req.body);
    checkModel(b.model);
    await pool.query("update experts set name=$2, emoji=$3, description=$4, instructions=$5, model=$6, updated_at=now() where id=$1", [
      id,
      b.name,
      b.emoji,
      b.description,
      b.instructions,
      b.model,
    ]);
    return { ok: true };
  });

  app.delete("/api/experts/:id", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await load(req, id, true);
    await pool.query("delete from experts where id = $1", [id]);
    return { ok: true };
  });

  app.post("/api/experts/:id/files", async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await load(req, id, true);
    const count = await pool.query("select count(*)::int as n from attachments where expert_id = $1", [id]);
    if (count.rows[0].n >= MAX_FILES) throw err(400, "LIMITE_DE_20_ARQUIVOS");
    const file = await req.file();
    if (!file) throw err(400, "ARQUIVO_AUSENTE");
    const buf = await file.toBuffer().catch(() => {
      throw err(413, "ARQUIVO_MAIOR_QUE_10MB");
    });
    let ex;
    try {
      ex = await extract(buf, file.filename, file.mimetype);
    } catch (e) {
      if (e instanceof UploadError) throw err(e.statusCode, e.message);
      throw e;
    }
    if (ex.kind !== "text") throw err(415, "BASE_ACEITA_SO_DOCUMENTOS (PDF, DOCX, XLSX, CSV, TXT, MD)");
    const fid = `att_${randomUUID()}`;
    await pool.query(
      `insert into attachments (id, workspace_id, user_id, expert_id, name, mime, kind, size_bytes, text_content, truncated)
       values ($1,$2,$3,$4,$5,$6,'text',$7,$8,$9)`,
      [fid, req.session!.wid, req.session!.uid, id, file.filename.slice(0, 200), ex.mime, buf.length, ex.text, ex.truncated],
    );
    await pool.query("update experts set updated_at = now() where id = $1", [id]);
    return reply.code(201).send({ id: fid, name: file.filename, chars: ex.text?.length ?? 0, truncated: ex.truncated });
  });

  app.delete("/api/experts/:id/files/:fileId", async (req) => {
    const { id, fileId } = z.object({ id: z.string(), fileId: z.string() }).parse(req.params);
    await load(req, id, true);
    await pool.query("delete from attachments where id = $1 and expert_id = $2", [fileId, id]);
    return { ok: true };
  });
}
