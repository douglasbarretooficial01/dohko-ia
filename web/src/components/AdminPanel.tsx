import { useEffect, useState } from "react";
import { api, brl, fmt, type AdminStats } from "../api";

const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`);
const num = (n: number) => n.toLocaleString("pt-BR");

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [days, setDays] = useState(30);
  const [s, setS] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setS(null);
    api.adminStats(days).then(setS).catch(() => setError("Não foi possível carregar o painel."));
  }, [days]);

  const maxDay = s ? Math.max(1, ...s.byDay.map((d) => d.credits * s.creditValueBRL)) : 1;

  return (
    <div className="admin">
      <header className="chat-head">
        <h2 className="chat-title">📊 Painel da Dohko IA</h2>
        <div className="seg">
          {[7, 30, 90].map((d) => (
            <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d} dias</button>
          ))}
        </div>
        <button className="link" onClick={onClose}>Fechar ×</button>
      </header>
      {error && <div className="notice error"><span>{error}</span></div>}
      {!s ? (
        <div className="center muted">Carregando…</div>
      ) : (
        <div className="admin-body">
          <div className="kpis">
            <Kpi label="Receita nominal" value={brl(s.totals.revenueNominalBRL)} hint={`${fmt(s.totals.credits)} créditos × ${brl(s.creditValueBRL)}`} />
            <Kpi label="Custo real de IA" value={brl(s.totals.costBRL)} hint="o que os provedores cobraram" />
            <Kpi label="Margem bruta" value={pct(s.totals.grossMargin)} hint="meta: 65%" good={s.totals.grossMargin != null && s.totals.grossMargin >= 0.6} />
            <Kpi label="MRR (assinaturas)" value={brl(s.mrrBRL)} hint={s.plans.map((p) => `${p.name}: ${p.workspaces}`).join(" · ")} />
            <Kpi label="Ações de IA" value={num(s.totals.actions)} hint={`${num(s.totals.activeWorkspaces)} workspaces ativos`} />
            <Kpi label="Usuários" value={num(s.users.total)} hint={`${num(s.users.new)} novos no período`} />
            <Kpi label="Créditos grátis usados" value={fmt(s.totals.creditsFree)} hint={`pagos: ${fmt(s.totals.creditsPaid)}`} />
            <Kpi label="Perdas (writeoff)" value={fmt(s.totals.writeoffCredits)} hint="custo acima do saldo; calibrar estimativas" warn={s.totals.writeoffCredits > 0} />
          </div>

          <section className="admin-card">
            <h3>Receita x custo por dia</h3>
            {s.byDay.length === 0 ? (
              <p className="muted">Sem uso no período.</p>
            ) : (
              <div className="bars">
                {s.byDay.map((d) => {
                  const rev = d.credits * s.creditValueBRL;
                  return (
                    <div key={d.day} className="bar-col" title={`${d.day}: receita ${brl(rev)} · custo ${brl(d.cost)} · ${d.actions} ações`}>
                      <div className="bar-stack">
                        <div className="bar rev" style={{ height: `${(rev / maxDay) * 100}%` }} />
                        <div className="bar cost" style={{ height: `${(d.cost / maxDay) * 100}%` }} />
                      </div>
                      <span className="bar-label">{d.day.slice(8)}/{d.day.slice(5, 7)}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="legend small muted"><i className="dot rev" /> receita nominal <i className="dot cost" /> custo real</div>
          </section>

          <section className="admin-card">
            <h3>Por modelo</h3>
            <table className="table">
              <thead>
                <tr><th>Modelo</th><th>Uso</th><th>Ações</th><th>Tokens (entrada / saída)</th><th>Créditos</th><th>Custo</th><th>Margem</th></tr>
              </thead>
              <tbody>
                {s.byModel.map((m) => (
                  <tr key={m.mode + m.model}>
                    <td><strong>{m.model}</strong></td>
                    <td>{m.mode === "build" ? "Construtor" : "Chat"}</td>
                    <td>{num(m.actions)}</td>
                    <td>{num(m.input_tokens)} / {num(m.output_tokens)}</td>
                    <td>{fmt(m.credits)}</td>
                    <td>{brl(m.cost)}</td>
                    <td className={m.margin != null && m.margin < 0.5 ? "bad" : ""}>{pct(m.margin)}</td>
                  </tr>
                ))}
                {s.byModel.length === 0 && <tr><td colSpan={7} className="muted">Sem uso no período.</td></tr>}
              </tbody>
            </table>
          </section>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, hint, good, warn }: { label: string; value: string; hint?: string; good?: boolean; warn?: boolean }) {
  return (
    <div className={`kpi ${good ? "good" : ""} ${warn ? "warn" : ""}`}>
      <span className="muted small">{label}</span>
      <strong>{value}</strong>
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}
