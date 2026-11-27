import { useEffect, useRef, useState } from "react";
import { api, ApiError, fmt, type ExpertDetail, type ExpertInput, type ExpertSummary, type ExpertTemplate } from "../api";
import type { ModelsData } from "../App";

const EMPTY: ExpertInput = { name: "", emoji: "🤖", description: "", instructions: "", model: "auto" };
const EMOJIS = ["🤖", "📊", "✍️", "💬", "📱", "⚖️", "🧾", "🏥", "🏠", "🛒", "🎓", "🔧"];

interface Props {
  models: ModelsData;
  initialId?: string | null;
  onClose: () => void;
  onChanged: () => void;
  onStart: (expertId: string) => void;
}

export function ExpertsModal({ models, initialId, onClose, onChanged, onStart }: Props) {
  const [list, setList] = useState<ExpertSummary[]>([]);
  const [templates, setTemplates] = useState<ExpertTemplate[]>([]);
  const [editing, setEditing] = useState<ExpertDetail | "new" | null>(null);
  const [form, setForm] = useState<ExpertInput>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () => api.experts().then(setList);
  useEffect(() => {
    reload();
    api.expertTemplates().then(setTemplates);
    if (initialId) open(initialId);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (id: string) => {
    const e = await api.expert(id);
    setEditing(e);
    setForm({ name: e.name, emoji: e.emoji, description: e.description, instructions: e.instructions, model: e.model });
    setError(null);
  };

  const startNew = (tpl?: ExpertTemplate) => {
    setEditing("new");
    setForm(tpl ? { name: tpl.name, emoji: tpl.emoji, description: tpl.description, instructions: tpl.instructions, model: "auto" } : EMPTY);
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing === "new") {
        const { id } = await api.createExpert(form);
        await open(id);
      } else if (editing) {
        await api.updateExpert(editing.id, form);
        await open(editing.id);
      }
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError && e.code === "ENTRADA_INVALIDA" ? "Preencha o nome (2+ letras) e as instruções (10+ caracteres)." : "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing || editing === "new") return;
    setBusy(true);
    await api.deleteExpert(editing.id);
    setEditing(null);
    await reload();
    onChanged();
    setBusy(false);
  };

  const upload = async (files: FileList) => {
    if (!editing || editing === "new") return;
    setBusy(true);
    setError(null);
    for (const f of Array.from(files)) {
      try {
        await api.uploadExpertFile(editing.id, f);
      } catch (e) {
        setError(`"${f.name}": ${e instanceof ApiError ? e.code.replace(/_/g, " ").toLowerCase() : "erro"}`);
      }
    }
    await open(editing.id);
    await reload();
    setBusy(false);
  };

  const set = (k: keyof ExpertInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const readOnly = editing !== null && editing !== "new" && !editing.canEdit;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal experts-modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-x" onClick={onClose} aria-label="Fechar">×</button>
        {!editing ? (
          <>
            <h2>Especialistas</h2>
            <p className="muted">Assistentes com instruções e documentos da sua empresa. Toda a equipe pode usar.</p>
            {list.length > 0 && (
              <div className="expert-grid">
                {list.map((e) => (
                  <div key={e.id} className="expert-card">
                    <div className="expert-top">
                      <span className="expert-emoji">{e.emoji}</span>
                      <div>
                        <strong>{e.name}</strong>
                        <div className="muted small">{e.files} arquivo{e.files === 1 ? "" : "s"} · por {e.created_by_name}</div>
                      </div>
                    </div>
                    <p className="muted small">{e.description || "Sem descrição."}</p>
                    <div className="expert-actions">
                      <button className="btn primary sm" onClick={() => onStart(e.id)}>Conversar</button>
                      <button className="btn ghost sm" onClick={() => open(e.id)}>Ver / editar</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <h3 className="sub">Criar a partir de um modelo</h3>
            <div className="expert-grid">
              {templates.map((t) => (
                <button key={t.key} className="expert-card tpl" onClick={() => startNew(t)}>
                  <div className="expert-top">
                    <span className="expert-emoji">{t.emoji}</span>
                    <strong>{t.name}</strong>
                  </div>
                  <p className="muted small">{t.description}</p>
                </button>
              ))}
              <button className="expert-card tpl blank" onClick={() => startNew()}>
                <span className="expert-emoji">＋</span>
                <strong>Em branco</strong>
              </button>
            </div>
          </>
        ) : (
          <>
            <button className="link small" onClick={() => setEditing(null)}>← Voltar</button>
            <h2>{editing === "new" ? "Novo especialista" : readOnly ? form.name : "Editar especialista"}</h2>
            <div className="expert-form">
              <div className="row">
                <label className="emoji-field">
                  Ícone
                  <select value={form.emoji} onChange={set("emoji")} disabled={readOnly}>
                    {[...new Set([form.emoji, ...EMOJIS])].map((e) => <option key={e} value={e}>{e}</option>)}
                  </select>
                </label>
                <label className="grow">
                  Nome
                  <input value={form.name} onChange={set("name")} placeholder="Ex.: Atendimento da Clínica" disabled={readOnly} />
                </label>
                <label>
                  Modelo padrão
                  <select value={form.model} onChange={set("model")} disabled={readOnly}>
                    <option value="auto">Dohko One (automático)</option>
                    {models.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </label>
              </div>
              <label>
                Descrição curta
                <input value={form.description} onChange={set("description")} placeholder="Para que serve este especialista" disabled={readOnly} />
              </label>
              <label>
                Instruções
                <textarea
                  rows={9}
                  value={form.instructions}
                  onChange={set("instructions")}
                  disabled={readOnly}
                  placeholder="Quem ele é, como deve responder, o que nunca deve fazer, tom de voz…"
                />
              </label>

              {editing !== "new" && (
                <div className="knowledge">
                  <div className="knowledge-head">
                    <strong>Base de conhecimento</strong>
                    <span className="muted small">
                      {fmt(editing.knowledgeChars, 0)} de {fmt(editing.knowledgeLimit, 0)} caracteres
                    </span>
                    <div className="spacer" />
                    {!readOnly && (
                      <button className="btn ghost sm" disabled={busy} onClick={() => fileRef.current?.click()}>＋ Adicionar arquivos</button>
                    )}
                    <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.json" onChange={(e) => e.target.files && upload(e.target.files)} />
                  </div>
                  <div className="meter"><i style={{ width: `${Math.min(100, (editing.knowledgeChars / editing.knowledgeLimit) * 100)}%` }} /></div>
                  {editing.files.length === 0 && <p className="muted small">Adicione catálogos, tabelas de preço, políticas, FAQs, contratos-modelo… O especialista usa esses documentos para responder.</p>}
                  {editing.files.map((f) => (
                    <div key={f.id} className="kfile">
                      <span>📄 {f.name}</span>
                      <span className="muted small">{fmt(f.chars, 0)} caracteres{f.truncated ? " · cortado" : ""}</span>
                      {!readOnly && (
                        <button className="chip-x" onClick={async () => { await api.deleteExpertFile(editing.id, f.id); open(editing.id); reload(); }} aria-label="Remover">×</button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {error && <div className="form-error">{error}</div>}
              <div className="form-actions">
                {editing !== "new" && <button className="btn primary" onClick={() => onStart(editing.id)}>Conversar com ele</button>}
                <div className="spacer" />
                {editing !== "new" && !readOnly && <button className="link danger" disabled={busy} onClick={remove}>Excluir</button>}
                {!readOnly && (
                  <button className="btn gold" disabled={busy} onClick={save}>
                    {busy ? "Salvando…" : editing === "new" ? "Criar especialista" : "Salvar"}
                  </button>
                )}
              </div>
              {editing === "new" && <p className="muted small">Depois de criar, você poderá adicionar os documentos da base de conhecimento.</p>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
