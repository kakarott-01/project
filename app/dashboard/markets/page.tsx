"use client";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle, ChevronDown, ChevronUp, Shield, ExternalLink,
  Eye, EyeOff, Pencil, X, Loader2, Lock, KeyRound, MailCheck, Plus,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SavedApi {
  id: string;
  marketType: string;
  exchangeName: string;
  exchangeLabel?: string;
  isVerified: boolean;
  isActive: boolean;
}

interface RevealedKeys {
  apiKey: string;
  apiSecret: string;
  extra: Record<string, string>;
}

// ── Market / exchange config ──────────────────────────────────────────────────

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
      { id: "fyers",     name: "Fyers",                  fields: ["App ID", "Secret Key"],                       docs: "https://fyers.in" },
      { id: "dhan",      name: "Dhan (MCX)",              fields: ["Client ID", "Access Token"],                  docs: "https://dhanhq.co" },
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

// ── OTP Modal ─────────────────────────────────────────────────────────────────

interface OtpModalProps {
  email: string;
  onVerified: () => void;
  onClose: () => void;
}

function OtpModal({ email, onVerified, onClose }: OtpModalProps) {
  const [digits, setDigits]   = useState(["", "", "", "", "", ""]);
  const [error,  setError]    = useState("");
  const [sent,   setSent]     = useState(false);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => { sendOtp(); }, []);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  async function sendOtp() {
    setSending(true);
    setError("");
    const res  = await fetch("/api/exchange/send-reveal-otp", { method: "POST" });
    const data = await res.json();
    setSending(false);
    if (res.ok) {
      setSent(true);
      setResendCooldown(60);
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } else {
      setError(data.error ?? "Failed to send OTP");
    }
  }

  async function verify() {
    const code = digits.join("");
    if (code.length !== 6) return;
    setVerifying(true);
    setError("");
    const res  = await fetch("/api/exchange/verify-reveal-otp", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ otp: code }),
    });
    const data = await res.json();
    setVerifying(false);
    if (res.ok) {
      onVerified();
    } else {
      setError(data.error ?? "Invalid OTP");
      setDigits(["", "", "", "", "", ""]);
      setTimeout(() => inputRefs.current[0]?.focus(), 50);
    }
  }

  function handleDigit(val: string, idx: number) {
    if (!/^\d*$/.test(val)) return;
    const next = [...digits];
    next[idx] = val.slice(-1);
    setDigits(next);
    if (val && idx < 5) inputRefs.current[idx + 1]?.focus();
    if (next.every(d => d) && val) setTimeout(verify, 80);
  }

  function handleKeyDown(e: React.KeyboardEvent, idx: number) {
    if (e.key === "Backspace" && !digits[idx] && idx > 0)
      inputRefs.current[idx - 1]?.focus();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(3,7,18,0.85)", backdropFilter: "blur(4px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand-500/15 flex items-center justify-center">
              <Lock className="w-4 h-4 text-brand-500" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-100">Verify to view keys</p>
              <p className="text-xs text-gray-500">Security check required</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-5">
          {sending && !sent ? (
            <div className="flex flex-col items-center py-4 gap-3">
              <Loader2 className="w-6 h-6 text-brand-500 animate-spin" />
              <p className="text-sm text-gray-400">Sending OTP to your email…</p>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2.5 bg-brand-500/5 border border-brand-500/15 rounded-xl px-3.5 py-3 mb-5">
                <MailCheck className="w-4 h-4 text-brand-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-gray-400">
                  A 6-digit code was sent to <span className="text-gray-200 font-medium">{email}</span>.
                  Enter it below to view your API keys.
                </p>
              </div>

              <div className="flex gap-2 justify-center mb-4">
                {digits.map((d, i) => (
                  <input
                    key={i}
                    ref={el => { inputRefs.current[i] = el; }}
                    value={d}
                    onChange={e => handleDigit(e.target.value, i)}
                    onKeyDown={e => handleKeyDown(e, i)}
                    maxLength={1}
                    inputMode="numeric"
                    autoFocus={i === 0 && sent}
                    className="w-11 h-12 text-center text-lg font-semibold bg-gray-800 border border-gray-700 rounded-lg text-gray-100 focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none transition-all"
                  />
                ))}
              </div>

              {error && (
                <p className="text-xs text-red-400 text-center mb-3">{error}</p>
              )}

              <button
                onClick={verify}
                disabled={digits.join("").length !== 6 || verifying}
                className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all
                  bg-brand-500 hover:bg-brand-600 text-white
                  disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed"
              >
                {verifying
                  ? <span className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Verifying…</span>
                  : "Verify & View Keys"
                }
              </button>

              <button
                onClick={sendOtp}
                disabled={resendCooldown > 0 || sending}
                className="w-full mt-2 py-2 text-xs text-gray-500 hover:text-gray-300 disabled:text-gray-700 disabled:cursor-not-allowed transition-colors"
              >
                {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : "Resend OTP"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

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
  onEdit: () => void;
}

function ConnectedCard({ exch, market, userEmail, onEdit }: ConnectedCardProps) {
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [revealed,     setRevealed]     = useState<RevealedKeys | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState("");

  async function handleOtpVerified() {
    setShowOtpModal(false);
    setLoading(true);
    setError("");

    const res = await fetch("/api/exchange/reveal", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ marketType: market.id, exchangeName: exch.id }),
    });
    const data = await res.json();
    setLoading(false);

    if (res.ok) {
      setRevealed(data);
    } else {
      setError(data.error ?? "Failed to load keys");
    }
  }

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
          onVerified={handleOtpVerified}
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
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-brand-500 bg-gray-800 hover:bg-gray-700 border border-gray-700 px-2.5 py-1.5 rounded-lg transition-colors"
            >
              <Pencil className="w-3 h-3" /> Edit
            </button>
          </div>
        </div>

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

// ── Exchange input form ────────────────────────────────────────────────────────

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

  async function handleSave() {
    const apiKey = vals[exch.fields[0]] ?? "";
    const apiSec = vals[exch.fields[1]] ?? "";
    if (!apiKey || !apiSec) { setError("API Key and Secret are required."); return; }

    setSaving(true);
    setError("");

    const extra = exch.fields.slice(2).reduce((acc, f) => ({ ...acc, [f]: vals[f] ?? "" }), {});

    const res = await fetch("/api/exchange", {
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

    const data = await res.json();
    setSaving(false);

    if (res.ok) {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ["exchange-apis"] });
      setTimeout(() => { onSaved(); }, 1200);
    } else {
      setError(data.error ?? "Failed to save keys");
    }
  }

  return (
    <div className="bg-gray-800/40 rounded-xl border border-gray-700/50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700/40">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-300">{exch.name}</span>
          {isEdit && <span className="text-xs text-amber-400 bg-amber-900/20 border border-amber-800/30 px-2 py-0.5 rounded-full">Editing</span>}
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
              onChange={e => setVals(prev => ({ ...prev, [field]: e.target.value }))}
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
  editingKey: string | null;
  editPrefill: RevealedKeys | null;
  onEdit: () => void;
  onSaved: () => void;
  onCancelEdit: () => void;
  onEditOtpModal: () => void;
}

function ExchangeRow({
  exch, market, saved, userEmail, editingKey, editPrefill,
  onEdit, onSaved, onCancelEdit, onEditOtpModal,
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
    return <ConnectedCard exch={exch} market={market} userEmail={userEmail} onEdit={onEditOtpModal} />;
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
  // ✅ FIX: Start with null — no market expanded by default on page visit
  const [expanded, setExpanded]           = useState<string | null>(null);
  const [editingKey, setEditingKey]       = useState<string | null>(null);
  const [editPrefill, setEditPrefill]     = useState<RevealedKeys | null>(null);
  const [editOtpModal, setEditOtpModal]   = useState<{ marketId: string; exchId: string } | null>(null);

  const { data: existingApis } = useQuery<SavedApi[]>({
    queryKey: ["exchange-apis"],
    queryFn:  () => fetch("/api/exchange").then(r => r.json()),
  });

  const { data: meData } = useQuery({
    queryKey: ["me"],
    queryFn:  () => fetch("/api/me").then(r => r.json()).catch(() => null),
    staleTime: Infinity,
  });
  const userEmail = meData?.email ?? "your email";

  function isSaved(marketId: string, exchId: string) {
    return existingApis?.some(a => a.marketType === marketId && a.exchangeName === exchId);
  }

  // ✅ FIX: Removed the useEffect that was auto-expanding markets on page visit.
  // Users now manually click to expand any market they want.

  async function handleEditOtpVerified(marketId: string, exchId: string) {
    setEditOtpModal(null);
    const res = await fetch("/api/exchange/reveal", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ marketType: marketId, exchangeName: exchId }),
    });
    if (res.ok) {
      const data = await res.json();
      setEditPrefill(data);
    }
    setEditingKey(`${marketId}_${exchId}`);
  }

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

      {/* Edit OTP modal */}
      {editOtpModal && (
        <OtpModal
          email={userEmail}
          onVerified={() => handleEditOtpVerified(editOtpModal.marketId, editOtpModal.exchId)}
          onClose={() => setEditOtpModal(null)}
        />
      )}

      {/* Market accordions */}
      {MARKETS.map(market => {
        const hasConnection = market.exchanges.some(e => isSaved(market.id, e.id));
        const isOpen = expanded === market.id;

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
                {hasConnection && (
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
                  const key   = `${market.id}_${exch.id}`;
                  const saved = isSaved(market.id, exch.id) ?? false;

                  return (
                    <ExchangeRow
                      key={key}
                      exch={exch}
                      market={market}
                      saved={saved}
                      userEmail={userEmail}
                      editingKey={editingKey}
                      editPrefill={editPrefill}
                      onEdit={() => setEditingKey(key)}
                      onSaved={() => {
                        setEditingKey(null);
                        setEditPrefill(null);
                        qc.invalidateQueries({ queryKey: ["exchange-apis"] });
                      }}
                      onCancelEdit={() => {
                        setEditingKey(null);
                        setEditPrefill(null);
                      }}
                      onEditOtpModal={() => setEditOtpModal({ marketId: market.id, exchId: exch.id })}
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