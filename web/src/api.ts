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
  interval: "month" | "year";
  tierCredits: number;
  topupPriceBRL: number | null;
}
export interface WorkspaceRef {
  id: string;
  name: string;
  planId: string;
  role: "owner" | "member";
}
export interface Me {
  user: { id: string; name: string; email: string };
  isAdmin?: boolean;
  role: "owner" | "member";
  workspaces: WorkspaceRef[];
  workspace: { id: string; name: string; planId: string; plan?: Plan; hasSubscription?: boolean };
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
  updated_at?: string;
  expert_id?: string | null;
  expert_emoji?: string | null;
  expert_name?: string | null;
}
export interface ExpertSummary {
  id: string;
  name: string;
  emoji: string;
  description: string;
  model: string;
  created_by: string;
  created_by_name: string;
  files: number;
}
export interface ExpertDetail {
  id: string;
  name: string;
  emoji: string;
  description: string;
  instructions: string;
  model: string;
  canEdit: boolean;
  files: { id: string; name: string; size_bytes: number; truncated: boolean; chars: number }[];
  knowledgeChars: number;
  knowledgeLimit: number;
}
export interface ExpertInput {
  name: string;
  emoji: string;
  description: string;
  instructions: string;
  model: string;
}
export interface ExpertTemplate extends Omit<ExpertInput, "model"> {
  key: string;
}
export interface TeamData {
  role: "owner" | "member";
  members: { id: string; name: string; email: string; role: "owner" | "member"; joined_at: string }[];
  invites: { token: string; role: string; expires_at: string }[];
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
  expert: { id: string; name: string; emoji: string; description: string } | null;
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
  signup: (b: { name: string; email: string; password: string; company?: string; inviteToken?: string }) => req<Me>("POST", "/api/auth/signup", b),
  login: (b: { email: string; password: string; inviteToken?: string }) => req<Me>("POST", "/api/auth/login", b),
  forgot: (email: string) => req<{ ok: true }>("POST", "/api/auth/forgot", { email }),
  resetInfo: (token: string) => req<{ email: string }>("GET", `/api/auth/reset/${token}`),
  resetPassword: (token: string, password: string) => req<Me>("POST", "/api/auth/reset", { token, password }),
  invite: (token: string) => req<{ workspaceName: string; inviter: string }>("GET", `/api/invites/${token}`),
  acceptInvite: (token: string) => req<{ workspaceId: string }>("POST", "/api/team/accept", { token }),
  switchWorkspace: (workspaceId: string) => req("POST", "/api/workspaces/switch", { workspaceId }),
  team: () => req<TeamData>("GET", "/api/team"),
  createInvite: () => req<{ token: string; path: string; expiresInDays: number }>("POST", "/api/team/invites", {}),
  revokeInvite: (token: string) => req("DELETE", `/api/team/invites/${token}`),
  removeMember: (userId: string) => req("DELETE", `/api/team/members/${userId}`),
  experts: () => req<ExpertSummary[]>("GET", "/api/experts"),
  expert: (id: string) => req<ExpertDetail>("GET", `/api/experts/${id}`),
  expertTemplates: () => req<ExpertTemplate[]>("GET", "/api/expert-templates"),
  createExpert: (b: ExpertInput) => req<{ id: string }>("POST", "/api/experts", b),
  updateExpert: (id: string, b: ExpertInput) => req("PATCH", `/api/experts/${id}`, b),
  deleteExpert: (id: string) => req("DELETE", `/api/experts/${id}`),
  deleteExpertFile: (id: string, fileId: string) => req("DELETE", `/api/experts/${id}/files/${fileId}`),
  uploadExpertFile: async (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`/api/experts/${id}/files`, { method: "POST", body: fd, credentials: "same-origin" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(r.status, data.error ?? "ERRO", data);
    return data as { id: string; name: string; chars: number; truncated: boolean };
  },
  logout: () => req("POST", "/api/auth/logout"),
  models: () => req<{ auto: { id: string; label: string; description: string }; models: ModelInfo[] }>("GET", "/api/models"),
  plans: () => req<Plan[]>("GET", "/api/plans"),
  conversations: () => req<ConvSummary[]>("GET", "/api/conversations"),
  createConversation: (kind: "chat" | "build", expertId?: string) => req<ConvSummary>("POST", "/api/conversations", { kind, expertId }),
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
  changePlan: (planId: string) => req<{ planId: string }>("POST", "/api/billing/change", { planId }),
  portal: () => req<{ url: string }>("POST", "/api/billing/portal"),
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
