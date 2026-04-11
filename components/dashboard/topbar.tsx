'use client'

import { useMutationState } from '@tanstack/react-query'
import { LogOut, Bell, Menu, AlertTriangle, X } from 'lucide-react'
import { useState } from 'react'
import { useEffect } from 'react'
import { MobileSidebar } from '@/components/dashboard/sidebar'
import { useBotStatusQuery } from '@/lib/use-bot-status-query'
import { formatElapsedDuration, getSessionDurationMs } from '@/lib/time'
import { apiFetch } from '@/lib/api-client'

interface TopBarProps {
  user?: {
    name?: string | null
    email?: string | null
    image?: string | null
  } | null
}

export function TopBar({ user }: TopBarProps) {
  const [menuOpen,      setMenuOpen]      = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [isSigningOut,  setIsSigningOut]  = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const now = Date.now()

  useEffect(() => {
    try {
      const v = window.localStorage.getItem('sessionExpired')
      if (v === '1') {
        setSessionExpired(true)
        // Clear immediately so it doesn't persist across re-login
        window.localStorage.removeItem('sessionExpired')
      }
    } catch (_) {}
  }, [])

  function dismissSessionExpired() {
    setSessionExpired(false)
    try { window.localStorage.removeItem('sessionExpired') } catch (_) {}
  }

  const { data: botData, isLoading: botLoading } = useBotStatusQuery()

  const pendingStarts = useMutationState({
    filters: { mutationKey: ['bot-start'], status: 'pending' },
    select: (mutation) => mutation.state.variables as { markets?: string[] } | undefined,
  })

  const status:         string  = botData?.status         ?? 'stopped'
  const activeMarkets = botData?.activeMarkets ?? []
  const stopMode:       string  = botData?.stopMode       ?? ''
  const openTradeCount: number  = botData?.openTradeCount ?? 0
  const timeoutWarning: boolean = botData?.timeoutWarning ?? false
  const isRunning   = status === 'running'
  const isStopping  = status === 'stopping'
  const isCloseAll  = isStopping && stopMode === 'close_all'
  const isGraceful  = isStopping && stopMode === 'graceful'
  const pendingMarkets = Array.from(new Set(
    pendingStarts.flatMap((entry) => Array.isArray(entry?.markets) ? entry.markets : []),
  ))
  const isStarting = !isRunning && pendingMarkets.length > 0
  const runTime = isRunning && botData?.started_at
    ? formatElapsedDuration(getSessionDurationMs(botData.started_at, null, now))
    : ''

  const displayName = user?.name || user?.email?.split('@')[0] || 'User'
  const userInitial = displayName.charAt(0).toUpperCase()

  async function handleLogout() {
    if (isSigningOut) return
    setIsSigningOut(true)
    try {
      await apiFetch('/api/logout', { method: 'POST' })
    } catch {
      // Best effort
    } finally {
      window.location.href = '/login'
    }
  }

  const pillConfig = (() => {
    if (isStarting) return {
      classes: 'bg-brand-500/10 border-brand-500/20 text-brand-500',
      dot:     'bg-brand-500 animate-pulse',
      label:   'Starting bot…',
      sub:     pendingMarkets.length > 0 ? `· ${pendingMarkets.join(', ')}` : '',
    }
    if (botLoading && !botData) return null
    if (isRunning) return {
      classes: 'bg-brand-500/10 border-brand-500/20 text-brand-500',
      dot:     'bg-brand-500 animate-pulse',
      label:   'Bot Running',
      sub:     activeMarkets.length > 0
        ? `· ${activeMarkets.join(', ')}${runTime ? ` · ${runTime}` : ''}`
        : '',
    }
    if (isCloseAll) return {
      classes: 'bg-red-500/10 border-red-500/20 text-red-400',
      dot:     `bg-red-400 animate-pulse`,
      label:   'Closing positions…',
      sub:     '',
    }
    if (isGraceful) return {
      classes: timeoutWarning
        ? 'bg-red-500/10 border-red-500/20 text-red-400'
        : 'bg-amber-500/10 border-amber-500/20 text-amber-400',
      dot:     timeoutWarning ? 'bg-red-400 animate-pulse' : 'bg-amber-400 animate-pulse',
      label:   'Draining…',
      sub:     openTradeCount > 0 ? `· ${openTradeCount} open` : '',
    }
    return {
      classes: 'bg-gray-800 border-gray-700 text-gray-500',
      dot:     'bg-gray-600',
      label:   'Bot Stopped',
      sub:     '',
    }
  })()

  return (
    <>
      <MobileSidebar open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      {sessionExpired && (
        <div className="w-full bg-red-900/90 text-white px-4 py-2 text-xs flex items-center justify-between">
          <span>Session expired. Please re-login.</span>
          <div className="flex items-center gap-3">
            <button onClick={() => { window.location.href = '/login' }} className="underline font-medium">Re-login</button>
            <button onClick={dismissSessionExpired} className="text-white/70 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
      <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900 flex-shrink-0 md:px-6">

        <button
          className="md:hidden flex items-center justify-center w-10 h-10 rounded-xl bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors flex-shrink-0"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        {botLoading && !botData && !isStarting ? (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border bg-gray-800 border-gray-700 text-gray-500">
            Loading…
          </div>
        ) : pillConfig ? (
          <div className={`min-w-0 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${pillConfig.classes}`}>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${pillConfig.dot}`} />
            <span className="truncate">{pillConfig.label}</span>
            {pillConfig.sub && (
              <span className="hidden truncate opacity-70 sm:block">{pillConfig.sub}</span>
            )}
            {timeoutWarning && isStopping && (
              <AlertTriangle className="w-3 h-3 ml-0.5" />
            )}
          </div>
        ) : null}

        <div className="flex items-center gap-2 flex-shrink-0">
          <button className="w-8 h-8 rounded-lg bg-gray-800 hover:bg-gray-700 flex items-center justify-center transition-colors">
            <Bell className="w-4 h-4 text-gray-500" />
          </button>

          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-800 transition-colors"
            >
              {user?.image ? (
                <img src={user.image} className="w-6 h-6 rounded-full" alt="user" />
              ) : (
                <div className="w-6 h-6 rounded-full bg-brand-500 flex items-center justify-center text-xs text-white font-semibold">
                  {userInitial}
                </div>
              )}
              <span className="text-sm text-gray-400 hidden md:block">{displayName}</span>
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-gray-900 border border-gray-800 rounded-xl shadow-xl z-50 overflow-hidden">
                <div className="px-3 py-2.5 border-b border-gray-800">
                  <p className="text-xs font-medium text-gray-300 truncate">{displayName}</p>
                  {user?.email && (
                    <p className="text-xs text-gray-600 truncate">{user.email}</p>
                  )}
                </div>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-red-400 hover:bg-red-900/20 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  {isSigningOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
    </>
  )
}