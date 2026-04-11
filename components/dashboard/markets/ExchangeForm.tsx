"use client";
import React, { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, ExternalLink, X } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { QUERY_KEYS } from "@/lib/query-keys";
import type { RevealedKeys } from '@/lib/hooks/use-exchange-otp'

interface ExchangeFormProps {
  exch: { id: string; name: string; fields: string[]; docs: string };
  marketId: string;
  prefill?: RevealedKeys | null;
  onSaved: () => void;
  onCancel: () => void;
  isEdit?: boolean;
}

export default function ExchangeForm({ exch, marketId, prefill, onSaved, onCancel, isEdit }: ExchangeFormProps) {
  const qc = useQueryClient();

  const [vals, setVals] = useState<Record<string, string>>(() => {
    if (prefill) {
      const init: Record<string, string> = {
        [exch.fields[0]]: prefill.apiKey,
        [exch.fields[1]]: prefill.apiSecret,
      };
      Object.entries(prefill.extra ?? {}).forEach(([k, v]) => { init[k] = v as string; });
      return init;
    }
    return {};
  });

  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [error,  setError]  = useState("");
  const [isDirty, setIsDirty] = useState(false)

  async function handleSave() {
    const apiKey = vals[exch.fields[0]] ?? "";
    const apiSec = vals[exch.fields[1]] ?? "";
    if (!apiKey || !apiSec) { setError("API Key and Secret are required."); return; }

    setSaving(true);
    setError("");

    const extra = exch.fields.slice(2).reduce((acc, f) => ({ ...acc, [f]: vals[f] ?? "" }), {});

    try {
      await apiFetch("/api/exchange", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          marketType:    marketId,
          exchangeName:  exch.id,
          apiKey,
          apiSecret:     apiSec,
          extraFields:   extra,
        }),
      });

      setSaved(true);
      setIsDirty(false);
      qc.invalidateQueries({ queryKey: QUERY_KEYS.EXCHANGE_APIS });
      setTimeout(() => { onSaved(); }, 1200);
    } catch (err: any) {
      setError(err?.message ?? "Failed to save keys");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  return (
    <div className="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700/40">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-300">{exch.name}</span>
          {isEdit && <span className="text-xs text-amber-400 bg-amber-900/20 border border-amber-800/30 px-2 py-0.5 rounded-full">Editing</span>}
          {isDirty && <span className="text-xs text-amber-300 ml-2">Unsaved changes</span>}
        </div>
        <div className="flex items-center gap-2">
          <a href={exch.docs} target="_blank" rel="noopener noreferrer"
            className="text-xs text-gray-600 hover:text-brand-500 flex items-center gap-1 transition-colors">
            <ExternalLink className="w-3 h-3" /> Docs
          </a>
          <button onClick={onCancel}
            className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1 transition-colors">
            <X className="w-3 h-3" /> Cancel
          </button>
        </div>
      </div>

      <div className="px-4 py-4 space-y-3">
        {exch.fields.map(field => (
          <div key={field} className="space-y-1">
            <label className="text-xs font-medium text-gray-400 tracking-wide">{field}</label>
            <input
              type="password"
              placeholder={`Paste your ${field}`}
              value={vals[field] ?? ""}
              onChange={e => { setVals(prev => ({ ...prev, [field]: e.target.value })); setIsDirty(true) }}
              className="w-full px-3 py-2 rounded-lg bg-gray-900/60 border border-gray-700 text-gray-100
                placeholder-gray-600 font-mono text-sm outline-none transition-all
                focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 focus:bg-gray-900
                hover:border-gray-500"
            />
          </div>
        ))}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <button
          onClick={handleSave}
          disabled={saving || saved}
          className="w-full py-2.5 mt-1 rounded-xl text-sm font-semibold transition-all
            bg-brand-500 hover:bg-brand-600 active:scale-[0.99] text-white
            disabled:bg-gray-700 disabled:text-gray-400 disabled:cursor-not-allowed"
        >
          {saving ? (
            <span className="flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Encrypting & saving…
            </span>
          ) : saved ? "✓ Saved & Encrypted" : "Save API Keys"}
        </button>
      </div>
    </div>
  );
}
