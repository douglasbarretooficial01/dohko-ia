export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  name: string;
  send(msg: MailMessage): Promise<void>;
}

/** Envio real pelo Resend (https://resend.com). */
export class ResendMailer implements Mailer {
  name = "resend";
  constructor(private apiKey: string, private from: string) {}

  async send(msg: MailMessage) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}

/** Sem provedor configurado: escreve o e-mail no log (desenvolvimento no Mac). */
export class LogMailer implements Mailer {
  name = "log";
  constructor(private log: (msg: string) => void = console.log) {}

  async send(msg: MailMessage) {
    this.log(`[e-mail não enviado: configure RESEND_API_KEY] para=${msg.to} assunto="${msg.subject}"\n${msg.text}`);
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function resetEmail(name: string, link: string): Omit<MailMessage, "to"> {
  const first = name.split(" ")[0];
  return {
    subject: "Redefinir sua senha da Dohko IA",
    text: `Olá, ${first}!\n\nRecebemos um pedido para redefinir a senha da sua conta na Dohko IA.\nPara criar uma nova senha, abra este link (vale por 1 hora e só pode ser usado uma vez):\n\n${link}\n\nSe não foi você, ignore este e-mail: sua senha continua a mesma.\n\nEquipe Dohko`,
    html: `<!DOCTYPE html><html lang="pt-BR"><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1a1d24">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="100%" style="max-width:480px;background:#fff;border-radius:12px;padding:32px" cellpadding="0" cellspacing="0"><tr><td>
<div style="display:inline-block;background:#f5b301;color:#1a1300;font-weight:700;border-radius:8px;width:32px;height:32px;line-height:32px;text-align:center">D</div>
<h1 style="font-size:20px;margin:20px 0 8px">Redefinir sua senha</h1>
<p style="font-size:15px;line-height:1.5;margin:0 0 20px">Olá, ${esc(first)}! Recebemos um pedido para redefinir a senha da sua conta na Dohko IA.</p>
<a href="${esc(link)}" style="display:inline-block;background:#1a1d24;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px">Criar nova senha</a>
<p style="font-size:13px;color:#6b7280;line-height:1.5;margin:20px 0 0">O link vale por 1 hora e só pode ser usado uma vez. Se não foi você, ignore este e-mail: sua senha continua a mesma.</p>
</td></tr></table></td></tr></table></body></html>`,
  };
}
