 'use client'
 import Link from 'next/link'
 import { usePathname } from 'next/navigation'
 import {
   LayoutDashboard, Settings, History,
   BarChart2, Layers, ChevronRight, Zap, BookOpen, Layers3,
 } from 'lucide-react'
 import { cn } from '@/lib/utils'
 import SidebarItem from '@/components/dashboard/sidebar/SidebarItem'

export const dashboardNav = [
  { href: '/dashboard',              icon: LayoutDashboard, label: 'Dashboard' },
  { href: '/dashboard/markets',      icon: Layers,          label: 'Markets & APIs' },
  { href: '/dashboard/trades',       icon: History,         label: 'Trade History' },
  { href: '/dashboard/bot-history',  icon: BookOpen,        label: 'Bot History' },
  { href: '/dashboard/performance',  icon: BarChart2,       label: 'Performance' },
  { href: '/dashboard/strategy-engine', icon: Layers3,      label: 'Strategy Engine' },
  { href: '/dashboard/settings',     icon: Settings,        label: 'Bot Settings' },
]

export interface MobileSidebarProps {
  open: boolean
  onClose: () => void
}

export function MobileSidebar({ open, onClose }: MobileSidebarProps) {
  const pathname = usePathname()
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative h-full w-[85vw] max-w-xs bg-gray-900 border-r border-gray-800 shadow-xl">
        <div className="flex items-center justify-between px-4 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center flex-shrink-0">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-gray-100">UpBot</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 transition-colors">
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
        <nav className="p-3 space-y-1 overflow-y-auto h-[calc(100%-72px)]">
          {dashboardNav.map(({ href, icon: Icon, label }) => {
              const active = pathname === href
              const className = cn('flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm transition-colors',
                active ? 'bg-brand-500/15 text-brand-500 font-medium' : 'text-gray-300 hover:text-gray-100 hover:bg-gray-800')
              return (
                <SidebarItem key={href} href={href} Icon={Icon} label={label} active={active} onClick={onClose} className={className} />
              )
            })}
        </nav>
      </div>
    </div>
  )
}

export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="hidden md:flex flex-col w-56 bg-gray-900 border-r border-gray-800 flex-shrink-0">
      <div className="flex items-center gap-2.5 px-4 py-5 border-b border-gray-800">
        <div className="w-8 h-8 rounded-lg bg-brand-500 flex items-center justify-center flex-shrink-0">
          <Zap className="w-4 h-4 text-white" />
        </div>
        <span className="font-semibold text-gray-100">UpBot</span>
      </div>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {dashboardNav.map(({ href, icon: Icon, label }) => {
          const active = pathname === href
          const className = cn('flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm transition-colors group',
                active ? 'bg-brand-500/15 text-brand-500 font-medium' : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800')
          return (
            <SidebarItem key={href} href={href} Icon={Icon} label={label} active={active} className={className} />
          )
        })}
      </nav>
      <div className="px-4 py-3 border-t border-gray-800">
        <p className="text-xs text-gray-700">UpBot v2.0.0</p>
      </div>
    </aside>
  )
}
