'use client'

import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BOT_STATUS_QUERY_KEY, isValidBotSnapshot } from '@/lib/bot-status-client'
import {
  AlertTriangle, Shield, Clock, CheckCircle,
  Loader2, Lock, MailCheck, X, ChevronDown, ChevronUp,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { ToggleSwitch } from '@/components/ui/toggle-switch'
import { apiFetch } from '@/lib/api-client'

type TradingMode = 'paper' | 'live'

interface MarketModeState {
  marketType: string
  mode:       TradingMode
  isActive:   boolean
  updatedAt:  string
}

interface ModesResponse {
  botRunning:    boolean
  activeMarkets: string[]
  markets:       MarketModeState[]
}

interface AuditLog {
  id:        string
  scope:     string
  fromMode:  TradingMode
  toMode:    TradingMode
  ipAddress: string
  createdAt: string
}

interface AuditLogResponse {
  logs?: AuditLog[]
}

interface MeResponse {
  email?: string
}

const MARKET_LABELS: Record<string, string> = {
  indian:      '🇮🇳 Indian Markets',
  crypto:      '₿ Crypto',
  commodities: '🛢 Commodities',
  global:      '🌐 Global',
}

const ModeOtpModal = dynamic(() => import('@/components/modals/mode-otp-modal'), { ssr: false })
const ModeLiveWarningModal = dynamic(() => import('@/components/modals/mode-live-warning-modal'), { ssr: false })
const ModePaperConfirmModal = dynamic(() => import('@/components/modals/mode-paper-confirm-modal'), { ssr: false })

// ── Audit log ─────────────────────────────────────────────────────────────────

function AuditLog() {
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery({
    queryKey: ['mode-audit'],
    queryFn:  () => apiFetch<AuditLogResponse>('/api/mode/audit?limit=10'),
    enabled:  open,
  })

  const logs: AuditLog[] = data?.logs ?? []

  return (
    <div className="border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-800/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Clock className="w-3.5 h-3.5 text-gray-500" />
          <span className="text-xs font-medium text-gray-400">Mode Switch History</span>
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-gray-600" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-600" />}
      </button>

      {open && (
        <div className="border-t border-gray-800">
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-4 h-4 animate-spin text-gray-600" />
            </div>
          ) : logs.length === 0 ? (
            <p className="text-xs text-gray-600 text-center py-6">No mode switches yet</p>
          ) : (
            <div className="divide-y divide-gray-800/50">
              {logs.map(log => (
                <div key={log.id} className="flex items-center justify-between px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500 capitalize">{log.scope.replace('exchange:', '')}</span>
                    <span className="text-xs text-gray-600">·</span>
                    <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                      log.fromMode === 'paper'
                        ? 'bg-amber-900/20 text-amber-400'
                        : 'bg-red-900/20 text-red-400'
                    }`}>{log.fromMode}</span>
                    <span className="text-xs text-gray-600">→</span>
                    <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                      log.toMode === 'paper'
                        ? 'bg-amber-900/20 text-amber-400'
                        : 'bg-red-900/20 text-red-400'
                    }`}>{log.toMode}</span>
                  </div>
                  <span className="text-xs text-gray-600">
                    {new Date(log.createdAt).toLocaleString('en-IN', {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                    })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ModeControls() {
  const qc = useQueryClient()

  const [pending, setPending] = useState<{
    marketType: string
    toMode:     TradingMode
    step:       'warning' | 'otp' | 'paper-confirm'
  } | null>(null)

  const { data: meData } = useQuery({
    queryKey: ['me'],
    queryFn:  () => apiFetch<MeResponse>('/api/me'),
    staleTime: Infinity,
  })

  const { data, isLoading } = useQuery<ModesResponse>({
    queryKey:        ['market-modes'],
    queryFn:         () => apiFetch('/api/mode'),
    refetchInterval: 10_000,
  })

  const switchMut = useMutation({
    mutationFn: async ({ marketType, toMode }: { marketType: string; toMode: TradingMode }) => {
      return apiFetch('/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marketType, toMode }) })
    },
    onMutate: async ({ marketType, toMode }) => {
      await qc.cancelQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      await qc.cancelQueries({ queryKey: ['market-modes'] })
      const previousBot = qc.getQueryData(BOT_STATUS_QUERY_KEY)
      const previous = qc.getQueryData(['market-modes'])
      qc.setQueryData(['market-modes'], (old: any) => {
        if (!old || !old.markets) return old
        return { ...old, markets: old.markets.map((m: any) => m.marketType === marketType ? { ...m, mode: toMode } : m) }
      })
      return { previous, previousBot }
    },
    onError: (err: Error, _vars, context: any) => {
      console.error('Mode switch failed:', err.message)
      if (context?.previous) qc.setQueryData(['market-modes'], context.previous)
      if (context?.previousBot && isValidBotSnapshot(context.previousBot)) qc.setQueryData(BOT_STATUS_QUERY_KEY, context.previousBot)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['market-modes'] })
      qc.invalidateQueries({ queryKey: BOT_STATUS_QUERY_KEY })
      setPending(null)
    },
  })

  const botRunning    = data?.botRunning ?? false
  const activeMarkets = data?.activeMarkets ?? []
  const markets       = data?.markets ?? []
  const userEmail     = meData?.email ?? 'your email'

  function requestSwitch(marketType: string, toMode: TradingMode) {
    if (botRunning) return
    if (toMode === 'live') {
      setPending({ marketType, toMode, step: 'warning' })
    } else {
      setPending({ marketType, toMode, step: 'paper-confirm' })
    }
  }

  function handleWarningConfirmed() {
    if (!pending) return
    setPending({ ...pending, step: 'otp' })
  }

  function handleOtpVerified() {
    if (!pending) return
    switchMut.mutate({ marketType: pending.marketType, toMode: pending.toMode })
  }

  function handlePaperConfirmed() {
    if (!pending) return
    switchMut.mutate({ marketType: pending.marketType, toMode: pending.toMode })
  }

  const ALL_MARKETS = ['indian', 'crypto', 'commodities', 'global']
  const displayMarkets = ALL_MARKETS.map(mt => {
    const found = markets.find(m => m.marketType === mt)
    return found ?? { marketType: mt, mode: 'paper' as TradingMode, isActive: false, updatedAt: '' }
  })

  return (
    <>
      {pending?.step === 'warning' && (
        <ModeLiveWarningModal
          marketType={pending.marketType}
          onConfirm={handleWarningConfirmed}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.step === 'otp' && (
        <ModeOtpModal
          email={userEmail}
          onVerified={handleOtpVerified}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.step === 'paper-confirm' && (
        <ModePaperConfirmModal
          marketType={pending.marketType}
          onConfirm={handlePaperConfirmed}
          onClose={() => setPending(null)}
        />
      )}

      <div className="card space-y-5">
        <div className="flex items-center justify-between pb-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-brand-500" />
            <h2 className="text-sm font-medium text-gray-200">Trading Mode</h2>
          </div>
          {botRunning && (
            <div className="flex items-center gap-1.5 text-xs text-amber-400 bg-amber-900/20
                            border border-amber-900/30 rounded-lg px-2.5 py-1">
              <AlertTriangle className="w-3 h-3" />
              Stop bot to change modes
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-5 h-5 animate-spin text-gray-600" />
          </div>
        ) : (
          <div className="space-y-3">
            {displayMarkets.map(({ marketType, mode }) => {
              const isLive      = mode === 'live'
              const isBotActive = botRunning && activeMarkets.includes(marketType)
              const switching   = switchMut.isPending && pending?.marketType === marketType

              return (
                <div
                  key={marketType}
                  className={`flex items-center justify-between px-4 py-3 rounded-xl border transition-colors ${
                    isLive
                      ? 'bg-red-950/20 border-red-900/40'
                      : 'bg-gray-800/40 border-gray-700/50'
                  }`}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0 mr-4">
                    <span className="text-sm text-gray-300 truncate">
                      {MARKET_LABELS[marketType] ?? marketType}
                    </span>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border flex-shrink-0 ${
                      isLive
                        ? 'bg-red-900/30 border-red-800/40 text-red-400'
                        : 'bg-amber-900/20 border-amber-800/30 text-amber-400'
                    }`}>
                      {isLive ? '🔴 LIVE' : '🟡 PAPER'}
                    </span>
                    {isBotActive && (
                      <span className="text-xs text-brand-500 bg-brand-500/10 border border-brand-500/20 px-2 py-0.5 rounded-full flex-shrink-0">
                        Bot active
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {switching && <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-500" />}
                    {/* ── Uses the same ToggleSwitch as Trailing Stop Loss ── */}
                    <ToggleSwitch
                      checked={isLive}
                      onChange={() => {
                        if (!isBotActive && !switching) {
                          requestSwitch(marketType, isLive ? 'paper' : 'live')
                        }
                      }}
                      disabled={isBotActive || switching || botRunning}
                      colorOn="bg-red-600"
                      colorOff="bg-gray-600"
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <p className="text-xs text-gray-600 leading-relaxed">
          Mode changes take effect on the next bot start. Switching requires the bot to be stopped for that market.
          Paper → Live requires email OTP confirmation.
        </p>

        <AuditLog />
      </div>
    </>
  )
}
