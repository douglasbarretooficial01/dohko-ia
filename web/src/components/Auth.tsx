import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Me } from "../api";

const MESSAGES: Record<string, string> = {
  EMAIL_JA_CADASTRADO: "Este e-mail já tem conta. Entre com sua senha.",
  EMAIL_OU_SENHA_INVALIDOS: "E-mail ou senha incorretos.",
  ENTRADA_INVALIDA: "Confira os campos: e-mail válido e senha com pelo menos 8 caracteres.",
  CONVITE_JA_USADO: "Este convite já foi usado. Peça um novo link.",
  CONVITE_EXPIRADO: "Este convite expirou. Peça um novo link.",
  CONVITE_INVALIDO: "Convite inválido. Peça um novo link.",
};

export function Auth({ onAuth, invite }: { onAuth: (me: Me) => void; invite?: string | null }) {
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [inviteInfo, setInviteInfo] = useState<{ workspaceName: string; inviter: string } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    if (!invite) return;
    api
      .invite(invite)
      .then(setInviteInfo)
      .catch((e) => setInviteError(e instanceof ApiError ? MESSAGES[e.code] ?? MESSAGES.CONVITE_INVALIDO : MESSAGES.CONVITE_INVALIDO));
  }, [invite]);
  const inviteToken = inviteInfo && invite ? invite : undefined;
  const [form, setForm] = useState({ name: "", company: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me =
        mode === "signup"
          ? await api.signup({ name: form.name, email: form.email, password: form.password, company: form.company || undefined, inviteToken })
          : await api.login({ email: form.email, password: form.password, inviteToken });
      onAuth(me);
    } catch (err) {
      setError(err instanceof ApiError ? MESSAGES[err.code] ?? "Não foi possível continuar. Tente de novo." : "Sem conexão com o servidor.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-hero">
        <div className="brand">
          <div className="logo-mark">D</div>
          <span>Dohko IA</span>
        </div>
        <h1>
          A IA que trabalha
          <br />
          <em>do jeito brasileiro.</em>
        </h1>
        <ul className="auth-points">
          <li>GPT, Claude e Gemini em um só lugar, com o Dohko One escolhendo o melhor modelo para cada pedido</li>
          <li>Descreva um app e veja ele funcionando em segundos</li>
          <li>Preço em reais e custo mostrado antes de cada pedido</li>
        </ul>
      </div>
      <form className="auth-card" onSubmit={submit}>
        {inviteInfo && (
          <div className="invite-banner">
            <strong>{inviteInfo.inviter}</strong> convidou você para a equipe <strong>{inviteInfo.workspaceName}</strong> na Dohko IA.
            <span className="muted small"> Crie sua conta ou entre para aceitar.</span>
          </div>
        )}
        {inviteError && <div className="form-error">{inviteError}</div>}
        <h2>{mode === "signup" ? (inviteInfo ? "Crie sua conta" : "Crie sua conta grátis") : "Entrar"}</h2>
        <p className="muted small">
          {mode === "signup" ? (inviteInfo ? "Você vai usar os créditos da equipe." : "5 créditos por dia para criar, sem cartão.") : "Bom te ver de novo."}
        </p>
        {mode === "signup" && (
          <label>
            Seu nome
            <input required minLength={2} value={form.name} onChange={set("name")} autoComplete="name" />
          </label>
        )}
        {mode === "signup" && !inviteInfo && (
          <label>
            <span>Empresa <span className="muted">(opcional)</span></span>
            <input value={form.company} onChange={set("company")} autoComplete="organization" />
          </label>
        )}
        <label>
          E-mail
          <input required type="email" value={form.email} onChange={set("email")} autoComplete="email" />
        </label>
        <label>
          Senha
          <input
            required
            type="password"
            minLength={mode === "signup" ? 8 : 1}
            value={form.password}
            onChange={set("password")}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy ? "Aguarde…" : mode === "signup" ? "Criar conta" : "Entrar"}
        </button>
        <button type="button" className="link" onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setError(null); }}>
          {mode === "signup" ? "Já tenho conta" : "Criar uma conta"}
        </button>
      </form>
    </div>
  );
}
