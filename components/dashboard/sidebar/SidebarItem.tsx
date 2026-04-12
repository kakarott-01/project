"use client"
import Link from 'next/link'
import React from 'react'
import { cn } from '@/lib/utils'
import { ChevronRight } from 'lucide-react'

type Props = {
  href: string
  Icon: any
  label: string
  active?: boolean
  onClick?: () => void
  className?: string
}

function SidebarItem({ href, Icon, label, active = false, onClick, className }: Props) {
  return (
    <Link href={href} onClick={onClick} className={className}>
      <Icon className="w-4 h-4 flex-shrink-0" />
      <span className="flex-1">{label}</span>
      {active && <ChevronRight className="w-3 h-3" />}
    </Link>
  )
}

export default React.memo(SidebarItem)
