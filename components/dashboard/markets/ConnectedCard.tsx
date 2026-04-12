"use client";
import React, { useState } from "react";
import dynamic from "next/dynamic";
const OtpModal = dynamic(() => import('@/components/modals/otp-modal'), { ssr: false });
import { CheckCircle, Loader2, Lock, KeyRound, ExternalLink, AlertTriangle, Pencil } from "lucide-react";
import MaskedField from '@/components/dashboard/markets/MaskedField'
import type { RevealedKeys } from '@/lib/hooks/use-exchange-otp'

interface ConnectedCardProps {
  exch: { id: string; name: string; fields: string[]; docs: string };
  market: { id: string };
  userEmail: string;
  botActiveForMarket: boolean;
  onEdit: () => void;
}

export default function ConnectedCard({ exch, market, userEmail, botActiveForMarket, onEdit }: ConnectedCardProps) {
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [revealed,     setRevealed]     = useState<RevealedKeys | null>(null);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState("");

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
