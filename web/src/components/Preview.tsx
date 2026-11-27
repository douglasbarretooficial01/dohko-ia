import { useEffect, useRef, useState } from "react";
import { api, type Published } from "../api";

interface Props {
  convId: string;
  html: string | null;
  version: number;
  title: string;
  building: boolean;
  published: Published | null;
  onPublished: (p: Published | null) => void;
}

export function Preview({ convId, html, version, title, building, published, onPublished }: Props) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [pubOpen, setPubOpen] = useState(false);
  const [pubBusy, setPubBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const pubRef = useRef<HTMLDivElement>(null);
  const link = published ? `${location.origin}/p/${published.slug}` : "";

  useEffect(() => {
    const close = (e: MouseEvent) => !pubRef.current?.contains(e.target as Node) && setPubOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const publish = async () => {
    setPubBusy(true);
    try {
      const r = await api.publish(convId);
      onPublished({ slug: r.slug, version: r.version, at: new Date().toISOString() });
      setPubOpen(true);
    } finally {
      setPubBusy(false);
    }
  };

  const unpublish = async () => {
    setPubBusy(true);
    try {
      await api.unpublish(convId);
      onPublished(null);
    } finally {
      setPubBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* navegador sem permissão de área de transferência */
    }
  };

  const download = () => {
    if (!html) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/gi, "-").slice(0, 40) || "app"}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const openTab = () => {
    if (!html) return;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
  };

  return (
    <section className="preview">
      <header className="preview-head">
        <div className="seg">
          <button className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>Prévia</button>
          <button className={tab === "code" ? "on" : ""} onClick={() => setTab("code")}>Código</button>
        </div>
        {version > 0 && <span className="tag">versão {version}</span>}
        {building && <span className="building small">construindo…</span>}
        <div className="spacer" />
        <div className="seg">
          <button className={device === "desktop" ? "on" : ""} onClick={() => setDevice("desktop")} title="Computador">🖥</button>
          <button className={device === "mobile" ? "on" : ""} onClick={() => setDevice("mobile")} title="Celular">📱</button>
        </div>
        <button className="btn ghost sm" disabled={!html} onClick={openTab}>Abrir ↗</button>
        <button className="btn ghost sm" disabled={!html} onClick={download}>Baixar</button>
        <div className="pub" ref={pubRef}>
          <button className={`btn sm ${published ? "ghost live" : "gold"}`} disabled={!html || pubBusy} onClick={() => (published ? setPubOpen(!pubOpen) : publish())}>
            {published ? "● No ar" : pubBusy ? "Publicando…" : "Publicar"}
          </button>
          {pubOpen && published && (
            <div className="pub-menu">
              <strong>Seu app está no ar</strong>
              <span className="muted small">Qualquer pessoa com o link pode usar.</span>
              <div className="pub-link">
                <input readOnly value={link} onFocus={(e) => e.target.select()} />
                <button className="btn primary sm" onClick={copy}>{copied ? "Copiado ✓" : "Copiar"}</button>
              </div>
              <div className="pub-actions">
                <a className="btn ghost sm" href={link} target="_blank" rel="noopener">Abrir ↗</a>
                {version > published.version && (
                  <button className="btn gold sm" disabled={pubBusy} onClick={publish}>Atualizar para a versão {version}</button>
                )}
                <button className="link small danger" disabled={pubBusy} onClick={unpublish}>Despublicar</button>
              </div>
              {version > published.version && <span className="muted small">O link mostra a versão {published.version}; a prévia está na versão {version}.</span>}
            </div>
          )}
        </div>
      </header>
      <div className="preview-body">
        {!html ? (
          <div className="preview-empty muted">
            <div className="preview-glyph">⚡</div>
            {building ? "Construindo a primeira versão do seu app…" : "A prévia do seu app aparece aqui."}
          </div>
        ) : tab === "code" ? (
          <pre className="code">{html}</pre>
        ) : (
          <div className={`frame-wrap ${device}`}>
            {/* sandbox: o app gerado roda isolado, sem acesso à sessão da Dohko */}
            <iframe title="Prévia do app" sandbox="allow-scripts allow-forms allow-popups allow-modals" srcDoc={html} />
          </div>
        )}
      </div>
    </section>
  );
}
