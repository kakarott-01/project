import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { PUBLIC_STRATEGY_CATALOG, ensureStrategyCatalogSeeded } from '@/lib/strategies/catalog'

export async function GET() {
  const session = await auth()
  if (!session?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await ensureStrategyCatalogSeeded()
  return NextResponse.json({
    strategies: PUBLIC_STRATEGY_CATALOG,
  })
}
