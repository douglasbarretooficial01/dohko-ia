import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type Me } from "../api";

const MESSAGES: Record<string, string> = {
  EMAIL_JA_CADASTRADO: "Este e-mail já tem conta. Entre com sua senha.",
  EMAIL_OU_SENHA_INVALIDOS: "E-mail ou senha incorretos.",
  ENTRADA_INVALIDA: "Confira os campos: e-mail válido e senha com pelo menos 8 caracteres.",
  CONVITE_JA_USADO: "Este convite já foi usado. Peça um novo link.",
  CONVITE_EXPIRADO: "Este convite expirou. Peça um novo link.",
  CONVITE_INVALIDO: "Convite inválido. Peça um novo link.",
  LINK_INVALIDO: "Este link de redefinição não é válido. Peça um novo.",
  LINK_JA_USADO: "Este link já foi usado. Se precisar, peça um novo.",
  LINK_EXPIRADO: "Este link expirou (vale 1 hora). Peça um novo.",
};

export function Auth({ onAuth, invite, resetToken }: { onAuth: (me: Me) => void; invite?: string | null; resetToken?: string | null }) {
  const [mode, setMode] = useState<"login" | "signup" | "forgot" | "reset">(resetToken ? "reset" : "signup");
  const [forgotSent, setForgotSent] = useState(false);
  const [resetEmail, setResetEmail] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    if (!resetToken) return;
    api
      .resetInfo(resetToken)
      .then((r) => setResetEmail(r.email))
      .catch((e) => setError(e instanceof ApiError ? MESSAGES[e.code] ?? MESSAGES.LINK_INVALIDO : MESSAGES.LINK_INVALIDO));
  }, [resetToken]);
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
      if (mode === "forgot") {
        await api.forgot(form.email);
        setForgotSent(true);
        return;
      }
      if (mode === "reset") {
        if (form.password !== confirm) {
          setError("As duas senhas não são iguais.");
          return;
        }
        onAuth(await api.resetPassword(resetToken!, form.password));
        return;
      }
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
      {mode === "forgot" || mode === "reset" ? (
        <form className="auth-card" onSubmit={submit}>
          {mode === "forgot" ? (
            forgotSent ? (
              <>
                <h2>Confira seu e-mail</h2>
                <p className="muted">
                  Se existir uma conta com <strong>{form.email}</strong>, enviamos um link para criar uma nova senha. Ele vale por 1 hora.
                </p>
                <p className="muted small">Não chegou? Veja a caixa de spam ou peça de novo em alguns minutos.</p>
              </>
            ) : (
              <>
                <h2>Esqueci minha senha</h2>
                <p className="muted small">Informe o e-mail da sua conta e enviaremos um link para criar uma nova senha.</p>
                <label>
                  E-mail
                  <input required type="email" value={form.email} onChange={set("email")} autoComplete="email" autoFocus />
                </label>
                {error && <div className="form-error">{error}</div>}
                <button className="btn primary block" disabled={busy}>{busy ? "Enviando…" : "Enviar link"}</button>
              </>
            )
          ) : (
            <>
              <h2>Criar nova senha</h2>
              {resetEmail && <p className="muted small">Conta: {resetEmail}</p>}
              {resetEmail && (
                <>
                  <label>
                    Nova senha
                    <input required type="password" minLength={8} value={form.password} onChange={set("password")} autoComplete="new-password" autoFocus />
                  </label>
                  <label>
                    Repita a nova senha
                    <input required type="password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                  </label>
                </>
              )}
              {error && <div className="form-error">{error}</div>}
              {resetEmail && <button className="btn primary block" disabled={busy}>{busy ? "Salvando…" : "Salvar e entrar"}</button>}
              {!resetEmail && error && (
                <button type="button" className="btn ghost block" onClick={() => { setMode("forgot"); setError(null); history.replaceState(null, "", "/"); }}>
                  Pedir novo link
                </button>
              )}
            </>
          )}
          <button type="button" className="link" onClick={() => { setMode("login"); setError(null); setForgotSent(false); history.replaceState(null, "", "/"); }}>
            Voltar para o login
          </button>
        </form>
      ) : (
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
        {mode === "login" && (
          <button type="button" className="link small" onClick={() => { setMode("forgot"); setError(null); }}>
            Esqueci minha senha
          </button>
        )}
      </form>
      )}
    </div>
  );
}
