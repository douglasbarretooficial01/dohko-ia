export interface Balance {
  total: number;
  daily: { build: number; chat: number };
  general: number;
  nextExpiry: string | null;
}
export interface Plan {
  id: string;
  name: string;
  priceBRL: number;
  monthlyCredits: number;
}
export interface Me {
  user: { id: string; name: string; email: string };
  isAdmin?: boolean;
  workspace: { id: string; name: string; planId: string; plan?: Plan };
  balance: Balance;
}
export interface ModelInfo {
  id: string;
  label: string;
  vendor: string;
  description: string;
  tier: "fast" | "balanced" | "deep";
}
export interface ConvSummary {
  id: string;
  kind: "chat" | "build";
  title: string;
  artifact_version: number;
  updated_at: string;
}
export interface AttachmentRef {
  id: string;
  name: string;
  kind: "text" | "image";
}
export interface UploadedFile extends AttachmentRef {
  size: number;
  chars: number;
  truncated: boolean;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string | null;
  credits?: number | null;
  attachments?: AttachmentRef[];
}
export interface Published {
  slug: string;
  version: number;
  at: string;
}
export interface Conversation {
  id: string;
  kind: "chat" | "build";
  title: string;
  artifactHtml: string | null;
  artifactVersion: number;
  published: Published | null;
  messages: Message[];
}

export interface AdminStats {
  days: number;
  creditValueBRL: number;
  totals: {
    actions: number;
    credits: number;
    creditsPaid: number;
    creditsFree: number;
    revenueNominalBRL: number;
    costBRL: number;
    grossMargin: number | null;
    writeoffCredits: number;
    activeWorkspaces: number;
  };
  users: { total: number; new: number };
  plans: { planId: string; name: string; workspaces: number }[];
  mrrBRL: number;
  byModel: { mode: string; model: string; actions: number; input_tokens: number; output_tokens: number; credits: number; cost: number; margin: number | null }[];
  byDay: { day: string; actions: number; credits: number; cost: number }[];
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public data: any) {
    super(code);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.error ?? "ERRO", data);
  return data as T;
}

export const api = {
  me: () => req<Me>("GET", "/api/me"),
  signup: (b: { name: string; email: string; password: string; company?: string }) => req<Me>("POST", "/api/auth/signup", b),
  login: (b: { email: string; password: string }) => req<Me>("POST", "/api/auth/login", b),
  logout: () => req("POST", "/api/auth/logout"),
  models: () => req<{ auto: { id: string; label: string; description: string }; models: ModelInfo[] }>("GET", "/api/models"),
  plans: () => req<Plan[]>("GET", "/api/plans"),
  conversations: () => req<ConvSummary[]>("GET", "/api/conversations"),
  createConversation: (kind: "chat" | "build") => req<ConvSummary>("POST", "/api/conversations", { kind }),
  conversation: (id: string) => req<Conversation>("GET", `/api/conversations/${id}`),
  rename: (id: string, title: string) => req("PATCH", `/api/conversations/${id}`, { title }),
  remove: (id: string) => req("DELETE", `/api/conversations/${id}`),
  estimate: (conversationId: string, content: string, model: string, attachmentIds: string[] = []) =>
    req<{ model: { id: string; label: string }; reason: string; expected: number }>("POST", "/api/estimate", { conversationId, content, model, attachmentIds }),
  publish: (id: string) => req<{ slug: string; url: string; version: number }>("POST", `/api/conversations/${id}/publish`),
  unpublish: (id: string) => req("DELETE", `/api/conversations/${id}/publish`),
  adminStats: (days: number) => req<AdminStats>("GET", `/api/admin/stats?days=${days}`),
  upload: async (file: File): Promise<UploadedFile> => {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/uploads", { method: "POST", body: fd, credentials: "same-origin" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, data.error ?? "ERRO", data);
    return data;
  },
  checkout: (planId: string) => req<{ url: string }>("POST", "/api/billing/checkout", { planId }),
  topup: (credits: number) => req<{ url: string }>("POST", "/api/billing/topup", { credits }),
};

export interface StreamHandlers {
  onMeta: (d: { model: { id: string; label: string; vendor: string }; reason: string; expected: number }) => void;
  onDelta: (t: string) => void;
  onDone: (d: { messageId: string; content: string; credits: number; artifactVersion: number | null; artifactHtml: string | null; balance: Balance }) => void;
  onError: (d: { error: string; message?: string }) => void;
}

/** Envia a mensagem e lê a resposta em streaming (SSE sobre fetch). */
export async function sendMessage(convId: string, content: string, model: string, h: StreamHandlers, signal?: AbortSignal, attachmentIds: string[] = []) {
  const r = await fetch(`/api/conversations/${convId}/messages`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, model, attachmentIds }),
    signal,
  });
  if (!r.ok || !r.body) {
    const data = await r.json().catch(() => ({}));
    throw new ApiError(r.status, data.error ?? "ERRO", data);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = block.match(/^event: (.+)$/m)?.[1];
      const raw = block.match(/^data: (.+)$/m)?.[1];
      if (!ev || !raw) continue;
      const data = JSON.parse(raw);
      if (ev === "meta") h.onMeta(data);
      else if (ev === "delta") h.onDelta(data.t);
      else if (ev === "done") h.onDone(data);
      else if (ev === "error") h.onError(data);
    }
  }
}

export const fmt = (n: number, max = 2) => n.toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: max });
export const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
