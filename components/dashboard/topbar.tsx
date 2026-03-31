'use client'

// components/dashboard/topbar.tsx — v2
// Shows: running / stopping-graceful / stopping-close_all / stopped

import { signOut } from 'next-auth/react'
import { useQuery } from '@tanstack/react-query'
import { LogOut, Bell, Menu, AlertTriangle } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { MobileSidebar } from '@/components/dashboard/sidebar'

interface TopBarProps {
  user?: {
    name?: string | null
    email?: string | null
    image?: string | null
  } | null
}

function useRunTimer(startedAt: string | null | undefined): string {
  const [, setTick] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!startedAt) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }
    setTick(t => t + 1)
    intervalRef.current = setInterval(() => setTick(t => t + 1), 1000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [startedAt])

  if (!startedAt) return ''
  const diff = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
  const h = Math.floor(diff / 3600)
  const m = Math.floor((diff % 3600) / 60)
  const s = diff % 60
  if (h > 0) return `${h}h ${m}m ${String(s).padStart(2, '0')}s`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

export function TopBar({ user }: TopBarProps) {
  const [menuOpen,      setMenuOpen]      = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const { data: botData, isLoading: botLoading } = useQuery({
    queryKey:        ['bot-status'],
    queryFn:         () => fetch('/api/bot/status').then(r => r.json()),
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
  })

  const status:         string  = botData?.status         ?? 'stopped'
  const stopMode:       string  = botData?.stopMode       ?? ''
  const openTradeCount: number  = botData?.openTradeCount ?? 0
  const timeoutWarning: boolean = botData?.timeoutWarning ?? false
  const isRunning   = status === 'running'
  const isStopping  = status === 'stopping'
  const isCloseAll  = isStopping && stopMode === 'close_all'
  const isGraceful  = isStopping && stopMode === 'graceful'
  const runTime     = useRunTimer(isRunning ? botData?.startedAt : null)

  const displayName = user?.name || user?.email?.split('@')[0] || 'User'
  const userInitial = displayName.charAt(0).toUpperCase()

  const pillConfig = (() => {
    if (botLoading && !botData) return null
    if (isRunning) return {
      classes: 'bg-brand-500/10 border-brand-500/20 text-brand-500',
      dot:     'bg-brand-500 animate-pulse',
      label:   'Bot Running',
      sub:     botData?.activeMarkets?.length > 0
        ? `· ${botData.activeMarkets.join(', ')}${runTime ? ` · ${runTime}` : ''}`
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
      <header className="flex items-center justify-between px-4 md:px-6 py-3 border-b border-gray-800 bg-gray-900 flex-shrink-0">

        <button
          className="md:hidden flex items-center justify-center w-9 h-9 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 transition-colors"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        {/* Status pill */}
        {botLoading && !botData ? (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border bg-gray-800 border-gray-700 text-gray-500">
            Loading…
          </div>
        ) : pillConfig ? (
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${pillConfig.classes}`}>
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${pillConfig.dot}`} />
            <span>{pillConfig.label}</span>
            {pillConfig.sub && (
              <span className="opacity-70">{pillConfig.sub}</span>
            )}
            {timeoutWarning && isStopping && (
              <AlertTriangle className="w-3 h-3 ml-0.5" />
            )}
          </div>
        ) : null}

        {/* Right side */}
        <div className="flex items-center gap-2">
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
                  onClick={() => signOut({ callbackUrl: '/access' })}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-red-400 hover:bg-red-900/20 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
    </>
  )
}