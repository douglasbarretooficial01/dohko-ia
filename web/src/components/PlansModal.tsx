import { useEffect, useMemo, useState } from "react";
import { api, ApiError, brl, fmt, type Me, type Plan } from "../api";

const ERRORS: Record<string, string> = {
  STRIPE_NAO_CONFIGURADO: "Os pagamentos ainda não foram configurados neste servidor (falta a chave do Stripe).",
  PLANO_SEM_RECARGA: "Recargas avulsas estão disponíveis para quem tem plano pago.",
  JA_TEM_ASSINATURA_TROQUE_O_PLANO: "Você já tem uma assinatura. Use “Trocar para este plano”.",
  SOMENTE_DONO: "Só o dono do workspace pode mudar o plano.",
};

export function PlansModal({ me, onClose, onError }: { me: Me; onClose: () => void; onError: (msg: string) => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const current = me.workspace.plan;
  const [interval, setInterval] = useState<"month" | "year">(current?.interval ?? "month");
  const [tier, setTier] = useState<number>(current?.tierCredits || 100);
  const [busy, setBusy] = useState<string | null>(null);
  const [topup, setTopup] = useState(100);
  const isOwner = me.role === "owner";
  const subscribed = !!me.workspace.hasSubscription;

  useEffect(() => {
    api.plans().then(setPlans);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const tiers = useMemo(() => [...new Set(plans.map((p) => p.tierCredits))].sort((a, b) => a - b), [plans]);
  const selected = plans.find((p) => p.tierCredits === tier && p.interval === interval);
  const monthlyTwin = plans.find((p) => p.tierCredits === tier && p.interval === "month");
  const perMonth = selected ? (interval === "year" ? selected.priceBRL / 12 : selected.priceBRL) : 0;
  const saving = selected && monthlyTwin && interval === "year" ? monthlyTwin.priceBRL * 12 - selected.priceBRL : 0;
  const isCurrent = selected?.id === me.workspace.planId;

  const go = async (key: string, fn: () => Promise<{ url?: string } | unknown>) => {
    setBusy(key);
    try {
      const r = (await fn()) as { url?: string };
      if (r?.url) location.href = r.url;
      else {
        onError("Plano trocado! Os créditos do novo plano entram assim que o pagamento for confirmado.");
        onClose();
      }
    } catch (e) {
      const code = e instanceof ApiError ? e.code.split(":")[0] : "";
      onError(ERRORS[code] ?? (e instanceof ApiError ? e.code : "Não foi possível abrir o pagamento."));
      setBusy(null);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal plans-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-x" onClick={onClose} aria-label="Fechar">×</button>
        <h2>Planos Dohko IA</h2>
        <p className="muted">Preço em reais, cancele quando quiser. Todos os planos mantêm os créditos grátis diários.</p>
        {!isOwner && (
          <div className="notice credits" style={{ margin: "14px 0 0" }}>
            <span>Só o dono do workspace pode assinar planos ou comprar créditos. Os créditos são compartilhados pela equipe.</span>
          </div>
        )}

        <div className="interval-toggle">
          <div className="seg">
            <button className={interval === "month" ? "on" : ""} onClick={() => setInterval("month")}>Mensal</button>
            <button className={interval === "year" ? "on" : ""} onClick={() => setInterval("year")}>
              Anual <span className="tag gold">2 meses grátis</span>
            </button>
          </div>
        </div>

        <div className="plans two">
          <div className="plan">
            <h3>Grátis</h3>
            <div className="price">R$ 0<span className="muted small">/mês</span></div>
            <ul className="plan-feats">
              <li>5 créditos por dia para criar apps</li>
              <li>3 créditos por dia para o chat</li>
              <li>Todos os modelos e o Dohko One</li>
              <li>Especialistas e equipe</li>
            </ul>
            <button className="btn ghost block" disabled>{me.workspace.planId === "free" ? "Plano atual" : "Incluído"}</button>
          </div>

          <div className="plan featured">
            <h3>Pro</h3>
            <label className="tier-select">
              <span className="muted small">Créditos por mês</span>
              <select value={tier} onChange={(e) => setTier(Number(e.target.value))}>
                {tiers.map((t) => <option key={t} value={t}>{fmt(t, 0)} créditos</option>)}
              </select>
            </label>
            {selected && (
              <>
                <div className="price">
                  {brl(perMonth)}
                  <span className="muted small">/mês</span>
                </div>
                <div className="muted small">
                  {interval === "year" ? (
                    <>Cobrado {brl(selected.priceBRL)} por ano · economia de {brl(saving)}</>
                  ) : (
                    <>Cobrado mensalmente</>
                  )}
                </div>
                <div className="muted small">{brl(perMonth / selected.monthlyCredits)} por crédito · {fmt(selected.monthlyCredits, 0)} créditos todo mês</div>
                <ul className="plan-feats">
                  <li>Tudo do Grátis, mais os créditos do plano</li>
                  <li>Créditos acumulam por 2 meses</li>
                  <li>Recarga avulsa quando precisar</li>
                  <li>Troque de degrau quando quiser</li>
                </ul>
                <button
                  className="btn gold block"
                  disabled={isCurrent || busy !== null || !isOwner}
                  onClick={() => go(selected.id, () => (subscribed ? api.changePlan(selected.id) : api.checkout(selected.id)))}
                >
                  {isCurrent ? "Plano atual" : busy === selected.id ? "Abrindo…" : subscribed ? "Trocar para este plano" : "Assinar"}
                </button>
                {subscribed && !isCurrent && <span className="muted small">A diferença é cobrada de forma proporcional na hora.</span>}
              </>
            )}
          </div>
        </div>

        {me.workspace.planId !== "free" && isOwner && current?.topupPriceBRL && (
          <div className="topup">
            <strong>Recarga avulsa</strong>
            <input type="range" min={50} max={1000} step={50} value={topup} onChange={(e) => setTopup(Number(e.target.value))} />
            <span>
              {topup} créditos · {brl(topup * current.topupPriceBRL)}
            </span>
            <button className="btn primary sm" disabled={busy !== null} onClick={() => go("topup", () => api.topup(topup))}>
              {busy === "topup" ? "Abrindo…" : "Comprar"}
            </button>
          </div>
        )}
        {subscribed && isOwner && (
          <button className="link small" disabled={busy !== null} onClick={() => go("portal", () => api.portal())}>
            Gerenciar assinatura (cartão, faturas e cancelamento)
          </button>
        )}
      </div>
    </div>
  );
}
