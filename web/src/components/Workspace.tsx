import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { api, ApiError, fmt, sendMessage, type Balance, type Conversation, type Message, type Published, type UploadedFile } from "../api";
import type { ModelsData } from "../App";
import { Markdown } from "./Markdown";
import { ModelPicker } from "./ModelPicker";
import { Preview } from "./Preview";

interface Props {
  convId: string;
  models: ModelsData;
  onBalance: (b: Balance) => void;
  onTitle: (t: string) => void;
  onActivity: () => void;
  onNeedCredits: () => void;
}

type PendingFile = (UploadedFile & { uploading?: false }) | { id: string; name: string; kind: "text" | "image"; uploading: true; preview?: string };

const ACCEPT = ".pdf,.docx,.csv,.tsv,.txt,.md,.json,.xml,.html,.png,.jpg,.jpeg,.webp,.gif";
const UPLOAD_ERRORS: Record<string, string> = {
  ARQUIVO_MAIOR_QUE_10MB: "passa de 10 MB",
  IMAGEM_MAIOR_QUE_5MB: "imagem passa de 5 MB",
  PDF_ILEGIVEL: "PDF ilegível",
  DOCX_ILEGIVEL: "arquivo Word ilegível",
};

interface LiveMessage extends Message {
  streaming?: boolean;
  modelLabel?: string;
  reason?: string;
}

const CHAT_SUGGESTIONS = [
  "Monte um plano de conteúdo de 30 dias para o Instagram de uma clínica odontológica",
  "Escreva uma mensagem de cobrança educada para enviar no WhatsApp",
  "Explique a diferença entre MEI, Simples Nacional e Lucro Presumido",
  "Crie um roteiro de vendas para uma ligação de prospecção B2B",
];
const BUILD_SUGGESTIONS = [
  "Um controle de fluxo de caixa com entradas, saídas e gráfico do mês",
  "Uma página de agendamento para um salão de beleza com horários disponíveis",
  "Um catálogo de produtos com carrinho que envia o pedido pelo WhatsApp",
  "Uma calculadora de preço de venda com custos, impostos e margem",
];

