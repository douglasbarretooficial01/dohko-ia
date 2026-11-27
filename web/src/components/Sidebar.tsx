import type { ConvSummary, ExpertSummary, Me } from "../api";
import { fmt } from "../api";

interface Props {
  me: Me;
  convs: ConvSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: (kind: "chat" | "build") => void;
  onDelete: (id: string) => void;
  onPlans: () => void;
  onLogout: () => void;
  onAdmin: () => void;
  experts: ExpertSummary[];
  onExpertChat: (id: string) => void;
  onExperts: () => void;
  onTeam: () => void;
  onSwitchWorkspace: (id: string) => void;
}

export function Sidebar({ me, convs, activeId, onSelect, onNew, onDelete, onPlans, onLogout, onAdmin, experts, onExpertChat, onExperts, onTeam, onSwitchWorkspace }: Props) {
  const chats = convs.filter((c) => c.kind === "chat");
  const apps = convs.filter((c) => c.kind === "build");
  const b = me.balance;

  const Item = ({ c }: { c: ConvSummary }) => (
    <div className={`conv ${c.id === activeId ? "active" : ""}`} onClick={() => onSelect(c.id)} title={c.title}>
      {c.expert_emoji && <span className="conv-emoji" title={c.expert_name ?? ""}>{c.expert_emoji}</span>}
      <span className="conv-title">{c.title}</span>
      {c.kind === "build" && c.artifact_version > 0 && <span className="tag">v{c.artifact_version}</span>}
      <button
        className="conv-del"
        aria-label="Apagar"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(c.id);
        }}
      >
        ×
      </button>
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo-mark">D</div>
        <span>Dohko IA</span>
      </div>
      <div className="new-buttons">
        <button className="btn primary" onClick={() => onNew("chat")}>＋ Novo chat</button>
        <button className="btn ghost" onClick={() => onNew("build")}>⚡ Novo app</button>
      </div>

      <div className="conv-list">
        <div className="section section-row">
          <span>Especialistas</span>
          <button className="link small" onClick={onExperts}>{experts.length ? "gerenciar" : "＋ criar"}</button>
        </div>
        {experts.slice(0, 6).map((e) => (
          <div key={e.id} className="conv" onClick={() => onExpertChat(e.id)} title={`Nova conversa com ${e.name}`}>
            <span className="conv-emoji">{e.emoji}</span>
            <span className="conv-title">{e.name}</span>
          </div>
        ))}
        {experts.length === 0 && (
          <button className="expert-cta" onClick={onExperts}>Crie assistentes com as instruções e os documentos da sua empresa</button>
        )}
        {apps.length > 0 && (
          <>
            <div className="section">Apps</div>
            {apps.map((c) => <Item key={c.id} c={c} />)}
          </>
        )}
        <div className="section">Conversas</div>
        {chats.length === 0 && <div className="muted small pad">Nenhuma conversa ainda.</div>}
        {chats.map((c) => <Item key={c.id} c={c} />)}
      </div>

      <div className="side-links">
        <button className="admin-link" onClick={onTeam}>👥 Equipe</button>
        {me.isAdmin && <button className="admin-link" onClick={onAdmin}>📊 Painel</button>}
      </div>
      <div className="credit-card">
        <div className="credit-head">
          <span className="muted small">Créditos</span>
          <span className="plan-pill">{me.workspace.plan?.name ?? "Grátis"}</span>
        </div>
        <div className="credit-total">{fmt(b.total)}</div>
        <div className="credit-rows small">
          <span>Hoje (app): {fmt(b.daily.build)}</span>
          <span>Hoje (chat): {fmt(b.daily.chat)}</span>
          {b.general > 0 && <span>Plano + recargas: {fmt(b.general)}</span>}
        </div>
        <button className="btn gold block" onClick={onPlans}>{me.workspace.planId === "free" ? "Ver planos" : "Comprar créditos"}</button>
      </div>

      <div className="user-row">
        <div className="avatar">{me.user.name[0]?.toUpperCase()}</div>
        <div className="user-info">
          <strong>{me.user.name}</strong>
          {me.workspaces.length > 1 ? (
            <select className="ws-select" value={me.workspace.id} onChange={(e) => onSwitchWorkspace(e.target.value)} title="Trocar de workspace">
              {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          ) : (
            <span className="muted small">{me.workspace.name}</span>
          )}
        </div>
        <button className="link small" onClick={onLogout}>Sair</button>
      </div>
    </aside>
  );
}
