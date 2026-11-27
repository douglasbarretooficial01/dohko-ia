import { extname } from "node:path";

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
/** Texto máximo por arquivo enviado ao modelo (~30 mil tokens). */
export const MAX_TEXT_CHARS = 120_000;
/** Estimativa de tokens por imagem (para a reserva de créditos). */
export const IMAGE_TOKENS = 1_200;

const TEXT_EXT = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".js", ".ts", ".py", ".sql", ".log", ".yaml", ".yml"]);
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

export interface Extracted {
  kind: "text" | "image";
  mime: string;
  text: string | null;
  truncated: boolean;
}

export class UploadError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 415) {
    super(message);
    this.statusCode = statusCode;
  }
}

function clip(text: string) {
  const clean = text.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  return clean.length > MAX_TEXT_CHARS ? { text: clean.slice(0, MAX_TEXT_CHARS), truncated: true } : { text: clean, truncated: false };
}

/** Identifica o arquivo e extrai o texto (ou mantém a imagem) para enviar ao modelo. */
export async function extract(buf: Buffer, filename: string, mime: string): Promise<Extracted> {
  const ext = extname(filename).toLowerCase();
  if (buf.length > MAX_FILE_BYTES) throw new UploadError("ARQUIVO_MAIOR_QUE_10MB", 413);

  if (IMAGE_MIME[ext] || mime.startsWith("image/")) {
    const m = IMAGE_MIME[ext] ?? mime;
    if (!Object.values(IMAGE_MIME).includes(m)) throw new UploadError("FORMATO_DE_IMAGEM_NAO_SUPORTADO");
    if (buf.length > MAX_IMAGE_BYTES) throw new UploadError("IMAGEM_MAIOR_QUE_5MB", 413);
    return { kind: "image", mime: m, text: null, truncated: false };
  }

  if (ext === ".pdf" || mime === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    let text: string;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      text = (await extractText(pdf, { mergePages: true })).text as string;
    } catch {
      throw new UploadError("PDF_ILEGIVEL", 422);
    }
    if (!text.trim()) throw new UploadError("PDF_SEM_TEXTO (provavelmente escaneado: envie como imagem)", 422);
    return { kind: "text", mime: "application/pdf", ...clip(text) };
  }

  if (ext === ".docx") {
    const mammoth = (await import("mammoth")).default;
    try {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return { kind: "text", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ...clip(value) };
    } catch {
      throw new UploadError("DOCX_ILEGIVEL", 422);
    }
  }

  if (ext === ".xlsx") {
    return { kind: "text", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ...clip(await xlsxToText(buf)) };
  }

  if (TEXT_EXT.has(ext) || mime.startsWith("text/")) {
    const text = buf.toString("utf8");
    if (text.includes("���")) throw new UploadError("ARQUIVO_NAO_E_TEXTO");
    return { kind: "text", mime: mime || "text/plain", ...clip(text) };
  }

  throw new UploadError("FORMATO_NAO_SUPORTADO (use PDF, DOCX, XLSX, CSV, TXT, MD, JSON ou imagem)");
}

/** Converte cada aba da planilha em linhas separadas por " | " (valores calculados, não fórmulas). */
async function xlsxToText(buf: Buffer) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as any);
  } catch {
    throw new UploadError("XLSX_ILEGIVEL", 422);
  }
  const cell = (v: any): string => {
    if (v == null) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "object") {
      if ("result" in v) return cell(v.result); // fórmula → valor calculado
      if ("text" in v) return String(v.text); // hiperlink
      if ("richText" in v) return v.richText.map((r: any) => r.text).join("");
      if ("error" in v) return String(v.error);
    }
    return String(v).replace(/\s+/g, " ").trim();
  };
  const parts: string[] = [];
  wb.eachSheet((ws) => {
    const rows: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as any[]).slice(1).map(cell);
      while (values.length && values.at(-1) === "") values.pop();
      if (values.length) rows.push(values.join(" | "));
    });
    if (rows.length) parts.push(`## Aba: ${ws.name}\n${rows.join("\n")}`);
  });
  if (!parts.length) throw new UploadError("PLANILHA_VAZIA", 422);
  return parts.join("\n\n");
}

/** Bloco de texto do anexo como o modelo recebe. */
export function attachmentBlock(a: { name: string; text_content: string | null; truncated: boolean }) {
  return `\n\n<arquivo nome="${a.name.replace(/"/g, "'")}"${a.truncated ? ' cortado="sim"' : ""}>\n${a.text_content ?? ""}\n</arquivo>`;
}

export function slugify(s: string) {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 40)
      .replace(/^-+|-+$/g, "") || "app"
  );
}
