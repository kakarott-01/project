"use client";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { QUERY_KEYS } from '@/lib/query-keys'
import { apiFetch } from '@/lib/api-client'
import dynamic from 'next/dynamic'
const OtpModal = dynamic(() => import('@/components/modals/otp-modal'), { ssr: false })
import {
  CheckCircle, ChevronDown, ChevronUp, Shield, ExternalLink,
  Eye, EyeOff, Pencil, X, Loader2, Lock, KeyRound, MailCheck, Plus,
  AlertTriangle,
} from "lucide-react";
import { useBotStatusQuery } from "@/lib/use-bot-status-query";

interface SavedApi {
  id: string;
  marketType: string;
  exchangeName: string;
  exchangeLabel?: string;
  isVerified: boolean;
  isActive: boolean;
}

import type { RevealedKeys } from '@/lib/hooks/use-exchange-otp'

interface MeResponse {
  email?: string;
}

const MARKETS = [
  {
    id: "indian", label: "🇮🇳 Indian Markets", desc: "NSE, BSE — Stocks, F&O, ETFs",
    exchanges: [
      { id: "zerodha",  name: "Zerodha Kite",       fields: ["API Key", "API Secret"],         docs: "https://kite.zerodha.com" },
      { id: "dhan",     name: "Dhan / DhanHQ",       fields: ["Client ID", "Access Token"],     docs: "https://dhanhq.co" },
      { id: "upstox",   name: "Upstox Pro",           fields: ["API Key", "API Secret"],         docs: "https://upstox.com" },
    ],
  },
  {
    id: "crypto", label: "₿ Crypto Markets", desc: "BTC, ETH, altcoins — Indian exchanges",
    exchanges: [
      { id: "coindcx",    name: "CoinDCX",                fields: ["API Key", "API Secret"],  docs: "https://coindcx.com" },
      { id: "deltaexch",  name: "Delta Exchange India",   fields: ["API Key", "API Secret"],  docs: "https://india.delta.exchange" },
      { id: "bingx",      name: "BingX",                  fields: ["API Key", "Secret Key"],  docs: "https://bingx.com" },
    ],
  },
  {
    id: "commodities", label: "🛢 Commodities", desc: "MCX, NCDEX — Gold, Silver, Crude",
    exchanges: [
      { id: "fyers",     name: "Fyers",                  fields: ["App ID", "Secret Key"],                         docs: "https://fyers.in" },
      { id: "dhan",      name: "Dhan (MCX)",              fields: ["Client ID", "Access Token"],                    docs: "https://dhanhq.co" },
      { id: "angelone",  name: "Angel One SmartAPI",      fields: ["API Key", "Client Code", "PIN", "TOTP Secret"], docs: "https://angelone.in" },
    ],
  },
  {
    id: "global", label: "🌐 Global / General", desc: "US, UK, Forex, Bonds",
    exchanges: [
      { id: "ibkr",   name: "Interactive Brokers", fields: ["Account ID", "TWS Port"], docs: "https://interactivebrokers.co.in" },
      { id: "bingx",  name: "BingX",               fields: ["API Key", "Secret Key"],  docs: "https://bingx.com" },
    ],
  },
];

// OTP modal moved to components/modals/otp-modal.tsx and lazy-loaded via dynamic import above.

// ── Masked key display ────────────────────────────────────────────────────────

