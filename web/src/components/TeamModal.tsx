import { useEffect, useState } from "react";
import { api, type Me, type TeamData } from "../api";

export function TeamModal({ me, onClose }: { me: Me; onClose: () => void }) {
  const [team, setTeam] = useState<TeamData | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isOwner = me.role === "owner";

  const reload = () => api.team().then(setTeam);
  useEffect(() => {
    reload();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const invite = async () => {
    const r = await api.createInvite();
    setLink(`${location.origin}${r.path}`);
    setCopied(false);
    reload();
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      /* sem permissão */
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal team-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-x" onClick={onClose} aria-label="Fechar">×</button>
        <h2>Equipe · {me.workspace.name}</h2>
        <p className="muted">Todos usam os mesmos créditos e especialistas. As conversas de cada pessoa continuam privadas.</p>

        {isOwner && (
          <div className="invite-box">
            <div>
              <strong>Convidar pessoas</strong>
              <div className="muted small">Gere um link e envie por WhatsApp ou e-mail. Cada link vale para 1 pessoa por 7 dias.</div>
            </div>
            {link ? (
              <div className="pub-link">
                <input readOnly value={link} onFocus={(e) => e.target.select()} />
                <button className="btn primary sm" onClick={copy}>{copied ? "Copiado ✓" : "Copiar"}</button>
              </div>
            ) : (
              <button className="btn gold" onClick={invite}>Gerar link de convite</button>
            )}
            {link && <button className="link small" onClick={invite}>Gerar outro link</button>}
          </div>
        )}

        <table className="table">
          <thead>
            <tr><th>Pessoa</th><th>Papel</th><th /></tr>
          </thead>
          <tbody>
            {team?.members.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.name}</strong> {m.id === me.user.id && <span className="tag">você</span>}
                  <div className="muted small">{m.email}</div>
                </td>
                <td>{m.role === "owner" ? "Dono" : "Membro"}</td>
                <td style={{ textAlign: "right" }}>
                  {isOwner && m.id !== me.user.id && (
                    <button className="link small danger" onClick={async () => { await api.removeMember(m.id); reload(); }}>Remover</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {isOwner && team && team.invites.length > 0 && (
          <>
            <h3 className="sub">Convites pendentes</h3>
            {team.invites.map((i) => (
              <div key={i.token} className="kfile">
                <span className="muted small">Link …{i.token.slice(-6)} · vence em {new Date(i.expires_at).toLocaleDateString("pt-BR")}</span>
                <button className="link small danger" onClick={async () => { await api.revokeInvite(i.token); reload(); }}>Cancelar</button>
              </div>
            ))}
          </>
        )}
        {!isOwner && <p className="muted small">Só o dono do workspace convida e remove pessoas.</p>}
      </div>
    </div>
  );
}
