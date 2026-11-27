import type { ConvSummary, Me } from "../api";
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
}

export function Sidebar({ me, convs, activeId, onSelect, onNew, onDelete, onPlans, onLogout, onAdmin }: Props) {
  const chats = convs.filter((c) => c.kind === "chat");
  const apps = convs.filter((c) => c.kind === "build");
  const b = me.balance;

  const Item = ({ c }: { c: ConvSummary }) => (
    <div className={`conv ${c.id === activeId ? "active" : ""}`} onClick={() => onSelect(c.id)} title={c.title}>
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

      {me.isAdmin && (
        <button className="admin-link" onClick={onAdmin}>📊 Painel de uso e margem</button>
      )}
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
          <span className="muted small">{me.workspace.name}</span>
        </div>
        <button className="link small" onClick={onLogout}>Sair</button>
      </div>
    </aside>
  );
}