export function Workspace({ convId, models, onBalance, onTitle, onActivity, onNeedCredits }: Props) {
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState(() => localStorageGet("dohko:model") ?? "auto");
  const [busy, setBusy] = useState(false);
  const [estimate, setEstimate] = useState<{ label: string; expected: number; reason: string } | null>(null);
  const [notice, setNotice] = useState<{ kind: "credits" | "error"; text: string } | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [published, setPublished] = useState<Published | null>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.conversation(convId).then((c) => {
      setConv(c);
      setMessages(c.messages);
      setHtml(c.artifactHtml);
      setVersion(c.artifactVersion);
      setPublished(c.published);
    });
    return () => abortRef.current?.abort();
  }, [convId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const readyIds = files.filter((f) => !f.uploading).map((f) => f.id);
  const readyKey = readyIds.join(",");

  // estimativa de custo enquanto digita (custo visível antes de enviar)
  useEffect(() => {
    if (!conv) return;
    const t = setTimeout(() => {
      api
        .estimate(convId, input, model, readyKey ? readyKey.split(",") : [])
        .then((e) => setEstimate({ label: e.model.label, expected: e.expected, reason: e.reason }))
        .catch(() => setEstimate(null));
    }, 350);
    return () => clearTimeout(t);
  }, [input, model, conv, convId, readyKey]);

  const addFiles = async (list: FileList | File[]) => {
    const arr = Array.from(list).slice(0, Math.max(0, 5 - files.length));
    for (const file of arr) {
      const tempId = `up-${Math.random().toString(36).slice(2)}`;
      const isImg = file.type.startsWith("image/");
      setFiles((fs) => [...fs, { id: tempId, name: file.name, kind: isImg ? "image" : "text", uploading: true, preview: isImg ? URL.createObjectURL(file) : undefined }]);
      try {
        const up = await api.upload(file);
        setFiles((fs) => fs.map((f) => (f.id === tempId ? up : f)));
      } catch (e) {
        setFiles((fs) => fs.filter((f) => f.id !== tempId));
        const code = e instanceof ApiError ? e.code.split(" ")[0] : "";
        setNotice({ kind: "error", text: `Não foi possível anexar "${file.name}": ${UPLOAD_ERRORS[code] ?? (e instanceof ApiError ? e.code.replace(/_/g, " ").toLowerCase() : "erro de conexão")}.` });
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const imgs = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length) {
      e.preventDefault();
      addFiles(imgs);
    }
  };

  const chooseModel = (m: string) => {
    setModel(m);
    localStorageSet("dohko:model", m);
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy || !conv || files.some((f) => f.uploading)) return;
    const sentFiles = files.filter((f): f is UploadedFile => !f.uploading);
    setFiles([]);
    setInput("");
    setNotice(null);
    setBusy(true);
    const isFirst = messages.length === 0;
    const tempUser: LiveMessage = { id: `tmp-u-${Date.now()}`, role: "user", content, attachments: sentFiles.map(({ id, name, kind }) => ({ id, name, kind })) };
    const tempAsst: LiveMessage = { id: `tmp-a-${Date.now()}`, role: "assistant", content: "", streaming: true };
    setMessages((m) => [...m, tempUser, tempAsst]);
    const patch = (fn: (m: LiveMessage) => LiveMessage) => setMessages((ms) => ms.map((m) => (m.id === tempAsst.id ? fn(m) : m)));

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await sendMessage(
        convId,
        content,
        model,
        {
          onMeta: (d) => patch((m) => ({ ...m, modelLabel: d.model.label, reason: d.reason })),
          onDelta: (t) => patch((m) => ({ ...m, content: m.content + t })),
          onDone: (d) => {
            patch((m) => ({ ...m, id: d.messageId, content: d.content, credits: d.credits, streaming: false }));
            onBalance(d.balance);
            if (d.artifactHtml) {
              setHtml(d.artifactHtml);
              setVersion(d.artifactVersion ?? 0);
            }
            if (isFirst) onTitle(content.replace(/\s+/g, " ").slice(0, 60));
            onActivity();
          },
          onError: (d) => {
            patch((m) => ({ ...m, streaming: false }));
            setNotice({ kind: "error", text: d.message ?? "Algo deu errado. Nenhum crédito foi cobrado." });
          },
        },
        ac.signal,
        sentFiles.map((f) => f.id),
      );
    } catch (e) {
      setMessages((ms) => ms.filter((m) => m.id !== tempAsst.id || m.content));
      if (e instanceof ApiError && e.status === 402) {
        setMessages((ms) => ms.filter((m) => m.id !== tempUser.id));
        setInput(content);
        setFiles(sentFiles);
        setNotice({
          kind: "credits",
          text: `Créditos insuficientes: este pedido deve custar cerca de ${fmt(e.data.needed)} e você tem ${fmt(e.data.available)}.`,
        });
      } else if (!(e instanceof DOMException && e.name === "AbortError")) {
        setNotice({ kind: "error", text: "Não foi possível falar com o servidor." });
      }
    } finally {
      patch((m) => ({ ...m, streaming: false }));
      setBusy(false);
      abortRef.current = null;
      taRef.current?.focus();
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  if (!conv) return <div className="center muted">Carregando…</div>;
  const isBuild = conv.kind === "build";
  const suggestions = isBuild ? BUILD_SUGGESTIONS : CHAT_SUGGESTIONS;

  const chat = (
    <section
      className={`chat ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      {dragging && <div className="drop-hint">Solte os arquivos para anexar</div>}
      <header className="chat-head">
        <h2 className="chat-title">{isBuild ? "⚡ " : ""}{messages.length ? conv.title : isBuild ? "Novo app" : "Nova conversa"}</h2>
        <ModelPicker models={models} value={model} onChange={chooseModel} />
      </header>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">
            <div className="logo-mark big">D</div>
            <h3>{isBuild ? "Descreva o app que você quer criar" : "Como posso ajudar?"}</h3>
            <div className="suggestions">
              {suggestions.map((s) => (
                <button key={s} className="suggestion" onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "assistant" ? (
              <>
                {m.content ? <Markdown text={m.content} /> : <TypingDots />}
                {(m.modelLabel || m.model || m.credits != null) && (
                  <div className="msg-meta">
                    {m.modelLabel ?? models.models.find((x) => x.id === m.model)?.label ?? m.model}
                    {m.reason && model === "auto" ? ` · Dohko One: ${m.reason}` : ""}
                    {m.credits != null ? ` · ${fmt(m.credits)} crédito${m.credits === 1 ? "" : "s"}` : ""}
                  </div>
                )}
              </>
            ) : (
              <>
                {m.attachments && m.attachments.length > 0 && (
                  <div className="msg-files">
                    {m.attachments.map((a) =>
                      a.kind === "image" ? (
                        <img key={a.id} className="msg-img" src={`/api/attachments/${a.id}`} alt={a.name} title={a.name} />
                      ) : (
                        <span key={a.id} className="file-chip">📄 {a.name}</span>
                      ),
                    )}
                  </div>
                )}
                <div className="bubble">{m.content}</div>
              </>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {notice && (
        <div className={`notice ${notice.kind}`}>
          <span>{notice.text}</span>
          {notice.kind === "credits" && <button className="btn gold sm" onClick={onNeedCredits}>Ver planos</button>}
          <button className="link" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      <div className="composer">
        {files.length > 0 && (
          <div className="pending-files">
            {files.map((f) => (
              <span key={f.id} className={`file-chip ${f.uploading ? "loading" : ""}`} title={!f.uploading && f.truncated ? "Arquivo grande: só o começo será lido" : f.name}>
                {f.kind === "image" ? "🖼" : "📄"} {f.name}
                {f.uploading ? " · enviando…" : !f.uploading && f.truncated ? " · cortado" : ""}
                {!f.uploading && (
                  <button className="chip-x" onClick={() => setFiles((fs) => fs.filter((x) => x.id !== f.id))} aria-label="Remover">×</button>
                )}
              </span>
            ))}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          onPaste={onPaste}
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          rows={Math.min(8, Math.max(2, input.split("\n").length))}
          placeholder={isBuild ? (version ? "Peça uma mudança no app…" : "Ex.: um app para controlar as vendas da minha loja…") : "Pergunte qualquer coisa…"}
          autoFocus
        />
        <div className="composer-bar">
          <button className="attach-btn" onClick={() => fileRef.current?.click()} title="Anexar PDF, Word, planilha CSV, texto ou imagem" disabled={files.length >= 5}>
            📎
          </button>
          <span className="estimate small muted" title="Custo estimado antes de enviar. Você paga o custo real, que costuma ser menor.">
            {estimate ? (
              <>
                {model === "auto" && <strong className="gold-text">Dohko One → </strong>}
                {estimate.label} · <strong>~{fmt(estimate.expected)}</strong> crédito{estimate.expected === 1 ? "" : "s"}
              </>
            ) : (
              " "
            )}
          </span>
          {busy ? (
            <button className="btn ghost sm" onClick={() => abortRef.current?.abort()}>■ Parar</button>
          ) : (
            <button className="btn primary sm" disabled={!input.trim() || files.some((f) => f.uploading)} onClick={() => send()}>Enviar ↵</button>
          )}
        </div>
      </div>
    </section>
  );

  if (!isBuild) return chat;
  return (
    <div className="build-split">
      {chat}
      <Preview convId={convId} html={html} version={version} title={conv.title} building={busy} published={published} onPublished={setPublished} />
    </div>
  );
}

function TypingDots() {
  return <span className="typing"><i /><i /><i /></span>;
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* sem storage disponível */
  }
}
