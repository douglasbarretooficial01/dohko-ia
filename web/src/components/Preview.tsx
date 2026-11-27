import { useState } from "react";

export function Preview({ html, version, title, building }: { html: string | null; version: number; title: string; building: boolean }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [tab, setTab] = useState<"preview" | "code">("preview");

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
