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

// Components extracted to components/dashboard/markets and loaded dynamically
const ConnectedCard = dynamic(() => import('@/components/dashboard/markets/ConnectedCard'), { ssr: false });
const ExchangeForm = dynamic(() => import('@/components/dashboard/markets/ExchangeForm'), { ssr: false });
const ExchangeRow = dynamic(() => import('@/components/dashboard/markets/ExchangeRow'), { ssr: false });

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
