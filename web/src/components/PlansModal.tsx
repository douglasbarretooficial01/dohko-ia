import { useEffect, useState } from "react";
import { api, ApiError, brl, fmt, type Me, type Plan } from "../api";

const ERRORS: Record<string, string> = {
  STRIPE_NAO_CONFIGURADO: "Os pagamentos ainda não foram configurados neste servidor (falta a chave do Stripe).",
  PLANO_SEM_RECARGA: "Recargas avulsas estão disponíveis a partir do plano Pro.",
};

export function PlansModal({ me, onClose, onError }: { me: Me; onClose: () => void; onError: (msg: string) => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [topup, setTopup] = useState(100);

  useEffect(() => {
    api.plans().then(setPlans);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const go = async (key: string, fn: () => Promise<{ url: string }>) => {
    setBusy(key);
    try {
      const { url } = await fn();
      location.href = url;
    } catch (e) {
      const code = e instanceof ApiError ? e.code.split(":")[0] : "";
      onError(ERRORS[code] ?? (e instanceof ApiError ? e.code : "Não foi possível abrir o pagamento."));
      setBusy(null);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-x" onClick={onClose} aria-label="Fechar">×</button>
        <h2>Planos Dohko IA</h2>
        <p className="muted">
          Preço em reais, cancele quando quiser. Créditos do plano acumulam por 2 meses. Todos os planos mantêm os créditos grátis diários.
        </p>
        {me.role !== "owner" && <div className="notice credits" style={{ margin: "14px 0 0" }}><span>Só o dono do workspace pode assinar planos ou comprar créditos. Os créditos são compartilhados pela equipe.</span></div>}
        <div className="plans">
          {plans.map((p, i) => {
            const current = me.workspace.planId === p.id;
            return (
              <div key={p.id} className={`plan ${i === 1 ? "featured" : ""}`}>
                {i === 1 && <span className="tag gold">Mais escolhido</span>}
                <h3>{p.name}</h3>
                <div className="price">
                  {brl(p.priceBRL)}
                  <span className="muted small">/mês</span>
                </div>
                <div className="muted small">{fmt(p.monthlyCredits, 0)} créditos por mês</div>
                <div className="muted small">{brl(p.priceBRL / p.monthlyCredits)} por crédito</div>
                <button className={`btn block ${i === 1 ? "gold" : "primary"}`} disabled={current || busy !== null || me.role !== "owner"} onClick={() => go(p.id, () => api.checkout(p.id))}>
                  {current ? "Plano atual" : busy === p.id ? "Abrindo…" : "Assinar"}
                </button>
              </div>
            );
          })}
        </div>
        {me.workspace.planId !== "free" && (
          <div className="topup">
            <strong>Recarga avulsa</strong>
            <input type="range" min={50} max={1000} step={50} value={topup} onChange={(e) => setTopup(Number(e.target.value))} />
            <span>{topup} créditos</span>
            <button className="btn primary sm" disabled={busy !== null} onClick={() => go("topup", () => api.topup(topup))}>
              {busy === "topup" ? "Abrindo…" : "Comprar"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
