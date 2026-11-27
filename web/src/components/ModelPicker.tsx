import { useEffect, useRef, useState } from "react";
import type { ModelsData } from "../App";

const TIER: Record<string, string> = { fast: "Rápido", balanced: "Equilibrado", deep: "Avançado" };

export function ModelPicker({ models, value, onChange }: { models: ModelsData; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = value === "auto" ? models.auto : models.models.find((m) => m.id === value) ?? models.auto;

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" onClick={() => setOpen(!open)}>
        {value === "auto" && <span className="spark">✦</span>}
        {current.label} <span className="muted">▾</span>
      </button>
      {open && (
        <div className="picker-menu">
          <button className={`picker-item ${value === "auto" ? "sel" : ""}`} onClick={() => { onChange("auto"); setOpen(false); }}>
            <div><span className="spark">✦</span> <strong>{models.auto.label}</strong> <span className="tag gold">Recomendado</span></div>
            <span className="muted small">{models.auto.description}</span>
          </button>
          <div className="picker-sep" />
          {models.models.map((m) => (
            <button key={m.id} className={`picker-item ${value === m.id ? "sel" : ""}`} onClick={() => { onChange(m.id); setOpen(false); }}>
              <div>
                <strong>{m.label}</strong> <span className="muted small">{m.vendor}</span> <span className="tag">{TIER[m.tier]}</span>
              </div>
              <span className="muted small">{m.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
