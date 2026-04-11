"use client";
import { useQuery } from "@tanstack/react-query";
import { useBotStatusQuery } from '@/lib/use-bot-status-query'
import { QUERY_KEYS } from '@/lib/query-keys'
import { POLL_INTERVALS } from '@/lib/polling-config'
import { apiFetch } from '@/lib/api-client'

type StrategyCatalogResponse = { strategies?: any[] }
type StrategyConfigDataResponse = { markets?: any[] }
type RiskSettingsResponse = { paperBalance?: number }

export function useStrategySettings() {
  const { data: strategyData, isLoading: strategiesLoading } = useQuery<StrategyCatalogResponse>({
    queryKey: QUERY_KEYS.STRATEGY_CATALOG,
    queryFn: () => apiFetch('/api/strategies'),
  })

  const { data: configData, isLoading: configsLoading } = useQuery<StrategyConfigDataResponse>({
    queryKey: QUERY_KEYS.STRATEGY_CONFIGS,
    queryFn: () => apiFetch('/api/strategy-config'),
    select: (data: any) => data,
    staleTime: POLL_INTERVALS.STRATEGY,
  })

  const { data: riskData } = useQuery<RiskSettingsResponse>({
    queryKey: QUERY_KEYS.RISK_SETTINGS,
    queryFn: () => apiFetch('/api/risk-settings'),
  })

  const { data: botData } = useBotStatusQuery()

  return { strategyData, strategiesLoading, configData, configsLoading, riskData, botData }
}
