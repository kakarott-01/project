'use client'

import { signOut } from 'next-auth/react'
import { useQuery } from '@tanstack/react-query'
import { LogOut, Bell, Menu } from 'lucide-react'
import { useState } from 'react'
import { formatDistanceToNowStrict } from 'date-fns'
import { MobileSidebar } from '@/components/dashboard/sidebar'

interface TopBarProps {
  user?: {
    name?: string | null
    email?: string | null
    image?: string | null
  } | null
}

export function TopBar({ user }: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const { data: botData } = useQuery({
    queryKey: ['bot-status'],
    queryFn: () => fetch('/api/bot/status').then(r => r.json()),
    refetchInterval: 5000,
  })

  const isRunning = botData?.status === 'running'
  const botStartedAt = botData?.startedAt ? new Date(botData.startedAt) : null
  const runTime = botStartedAt ? formatDistanceToNowStrict(botStartedAt, { addSuffix: false }) : null

  // ✅ Safe user values
  const displayName =
    user?.name ||
    user?.email?.split('@')[0] ||
    'User'

  const userInitial = displayName.charAt(0).toUpperCase()

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

        {/* Bot status pill */}
      <div
        className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${
          isRunning
            ? 'bg-brand-500/10 border-brand-500/20 text-brand-500'
            : 'bg-gray-800 border-gray-700 text-gray-500'
        }`}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            isRunning ? 'bg-brand-500 animate-pulse' : 'bg-gray-600'
          }`}
        />
        Bot {isRunning ? 'Running' : 'Stopped'}
        {isRunning && botData?.activeMarkets?.length > 0 && (
          <span className="text-gray-500">
            · {botData.activeMarkets.join(', ')}
          </span>
        )}
        {isRunning && runTime && (
          <span className="text-gray-400">· up {runTime}</span>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2">
        
        {/* Notifications */}
        <button className="w-8 h-8 rounded-lg bg-gray-800 hover:bg-gray-700 flex items-center justify-center transition-colors">
          <Bell className="w-4 h-4 text-gray-500" />
        </button>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-gray-800 transition-colors"
          >
            {/* ✅ Safe avatar */}
            {user?.image ? (
              <img
                src={user.image}
                className="w-6 h-6 rounded-full"
                alt="user"
              />
            ) : (
              <div className="w-6 h-6 rounded-full bg-brand-500 flex items-center justify-center text-xs text-white font-semibold">
                {userInitial}
              </div>
            )}

            <span className="text-sm text-gray-400 hidden md:block">
              {displayName}
            </span>
          </button>

          {/* Dropdown */}
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 w-48 bg-gray-900 border border-gray-800 rounded-xl shadow-xl z-50 overflow-hidden">
              
              <div className="px-3 py-2.5 border-b border-gray-800">
                <p className="text-xs font-medium text-gray-300 truncate">
                  {displayName}
                </p>
                {user?.email && (
                  <p className="text-xs text-gray-600 truncate">
                    {user.email}
                  </p>
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