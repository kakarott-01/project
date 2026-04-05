import type { StrategyConflict } from './types'

type StrategyProfile = {
  cadence: 'high_frequency' | 'intraday' | 'swing'
  style: 'trend' | 'mean_reversion' | 'breakout'
}

const PROFILES: Record<string, StrategyProfile> = {
  TREND_RIDER_V1: { cadence: 'swing', style: 'trend' },
  MEAN_REVERSION_PRO: { cadence: 'high_frequency', style: 'mean_reversion' },
  BREAKOUT_PULSE_X: { cadence: 'intraday', style: 'breakout' },
}

export function analyzeStrategyConflicts(strategyKeys: string[]): StrategyConflict[] {
  if (strategyKeys.length < 2) return []

  const [left, right] = strategyKeys
  const a = PROFILES[left]
  const b = PROFILES[right]
  if (!a || !b) return []

  const conflicts: StrategyConflict[] = []

  if (
    (a.style === 'trend' && b.style === 'mean_reversion') ||
    (a.style === 'mean_reversion' && b.style === 'trend') ||
    (a.style === 'breakout' && b.style === 'mean_reversion') ||
    (a.style === 'mean_reversion' && b.style === 'breakout')
  ) {
    conflicts.push({
      code: 'OPPOSITE_SIGNAL_RISK',
      severity: 'warning',
      message: `${left} and ${right} can naturally emit opposite signals on the same symbol.`,
    })
  }

  if (
    (a.cadence === 'high_frequency' && b.cadence === 'swing') ||
    (a.cadence === 'swing' && b.cadence === 'high_frequency')
  ) {
    conflicts.push({
      code: 'CADENCE_MISMATCH',
      severity: 'warning',
      message: `${left} is short-horizon while ${right} is slower-moving, which can cause churn in AGGRESSIVE mode.`,
    })
  }

  return conflicts
}

export function hasBlockingConflict(conflicts: StrategyConflict[]) {
  return conflicts.some((conflict) => conflict.severity === 'blocking')
}