function MaskedField({ label, value, revealed }: { label: string; value: string; revealed: boolean }) {
  const [show, setShow] = useState(false);
  const masked = value.slice(0, 4) + "••••••••••••" + value.slice(-4);

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-gray-500 tracking-wide">{label}</p>
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-900/60 border border-gray-700 rounded-lg">
        <span className="flex-1 font-mono text-sm text-gray-300 truncate select-all">
          {revealed && show ? value : masked}
        </span>
        {revealed && (
          <button
            onClick={() => setShow(s => !s)}
            className="text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0"
          >
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Connected exchange card ───────────────────────────────────────────────────

interface ConnectedCardProps {
  exch: { id: string; name: string; fields: string[]; docs: string };
  market: { id: string };
  userEmail: string;
  botActiveForMarket: boolean;   // ← NEW: bot is running for this market
  onEdit: () => void;
}

function ConnectedCard({ exch, market, userEmail, botActiveForMarket, onEdit }: ConnectedCardProps) {
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [revealed,     setRevealed]     = useState<RevealedKeys | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState("");

  // Reveal handled by OtpModal (verify + reveal) — modal returns revealed keys via onVerified

  const allFields = [
    { label: exch.fields[0], value: revealed?.apiKey    ?? "" },
    { label: exch.fields[1], value: revealed?.apiSecret ?? "" },
    ...Object.entries(revealed?.extra ?? {}).map(([k, v]) => ({ label: k, value: v as string })),
  ];

  return (
    <>
      {showOtpModal && (
        <OtpModal
          email={userEmail}
          revealParams={{ marketType: market.id, exchangeName: exch.id }}
          onVerified={(data) => { setShowOtpModal(false); setRevealed(data ?? null); }}
          onClose={() => setShowOtpModal(false)}
        />
      )}

      <div className="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <CheckCircle className="w-4 h-4 text-brand-500 flex-shrink-0" />
            <span className="text-sm font-medium text-gray-200">{exch.name}</span>
            <span className="text-xs text-brand-500 bg-brand-500/10 border border-brand-500/20 px-2 py-0.5 rounded-full">Saved</span>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={exch.docs}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-600 hover:text-brand-500 flex items-center gap-1 transition-colors"
            >
              <ExternalLink className="w-3 h-3" /> Docs
            </a>
            {botActiveForMarket ? (
              // ── Bot is running for this market: show locked edit button ──
              <div
                title="Stop the bot for this market before editing API keys"
                className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-800 border border-gray-700 px-2.5 py-1.5 rounded-lg cursor-not-allowed select-none"
              >
                <Lock className="w-3 h-3" /> Locked
              </div>
            ) : (
              <button
                onClick={onEdit}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-brand-500 bg-gray-800 hover:bg-gray-700 border border-gray-700 px-2.5 py-1.5 rounded-lg transition-colors"
              >
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
          </div>
        </div>

        {/* Bot-active warning banner */}
        {botActiveForMarket && (
          <div className="mx-4 mb-3 flex items-start gap-2 bg-amber-900/15 border border-amber-900/30 rounded-lg px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-400/80">
              Bot is actively trading on this market. Stop the bot to edit these API keys.
            </p>
          </div>
        )}

        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-gray-700/40">
          {loading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading keys…
            </div>
          ) : error ? (
            <p className="text-xs text-red-400 py-1">{error}</p>
          ) : (
            allFields.map(f => (
              <MaskedField key={f.label} label={f.label} value={f.value || "••••••••••••••••"} revealed={!!revealed} />
            ))
          )}

          {!revealed && !loading && (
            <button
              onClick={() => setShowOtpModal(true)}
              className="flex items-center gap-2 text-xs text-gray-400 hover:text-brand-500 transition-colors mt-1"
            >
              <KeyRound className="w-3.5 h-3.5" />
              View API keys — requires OTP verification
            </button>
          )}

          {revealed && (
            <div className="flex items-center gap-1.5 text-xs text-brand-500 mt-1">
              <CheckCircle className="w-3 h-3" />
              Verified — keys visible for 5 minutes
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Exchange input form ───────────────────────────────────────────────────────

interface ExchangeFormProps {
  exch: { id: string; name: string; fields: string[]; docs: string };
  marketId: string;
  prefill?: RevealedKeys | null;
  onSaved: () => void;
  onCancel: () => void;
  isEdit?: boolean;
}

function ExchangeForm({ exch, marketId, prefill, onSaved, onCancel, isEdit }: ExchangeFormProps) {
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

  // Warn on unload when form has unsaved changes
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

// ── Exchange row ──────────────────────────────────────────────────────────────

interface ExchangeRowProps {
  exch: { id: string; name: string; fields: string[]; docs: string };
  market: { id: string };
  saved: boolean;
  userEmail: string;
  botActiveForMarket: boolean;
  editingKey: string | null;
  editPrefill: RevealedKeys | null;
  onEdit: () => void;
  onSaved: () => void;
  onCancelEdit: () => void;
  onEditOtpModal: () => void;
}

function ExchangeRow({
  exch, market, saved, userEmail, botActiveForMarket,
  editingKey, editPrefill, onEdit, onSaved, onCancelEdit, onEditOtpModal,
}: ExchangeRowProps) {
  const key = `${market.id}_${exch.id}`;
  const isEditing = editingKey === key;
  const [formOpen, setFormOpen] = useState(false);

  if (isEditing) {
    return (
      <ExchangeForm
        exch={exch}
        marketId={market.id}
        prefill={editPrefill}
        isEdit
        onSaved={() => { onSaved(); setFormOpen(false); }}
        onCancel={() => { onCancelEdit(); setFormOpen(false); }}
      />
    );
  }

  if (saved) {
    return (
      <ConnectedCard
        exch={exch}
        market={market}
        userEmail={userEmail}
        botActiveForMarket={botActiveForMarket}
        onEdit={onEditOtpModal}
      />
    );
  }

  return (
    <div className="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
      <button
        onClick={() => setFormOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/60 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <div className="w-4 h-4 rounded-full border-2 border-gray-600 flex-shrink-0" />
          <span className="text-sm font-medium text-gray-400">{exch.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={exch.docs}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-xs text-gray-600 hover:text-brand-500 flex items-center gap-1 transition-colors"
          >
            <ExternalLink className="w-3 h-3" /> Docs
          </a>
          <div className="flex items-center gap-1 text-xs text-gray-500">
            {formOpen ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <><Plus className="w-3.5 h-3.5" /> Connect</>
            )}
          </div>
        </div>
      </button>

      {formOpen && (
        <div className="border-t border-gray-700/40">
          <ExchangeForm
            exch={exch}
            marketId={market.id}
            prefill={null}
            onSaved={() => { setFormOpen(false); onSaved(); }}
            onCancel={() => setFormOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function MarketsPage() {
  const qc = useQueryClient();
  const [expanded,      setExpanded]      = useState<string | null>(null);
  const [editingKey,    setEditingKey]    = useState<string | null>(null);
  const [editPrefill,   setEditPrefill]   = useState<RevealedKeys | null>(null);
  const [editOtpModal,  setEditOtpModal]  = useState<{ marketId: string; exchId: string } | null>(null);

  const { data: existingApis } = useQuery<SavedApi[]>({
    queryKey: QUERY_KEYS.EXCHANGE_APIS,
    queryFn:  () => apiFetch("/api/exchange"),
  });

  // Fetch bot status to know which markets are actively running
  const { data: botData } = useBotStatusQuery();

  const botRunning      = botData?.status === 'running';
  const activeMarkets: string[] = botData?.activeMarkets ?? [];

  const { data: meData } = useQuery<MeResponse | null>({
    queryKey: QUERY_KEYS.ME,
    queryFn:  () => apiFetch<MeResponse>("/api/me").catch(() => null),
    staleTime: Infinity,
  });
  const userEmail = meData?.email ?? "your email";

  function isSaved(marketId: string, exchId: string) {
    return existingApis?.some(a => a.marketType === marketId && a.exchangeName === exchId);
  }

  // Is the bot actively running for this specific market?
  function isBotActiveForMarket(marketId: string) {
    return botRunning && activeMarkets.includes(marketId);
  }

  // Editing reveal handled by OtpModal; modal will return keys via onVerified

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold text-gray-100">Markets & API Setup</h1>
        <p className="text-sm text-gray-500 mt-1">
          Connect exchanges for each market. Keys are AES-256 encrypted. Viewing requires OTP verification.
        </p>
      </div>

      <div className="bg-amber-900/15 border border-amber-900/30 rounded-xl px-4 py-3 flex items-start gap-3">
        <Shield className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
        <div className="text-xs text-amber-400/80 space-y-1">
          <p className="font-medium text-amber-400">Security reminder</p>
          <p>Only enable <strong>Trade</strong> permissions. Never enable <strong>Withdrawal</strong>. Always whitelist your server IP.</p>
        </div>
      </div>

      {/* Bot-running banner */}
      {botRunning && activeMarkets.length > 0 && (
        <div className="bg-brand-500/5 border border-brand-500/20 rounded-xl px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-brand-500 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-brand-500/80">
            Bot is running for <strong className="text-brand-500">{activeMarkets.join(', ')}</strong>.
            API keys for these markets are locked. Stop the bot to edit them.
          </p>
        </div>
      )}

      {/* Edit OTP modal */}
      {editOtpModal && (
        <OtpModal
          email={userEmail}
          revealParams={{ marketType: editOtpModal.marketId, exchangeName: editOtpModal.exchId }}
          onVerified={(data) => {
            const mid = editOtpModal!.marketId
            const eid = editOtpModal!.exchId
            setEditOtpModal(null)
            setEditPrefill(data ?? null)
            setEditingKey(`${mid}_${eid}`)
          }}
          onClose={() => setEditOtpModal(null)}
        />
      )}

      {/* Market accordions */}
      {MARKETS.map(market => {
        const hasConnection    = market.exchanges.some(e => isSaved(market.id, e.id));
        const isOpen           = expanded === market.id;
        const botActiveHere    = isBotActiveForMarket(market.id);

        return (
          <div key={market.id} className="card overflow-hidden">
            <button
              onClick={() => setExpanded(isOpen ? null : market.id)}
              className="w-full flex items-center justify-between text-left"
            >
              <div>
                <p className="text-sm font-semibold text-gray-200">{market.label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{market.desc}</p>
              </div>
              <div className="flex items-center gap-3">
                {botActiveHere && (
                  <span className="text-xs text-brand-500 bg-brand-500/10 border border-brand-500/20 px-2 py-0.5 rounded-full flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
                    Bot Active
                  </span>
                )}
                {hasConnection && !botActiveHere && (
                  <span className="text-xs text-brand-500 bg-brand-500/10 border border-brand-500/20 px-2 py-0.5 rounded-full">
                    Connected
                  </span>
                )}
                {isOpen
                  ? <ChevronUp className="w-4 h-4 text-gray-500" />
                  : <ChevronDown className="w-4 h-4 text-gray-500" />
                }
              </div>
            </button>

            {isOpen && (
              <div className="mt-4 pt-4 border-t border-gray-800 space-y-2">
                {market.exchanges.map(exch => {
                  const rowKey = `${market.id}_${exch.id}`;
                  const saved  = isSaved(market.id, exch.id) ?? false;

                  return (
                    <ExchangeRow
                      key={rowKey}
                      exch={exch}
                      market={market}
                      saved={saved}
                      userEmail={userEmail}
                      botActiveForMarket={botActiveHere}
                      editingKey={editingKey}
                      editPrefill={editPrefill}
                      onEdit={() => setEditingKey(rowKey)}
                      onSaved={() => {
                        setEditingKey(null);
                        setEditPrefill(null);
                                        qc.invalidateQueries({ queryKey: QUERY_KEYS.EXCHANGE_APIS });
                      }}
                      onCancelEdit={() => {
                        setEditingKey(null);
                        setEditPrefill(null);
                      }}
                      onEditOtpModal={() => {
                        // Block edit only if the bot is active for this market
                        if (botActiveHere) return;
                        setEditOtpModal({ marketId: market.id, exchId: exch.id });
                      }}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
