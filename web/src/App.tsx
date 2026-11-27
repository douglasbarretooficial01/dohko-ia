import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ConvSummary, type ExpertSummary, type Me, type ModelInfo } from "./api";
import { AdminPanel } from "./components/AdminPanel";
import { Auth } from "./components/Auth";
import { ExpertsModal } from "./components/ExpertsModal";
import { TeamModal } from "./components/TeamModal";
import { PlansModal } from "./components/PlansModal";
import { Sidebar } from "./components/Sidebar";
import { Workspace } from "./components/Workspace";

export interface ModelsData {
  auto: { id: string; label: string; description: string };
  models: ModelInfo[];
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<ModelsData | null>(null);
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [plansOpen, setPlansOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [experts, setExperts] = useState<ExpertSummary[]>([]);
  const [expertsOpen, setExpertsOpen] = useState<{ id?: string | null } | null>(null);
  const [teamOpen, setTeamOpen] = useState(false);
  const [invite] = useState(() => new URLSearchParams(location.search).get("convite"));

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const refreshMe = useCallback(() => api.me().then(setMe).catch(() => {}), []);
  const refreshConvs = useCallback(() => api.conversations().then(setConvs).catch(() => {}), []);
  const refreshExperts = useCallback(() => api.experts().then(setExperts).catch(() => {}), []);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      })
      .finally(() => setLoading(false));
    const p = new URLSearchParams(location.search).get("pagamento");
    if (p) {
      flash(p === "sucesso" ? "Pagamento aprovado! Seus créditos entram em instantes." : "Pagamento cancelado.");
      history.replaceState(null, "", "/");
    }
  }, [flash]);

  useEffect(() => {
    if (!me) return;
    api.models().then(setModels);
    refreshConvs();
    refreshExperts();
  }, [me?.user.id, me?.workspace.id, refreshConvs, refreshExperts]); // eslint-disable-line react-hooks/exhaustive-deps

  // já logado e abriu um link de convite: entra na equipe
  useEffect(() => {
    if (!me || !invite) return;
    history.replaceState(null, "", "/");
    api
      .acceptInvite(invite)
      .then(() => api.me().then(setMe))
      .then(() => flash("Você entrou na equipe!"))
      .catch((e) => flash(e instanceof ApiError && e.code === "CONVITE_JA_USADO" ? "Este convite já foi usado." : "Convite inválido ou expirado."));
  }, [me?.user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchWorkspace = async (id: string) => {
    await api.switchWorkspace(id);
    setActiveId(null);
    setAdminOpen(false);
    setMe(await api.me());
  };

  const newConversation = async (kind: "chat" | "build", expertId?: string) => {
    const c = await api.createConversation(kind, expertId);
    setConvs((cs) => [c, ...cs]);
    setActiveId(c.id);
    setAdminOpen(false);
    setMenuOpen(false);
  };

  const logout = async () => {
    await api.logout();
    setMe(null);
    setConvs([]);
    setActiveId(null);
  };

  if (loading) return <div className="splash"><div className="logo-mark big">D</div></div>;
  if (!me)
    return (
      <Auth
        invite={invite}
        onAuth={(m) => {
          if (invite) history.replaceState(null, "", "/");
          setMe(m);
        }}
      />
    );

  return (
    <div className={`shell ${menuOpen ? "menu-open" : ""}`}>
      <Sidebar
        me={me}
        convs={convs}
        activeId={activeId}
        onSelect={(id) => {
          setActiveId(id);
          setAdminOpen(false);
          setMenuOpen(false);
        }}
        onAdmin={() => {
          setAdminOpen(true);
          setActiveId(null);
          setMenuOpen(false);
        }}
        onNew={newConversation}
        onDelete={async (id) => {
          await api.remove(id);
          setConvs((cs) => cs.filter((c) => c.id !== id));
          if (activeId === id) setActiveId(null);
        }}
        onPlans={() => setPlansOpen(true)}
        onLogout={logout}
        experts={experts}
        onExpertChat={(id) => newConversation("chat", id)}
        onExperts={() => {
          setExpertsOpen({});
          setMenuOpen(false);
        }}
        onTeam={() => {
          setTeamOpen(true);
          setMenuOpen(false);
        }}
        onSwitchWorkspace={switchWorkspace}
      />
      <div className="backdrop" onClick={() => setMenuOpen(false)} />
      <main className="main">
        <button className="menu-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menu">☰</button>
        {adminOpen ? (
          <AdminPanel onClose={() => setAdminOpen(false)} />
        ) : activeId && models ? (
          <Workspace
            key={activeId}
            convId={activeId}
            models={models}
            onBalance={(balance) => setMe((m) => (m ? { ...m, balance } : m))}
            onTitle={(title) => setConvs((cs) => cs.map((c) => (c.id === activeId ? { ...c, title } : c)))}
            onActivity={refreshConvs}
            onNeedCredits={() => setPlansOpen(true)}
          />
        ) : (
          <Home name={me.user.name} onNew={newConversation} />
        )}
      </main>
      {plansOpen && (
        <PlansModal
          me={me}
          onClose={() => {
            setPlansOpen(false);
            refreshMe();
          }}
          onError={flash}
        />
      )}
      {expertsOpen && models && (
        <ExpertsModal
          models={models}
          initialId={expertsOpen.id}
          onClose={() => setExpertsOpen(null)}
          onChanged={refreshExperts}
          onStart={(id) => {
            setExpertsOpen(null);
            newConversation("chat", id);
          }}
        />
      )}
      {teamOpen && <TeamModal me={me} onClose={() => setTeamOpen(false)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Home({ name, onNew }: { name: string; onNew: (k: "chat" | "build") => void }) {
  return (
    <div className="home">
      <div className="logo-mark big">D</div>
      <h1>Olá, {name.split(" ")[0]}. O que vamos fazer hoje?</h1>
      <p className="muted">Converse com os melhores modelos de IA ou descreva um app e veja ele nascer.</p>
      <div className="home-cards">
        <button className="home-card" onClick={() => onNew("chat")}>
          <span className="home-icon">💬</span>
          <strong>Conversar</strong>
          <span className="muted">GPT, Claude e Gemini em um só lugar. O Dohko One escolhe o modelo certo para cada pedido.</span>
        </button>
        <button className="home-card" onClick={() => onNew("build")}>
          <span className="home-icon">⚡</span>
          <strong>Criar um app</strong>
          <span className="muted">Descreva o que precisa e receba um app funcionando, com prévia ao vivo.</span>
        </button>
      </div>
    </div>
  );
}
