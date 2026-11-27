export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/** Texto de uma mensagem (ignora imagens). */
export const msgText = (m: ChatMsg) =>
  typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");

/** Estimativa de tokens de entrada de uma conversa (texto + ~1.200 por imagem). */
export const approxInputTokens = (msgs: ChatMsg[]) =>
  msgs.reduce(
    (s, m) => s + approxTokens(msgText(m)) + (typeof m.content === "string" ? 0 : m.content.filter((p) => p.type === "image_url").length * 1_200),
    0,
  );

export interface StreamResult {
  inputTokens: number;
  outputTokens: number;
  /** Custo real em US$, quando o provedor informa. */
  costUSD?: number;
}

export interface StreamOptions {
  model: string; // ID do modelo no provedor
  messages: ChatMsg[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMProvider {
  name: string;
  stream(opts: StreamOptions, onDelta: (text: string) => void): Promise<StreamResult>;
}

export class ProviderError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

/** ~4 caracteres por token: suficiente para estimar quando o provedor não informa. */
export const approxTokens = (text: string) => Math.ceil(text.length / 4);

// ---------------------------------------------------------------------------
// OpenRouter: uma chave dá acesso a GPT, Claude, Gemini, Llama, DeepSeek etc.
// ---------------------------------------------------------------------------

export class OpenRouterProvider implements LLMProvider {
  name = "openrouter";

  constructor(private apiKey: string, private appUrl = "https://dohkotechnology.com.br", private baseUrl = "https://openrouter.ai/api/v1") {}

  async stream(opts: StreamOptions, onDelta: (t: string) => void): Promise<StreamResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal: opts.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": this.appUrl,
        "X-Title": "Dohko IA",
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        max_tokens: opts.maxTokens,
        usage: { include: true },
      }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(`OpenRouter ${res.status}: ${body.slice(0, 300)}`, res.status);
    }

    let output = "";
    let usage: StreamResult | null = null;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue; // comentários ": OPENROUTER PROCESSING"
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) throw new ProviderError(`OpenRouter: ${json.error.message ?? "erro"}`);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          output += delta;
          onDelta(delta);
        }
        if (json.usage) {
          usage = {
            inputTokens: json.usage.prompt_tokens ?? 0,
            outputTokens: json.usage.completion_tokens ?? 0,
            costUSD: typeof json.usage.cost === "number" ? json.usage.cost : undefined,
          };
        }
      }
    }
    return (
      usage ?? {
        inputTokens: approxInputTokens(opts.messages),
        outputTokens: approxTokens(output),
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Modo simulado: roda sem chave nenhuma (desenvolvimento, demonstração, testes)
// ---------------------------------------------------------------------------

export class MockProvider implements LLMProvider {
  name = "mock";

  constructor(private delayMs = 15) {}

  async stream(opts: StreamOptions, onDelta: (t: string) => void): Promise<StreamResult> {
    const lastMsg = opts.messages.filter((m) => m.role === "user").at(-1);
    const last = lastMsg ? msgText(lastMsg) : "";
    const images = lastMsg && typeof lastMsg.content !== "string" ? lastMsg.content.filter((p) => p.type === "image_url").length : 0;
    const files = [...last.matchAll(/<arquivo nome="([^"]+)"/g)].map((m) => m[1]);
    const isBuild = opts.messages.some((m) => m.role === "system" && msgText(m).includes("[DOHKO_BUILDER]"));
    const question = last.replace(/<arquivo[\s\S]*?<\/arquivo>/g, "").trim();
    let text = isBuild ? mockApp(question) : mockAnswer(question, opts.model);
    if (!isBuild && (files.length || images)) {
      text += `\n\nRecebi ${files.length ? `os arquivos: ${files.join(", ")}` : ""}${files.length && images ? " e " : ""}${images ? `${images} imagem(ns)` : ""}.`;
    }
    const parts = text.match(/[\s\S]{1,24}/g) ?? [];
    for (const p of parts) {
      if (opts.signal?.aborted) break;
      onDelta(p);
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    }
    return { inputTokens: approxInputTokens(opts.messages), outputTokens: approxTokens(text) };
  }
}

function mockAnswer(question: string, model: string) {
  return [
    `**Modo simulado** (modelo \`${model}\`). Configure a variável \`OPENROUTER_API_KEY\` para respostas reais.`,
    "",
    `Você perguntou: _${question.slice(0, 200)}_`,
    "",
    "Aqui a Dohko IA responderia de verdade. Enquanto isso, esta resposta serve para testar:",
    "",
    "- o **streaming** palavra por palavra;",
    "- a **cobrança de créditos** pelo custo real;",
    "- o **roteador Dohko One**, que escolhe o modelo conforme a pergunta.",
  ].join("\n");
}

function mockApp(prompt: string) {
  const safe = prompt.replace(/[<>&"]/g, "").slice(0, 120);
  return [
    "Criei a primeira versão do app. Ele está na prévia ao lado.",
    "",
    "```html",
    `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>App Dohko</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh}
  .card{background:#1e293b;padding:32px;border-radius:16px;max-width:520px;box-shadow:0 10px 40px #0006}
  h1{margin:0 0 8px;color:#fbbf24} button{background:#fbbf24;border:0;padding:10px 18px;border-radius:8px;font-weight:600;cursor:pointer}
  ul{padding-left:18px}
</style>
</head>
<body>
  <div class="card">
    <h1>App de exemplo</h1>
    <p>Pedido: <em>${safe}</em></p>
    <p>Modo simulado. Configure <code>OPENROUTER_API_KEY</code> para gerar apps de verdade.</p>
    <input id="t" placeholder="Nova tarefa" style="padding:9px;border-radius:8px;border:0;width:60%">
    <button onclick="add()">Adicionar</button>
    <ul id="l"></ul>
  </div>
<script>
  function add(){const v=document.getElementById('t').value.trim();if(!v)return;const li=document.createElement('li');li.textContent=v;document.getElementById('l').appendChild(li);document.getElementById('t').value=''}
</script>
</body>
</html>`,
    "```",
  ].join("\n");
}
