"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BOT_STATUS_QUERY_KEY,
  isValidBotSnapshot,
} from "@/lib/bot-status-client";
import { QUERY_KEYS } from "@/lib/query-keys";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Layers3,
  Loader2,
} from "lucide-react";
import dynamic from 'next/dynamic'
import { Button } from "@/components/ui/button";
import { InlineAlert } from "@/components/ui/inline-alert";
import { StatusBadge } from "@/components/ui/status-badge";
import { InfoTip } from "@/components/ui/tooltip";
import NumberField from '@/components/dashboard/strategy-settings/NumberField'
import { defaultStrategySettings, toStrategyPayload } from '@/components/dashboard/strategy-settings/helpers'
import { useToastStore } from "@/lib/toast-store";
import { isBotLocked } from "@/lib/bot-lock";
import { useBotStatusQuery } from '@/lib/use-bot-status-query';
import { POLL_INTERVALS } from "@/lib/polling-config";
import { apiFetch } from '@/lib/api-client';
import { useStrategySettings } from '@/components/dashboard/strategy-settings/useStrategySettings'

const MARKETS = [
  { id: "crypto", label: "Crypto", publicLabel: "CRYPTO" },
  { id: "indian", label: "Indian", publicLabel: "STOCKS" },
  { id: "global", label: "Forex", publicLabel: "STOCKS" },
  { id: "commodities", label: "Commodities", publicLabel: "FOREX" },
] as const;

type MarketId = (typeof MARKETS)[number]["id"];

type RuntimeConfig = {
  executionMode: "SAFE" | "AGGRESSIVE";
  positionMode: "NET" | "HEDGE";
  allowHedgeOpposition: boolean;
  conflictBlocking: boolean;
  maxPositionsPerSymbol: number;
  maxCapitalPerStrategyPct: number;
  maxDrawdownPct: number;
  strategyKeys: string[];
  strategySettings: Record<
    string,
    {
      priority: "HIGH" | "MEDIUM" | "LOW";
      cooldownAfterTradeSec: number;
      capitalAllocation: {
        perTradePercent: number;
        maxActivePercent: number;
      };
      health: {
        minWinRatePct: number;
        maxDrawdownPct: number;
        maxLossStreak: number;
        isAutoDisabled: boolean;
        autoDisabledReason?: string | null;
        lastTradeAt?: string | null;
      };
    }
  >;
  conflictWarnings?: Array<{
    code: string;
    severity: "info" | "warning" | "blocking";
    message: string;
  }>;
  exchangeCapabilities?: {
    supportsHedgeMode: boolean;
    effectivePositionMode: "NET" | "HEDGE";
    warning?: string;
  } | null;
};

type StrategyCatalogResponse = {
  strategies?: StrategyItem[]
}

type StrategyConfigMarket = {
  marketType: MarketId
  executionMode: 'SAFE' | 'AGGRESSIVE'
  positionMode?: 'NET' | 'HEDGE'
  allowHedgeOpposition?: boolean
  conflictBlocking?: boolean
  maxPositionsPerSymbol?: number
  maxCapitalPerStrategyPct?: number
  maxDrawdownPct?: number
  strategyKeys: string[]
  strategySettings?: Record<string, any>
  conflictWarnings?: Array<{ code: string; severity: 'info' | 'warning' | 'blocking'; message: string }>
  exchangeCapabilities?: any
}

type StrategyConfigDataResponse = {
  markets?: StrategyConfigMarket[]
}

type RiskSettingsResponse = {
  paperBalance?: number
}

type StrategyItem = {
  strategyKey: string;
  name: string;
  description: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  supportedMarkets: Array<"CRYPTO" | "STOCKS" | "FOREX">;
  supportedTimeframes: string[];
  historicalPerformance: {
    winRate: number;
    averageReturn: number;
    maxDrawdown: number;
    sharpeRatio: number;
  };
};


function marketCategory(market: MarketId) {
  return MARKETS.find((item) => item.id === market)?.publicLabel ?? "CRYPTO";
}

// AggressiveModeModal moved to components/modals/aggressive-mode-modal.tsx and will be lazy-loaded where used.

const AggressiveModeModal = dynamic(() => import('@/components/modals/aggressive-mode-modal'), { ssr: false })

// NumberField, defaultStrategySettings and toStrategyPayload moved to helpers/NumberField

// ── Market section summary badges ─────────────────────────────────────────────
function MarketSummaryBadges({
  config,
  isActive,
}: {
  config: RuntimeConfig;
  isActive: boolean;
}) {
  const hasStrategies = config.strategyKeys.length > 0;
  const isAggressive = config.executionMode === "AGGRESSIVE";

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {hasStrategies ? (
        <span className="text-xs text-brand-500 bg-brand-500/10 border border-brand-500/20 px-2 py-0.5 rounded-full">
          {config.strategyKeys.length} strategy
        </span>
      ) : (
        <span className="text-xs text-gray-600 bg-gray-800 border border-gray-700 px-2 py-0.5 rounded-full">
          No strategies
        </span>
      )}
      {isAggressive && (
        <span className="text-xs text-red-400 bg-red-900/20 border border-red-800/30 px-2 py-0.5 rounded-full">
          AGGRESSIVE
        </span>
      )}
      {isActive && (
        <span className="flex items-center gap-1 text-xs text-amber-400 bg-amber-900/20 border border-amber-800/30 px-2 py-0.5 rounded-full">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          Bot Active
        </span>
      )}
    </div>
  );
}

export function StrategySettings() {
  const qc = useQueryClient();
  const pushToast = useToastStore((state) => state.push);
  const [configs, setConfigs] = useState<Record<string, RuntimeConfig>>({});
  const [savingMarket, setSavingMarket] = useState<string | null>(null);
  const [pendingAggressiveSave, setPendingAggressiveSave] = useState<{
    marketType: MarketId;
    config: RuntimeConfig;
  } | null>(null);
  // ── NEW: track which market sections are expanded (all collapsed by default)
  const [expandedMarkets, setExpandedMarkets] = useState<Set<string>>(
    new Set(),
  );
  // ── NEW: track which market configs have unsaved user edits
  const [dirtyMarkets, setDirtyMarkets] = useState<Set<string>>(new Set());

  const { strategyData, strategiesLoading, configData, configsLoading, riskData, botData } = useStrategySettings()

  useEffect(() => {
    if (!configData?.markets) return

    const markets = configData.markets

    setConfigs(prev => {
      const next = { ...prev }

      for (const market of markets) {
        if (!dirtyMarkets.has(market.marketType)) {
          next[market.marketType] = {
            executionMode: market.executionMode,
            positionMode: market.positionMode ?? "NET",
            allowHedgeOpposition: market.allowHedgeOpposition ?? false,
            conflictBlocking: market.conflictBlocking ?? false,
            maxPositionsPerSymbol: market.maxPositionsPerSymbol ?? 2,
            maxCapitalPerStrategyPct: market.maxCapitalPerStrategyPct ?? 25,
            maxDrawdownPct: market.maxDrawdownPct ?? 12,
            strategyKeys: market.strategyKeys,
            strategySettings: market.strategySettings ?? {},
            conflictWarnings: market.conflictWarnings ?? [],
            exchangeCapabilities: market.exchangeCapabilities ?? null,
          }
        }
      }

      return next
    })
    // Intentionally only re-run when fresh config data arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configData])

  const saveMutation = useMutation({
    mutationFn: async ({ marketType, config, aggressiveConfirmed }: { marketType: MarketId; config: RuntimeConfig; aggressiveConfirmed: boolean }) => {
      return apiFetch('/api/strategy-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketType,
          executionMode: config.executionMode,
          positionMode: config.positionMode,
          allowHedgeOpposition: config.allowHedgeOpposition,
          conflictBlocking: config.conflictBlocking,
          maxPositionsPerSymbol: config.maxPositionsPerSymbol,
          maxCapitalPerStrategyPct: config.maxCapitalPerStrategyPct,
          maxDrawdownPct: config.maxDrawdownPct,
          aggressiveConfirmed,
          strategyKeys: config.strategyKeys,
          strategySettings: toStrategyPayload(config.strategySettings),
        }),
      })
    },
    onMutate: async ({ marketType }) => {
      setSavingMarket(marketType);
      await qc.cancelQueries({ queryKey: BOT_STATUS_QUERY_KEY });
      await qc.cancelQueries({ queryKey: QUERY_KEYS.STRATEGY_CONFIGS });
      const previousBot = qc.getQueryData(BOT_STATUS_QUERY_KEY);
      const previous = qc.getQueryData(QUERY_KEYS.STRATEGY_CONFIGS as any);
      return { previous, previousBot };
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.STRATEGY_CONFIGS });
      setDirtyMarkets(prev => {
        const copy = new Set(prev)
        copy.delete(variables.marketType)
        return copy
      })
      pushToast({
        tone: "success",
        title: `${MARKETS.find((item) => item.id === variables.marketType)?.label ?? variables.marketType} saved`,
        description: "Strategy allocation and market controls are updated.",
      });
    },
    onError: (error: Error, _vars, context: any) => {
      if (context?.previous)
        qc.setQueryData(QUERY_KEYS.STRATEGY_CONFIGS as any, context.previous);
      if (context?.previousBot && isValidBotSnapshot(context.previousBot))
        qc.setQueryData(BOT_STATUS_QUERY_KEY, context.previousBot);
      pushToast({
        tone: "error",
        title: "Save failed",
        description: error.message,
      });
    },
    onSettled: () => {
      setSavingMarket(null);
      setPendingAggressiveSave(null);
      qc.invalidateQueries({ queryKey: BOT_STATUS_QUERY_KEY });
    },
  });

  const strategies: StrategyItem[] | undefined = strategyData?.strategies;
  // const botIsLocked = botData?.status === 'running' || botData?.status === 'stopping'
  const activeMarkets: string[] = botData?.activeMarkets ?? [];
  const totalCapital = Number(riskData?.paperBalance ?? 10000);
  const strategiesByMarket = useMemo(() => {
    const result: Record<string, StrategyItem[]> = {};
    if (!strategies) {
      for (const market of MARKETS) {
        result[market.id] = [];
      }
      return result;
    }
    for (const market of MARKETS) {
      result[market.id] = strategies.filter((item) =>
        item.supportedMarkets.includes(marketCategory(market.id) as any),
      );
    }
    return result;
  }, [strategies]);

  function updateMarket(
    marketType: MarketId,
    updater: (current: RuntimeConfig) => RuntimeConfig,
  ) {
    // mark this market as dirty so local edits aren't clobbered by refetches
    setDirtyMarkets((prev) => {
      const copy = new Set(prev)
      copy.add(marketType)
      return copy
    })
    setConfigs((previous) => {
      const current = previous[marketType] ?? {
        executionMode: "SAFE",
        positionMode: "NET",
        allowHedgeOpposition: false,
        conflictBlocking: false,
        maxPositionsPerSymbol: 2,
        maxCapitalPerStrategyPct: 25,
        maxDrawdownPct: 12,
        strategyKeys: [],
        strategySettings: {},
        conflictWarnings: [],
        exchangeCapabilities: null,
      };
      return { ...previous, [marketType]: updater(current) };
    });
  }

  function toggleStrategy(marketType: MarketId, strategyKey: string) {
    updateMarket(marketType, (current) => {
      const exists = current.strategyKeys.includes(strategyKey);
      const nextKeys = exists
        ? current.strategyKeys.filter((key) => key !== strategyKey)
        : [...current.strategyKeys, strategyKey].slice(0, 2);
      const nextSettings = Object.fromEntries(
        nextKeys.map((key) => [
          key,
          current.strategySettings[key] ?? defaultStrategySettings(),
        ]),
      );
      return {
        ...current,
        strategyKeys: nextKeys,
        strategySettings: nextSettings,
      };
    });
  }

  function handleSave(marketType: MarketId, config: RuntimeConfig) {
    if (config.executionMode === "AGGRESSIVE") {
      setPendingAggressiveSave({ marketType, config });
      return;
    }
    saveMutation.mutate({ marketType, config, aggressiveConfirmed: false });
  }

  // ── Toggle expand/collapse for a market section ───────────────────────────
  function toggleMarket(marketId: string) {
    setExpandedMarkets((prev) => {
      const next = new Set(prev);
      if (next.has(marketId)) {
        next.delete(marketId);
      } else {
        next.add(marketId);
      }
      return next;
    });
  }

  if (strategiesLoading || configsLoading) {
    return (
      <div className="card flex items-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading strategy configuration…
      </div>
    );
  }

  return (
    <>
      {pendingAggressiveSave ? (
        <AggressiveModeModal
          market={
            MARKETS.find((item) => item.id === pendingAggressiveSave.marketType)
              ?.label ?? pendingAggressiveSave.marketType
          }
          onCancel={() => setPendingAggressiveSave(null)}
          onConfirm={() =>
            saveMutation.mutate({
              marketType: pendingAggressiveSave.marketType,
              config: pendingAggressiveSave.config,
              aggressiveConfirmed: true,
            })
          }
        />
      ) : null}

      <div className="card space-y-5 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-gray-800 pb-3">
          <Layers3 className="h-4 w-4 text-brand-500" />
          <div>
            <h2 className="text-sm font-medium text-gray-200">
              Strategy Engine
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              GLOBAL hard limits live in Bot Settings. MARKET and STRATEGY
              controls below guide allocation inside those boundaries.
            </p>
          </div>
        </div>

        <InlineAlert tone="info" title="Capital hierarchy">
          Global Risk Controls are hard limits. Strategy Allocation is a soft
          layer per market, and AGGRESSIVE mode enforces per-strategy capital
          splits before global checks approve the final order.
        </InlineAlert>

        {activeMarkets.length > 0 ? (
          <InlineAlert
            tone="info"
            title={`Bot running on: ${activeMarkets.join(", ")}`}
          >
            Active markets are locked. You can freely edit strategies for idle
            markets below.
          </InlineAlert>
        ) : null}

        {/* ── Collapsible market sections ─────────────────────────────────── */}
        <div className="space-y-3">
          {MARKETS.map((market) => {
            const isExpanded = expandedMarkets.has(market.id);
            const config = configs[market.id] ?? {
              executionMode: "SAFE",
              positionMode: "NET",
              allowHedgeOpposition: false,
              conflictBlocking: false,
              maxPositionsPerSymbol: 2,
              maxCapitalPerStrategyPct: 25,
              maxDrawdownPct: 12,
              strategyKeys: [],
              strategySettings: {},
              conflictWarnings: [],
              exchangeCapabilities: null,
            };
            const isAggressive = config.executionMode === "AGGRESSIVE";
            const isBotActiveHere = activeMarkets.includes(market.id);
            const capitalCards = config.strategyKeys.map((strategyKey) => {
              const settings =
                config.strategySettings[strategyKey] ??
                defaultStrategySettings();
              const maxActiveCapital =
                totalCapital *
                (settings.capitalAllocation.maxActivePercent / 100);
              const perTradeCapital =
                totalCapital *
                (settings.capitalAllocation.perTradePercent / 100);
              return {
                strategyKey,
                maxActiveCapital,
                perTradeCapital,
                settings,
              };
            });
            const marketCap =
              totalCapital * (config.maxCapitalPerStrategyPct / 100);
            const allocatedCapital = capitalCards.reduce(
              (sum, item) => sum + item.maxActiveCapital,
              0,
            );
            const remainingCapital = Math.max(
              0,
              totalCapital - allocatedCapital,
            );

            return (
              <div
                key={market.id}
                className={`rounded-2xl border transition-colors overflow-hidden ${
                  isExpanded
                    ? "border-gray-700 bg-gray-900/50"
                    : "border-gray-800 bg-gray-900/20 hover:border-gray-700"
                }`}
              >
                {/* ── Accordion header (always visible) ───────────────────── */}
                <button
                  type="button"
                  onClick={() => toggleMarket(market.id)}
                  className="w-full flex items-center justify-between px-5 py-4 text-left transition-colors hover:bg-gray-800/30"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-gray-100">
                          {market.label}
                        </span>
                        <MarketSummaryBadges
                          config={config}
                          isActive={isBotActiveHere}
                        />
                      </div>
                      {!isExpanded && config.strategyKeys.length > 0 && (
                        <p className="text-xs text-gray-500 mt-0.5">
                          {config.strategyKeys.join(", ")} ·{" "}
                          {config.executionMode}
                        </p>
                      )}
                      {!isExpanded && config.strategyKeys.length === 0 && (
                        <p className="text-xs text-gray-600 mt-0.5">
                          Click to configure strategies
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-3">
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4 text-gray-500" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-gray-500" />
                    )}
                  </div>
                </button>

                {/* ── Expanded content ─────────────────────────────────────── */}
                {isExpanded && (
                  <div className="px-5 pb-5 border-t border-gray-800 pt-5">
                    {isBotActiveHere && (
                      <InlineAlert
                        tone="warning"
                        title={`${market.label} is actively trading.`}
                        className="mb-4"
                      >
                        Stop this market before changing its strategy
                        configuration.
                      </InlineAlert>
                    )}
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between mb-5">
                      <div>
                        <p className="text-sm text-gray-500 max-w-2xl">
                          SAFE keeps positions netted. AGGRESSIVE lets selected
                          strategies trade independently while still respecting
                          global limits.
                        </p>
                      </div>
                      <div className="inline-flex overflow-hidden rounded-xl border border-gray-700 flex-shrink-0">
                        {(["SAFE", "AGGRESSIVE"] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            disabled={isBotActiveHere}
                            onClick={() =>
                              updateMarket(market.id, (current) => ({
                                ...current,
                                executionMode: mode,
                                positionMode:
                                  mode === "SAFE"
                                    ? "NET"
                                    : current.positionMode,
                                allowHedgeOpposition:
                                  mode === "SAFE"
                                    ? false
                                    : current.allowHedgeOpposition,
                              }))
                            }
                            className={`px-4 py-2 text-xs font-medium transition ${
                              config.executionMode === mode
                                ? mode === "AGGRESSIVE"
                                  ? "bg-red-500/15 text-red-200"
                                  : "bg-brand-500/15 text-brand-300"
                                : "text-gray-500 hover:text-gray-300"
                            }`}
                          >
                            {mode}
                          </button>
                        ))}
                      </div>
                    </div>

                    {isAggressive ? (
                      <InlineAlert
                        tone="danger"
                        title="AGGRESSIVE mode is active"
                        className="mb-4"
                      >
                        Strategies trade independently. Capital splits,
                        priority-based blocking, and hedge behavior now matter
                        market by market.
                      </InlineAlert>
                    ) : null}

                    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)]">
                      <div className="space-y-4">
                        <div className="grid gap-3 md:grid-cols-2">
                          <NumberField
                            label="Max positions / symbol"
                            tip="Hard market-level ceiling before a symbol is considered saturated."
                            value={config.maxPositionsPerSymbol}
                            min={1}
                            max={10}
                            disabled={isBotActiveHere}
                            onChange={(value) =>
                              updateMarket(market.id, (current) => ({
                                ...current,
                                maxPositionsPerSymbol: value,
                              }))
                            }
                          />
                          <NumberField
                            label="Market max capital %"
                            tip="Soft cap for this market's strategy exposure. Global max position size still caps each order."
                            value={config.maxCapitalPerStrategyPct}
                            min={1}
                            max={100}
                            suffix="%"
                            disabled={isBotActiveHere}
                            onChange={(value) =>
                              updateMarket(market.id, (current) => ({
                                ...current,
                                maxCapitalPerStrategyPct: value,
                              }))
                            }
                          />
                        </div>

                        <div className="grid gap-3 md:grid-cols-3">
                          <label className="space-y-1.5">
                            <span className="flex items-center gap-2 text-xs text-gray-500">
                              Position mode
                              <InfoTip text="NET keeps one net position per symbol. HEDGE allows opposing exposure if the exchange supports it." />
                            </span>
                            <select
                              disabled={isBotActiveHere || !isAggressive}
                              value={config.positionMode}
                              onChange={(event) =>
                                updateMarket(market.id, (current) => ({
                                  ...current,
                                  positionMode: event.target.value as
                                    | "NET"
                                    | "HEDGE",
                                }))
                              }
                              className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-gray-100 disabled:opacity-60"
                            >
                              <option value="NET">NET</option>
                              <option value="HEDGE">HEDGE</option>
                            </select>
                          </label>
                          <NumberField
                            label="Auto-stop drawdown %"
                            tip="If strategy drawdown breaches this threshold, new entries are halted for that market."
                            value={config.maxDrawdownPct}
                            min={1}
                            max={100}
                            suffix="%"
                            disabled={isBotActiveHere}
                            onChange={(value) =>
                              updateMarket(market.id, (current) => ({
                                ...current,
                                maxDrawdownPct: value,
                              }))
                            }
                          />
                          <div className="rounded-2xl border border-gray-800 bg-gray-950/50 p-4">
                            <p className="text-xs text-gray-500">
                              Exchange capability
                            </p>
                            <p className="mt-2 text-sm font-semibold text-gray-100">
                              {config.exchangeCapabilities
                                ?.effectivePositionMode ?? config.positionMode}
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-gray-500">
                              {config.exchangeCapabilities?.warning ??
                                "No exchange restrictions detected for this market."}
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-4 text-xs text-gray-400">
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={config.allowHedgeOpposition}
                              disabled={
                                isBotActiveHere ||
                                config.positionMode !== "HEDGE"
                              }
                              onChange={(event) =>
                                updateMarket(market.id, (current) => ({
                                  ...current,
                                  allowHedgeOpposition: event.target.checked,
                                }))
                              }
                            />
                            Allow LONG + SHORT simultaneously
                          </label>
                          <label className="inline-flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={config.conflictBlocking}
                              disabled={isBotActiveHere}
                              onChange={(event) =>
                                updateMarket(market.id, (current) => ({
                                  ...current,
                                  conflictBlocking: event.target.checked,
                                }))
                              }
                            />
                            Block start when conflicts are detected
                          </label>
                        </div>

                        {(config.conflictWarnings?.length ?? 0) > 0 ? (
                          <InlineAlert
                            tone="warning"
                            title="Conflict detection"
                          >
                            {config.conflictWarnings?.map((warning) => (
                              <p key={warning.code}>{warning.message}</p>
                            ))}
                          </InlineAlert>
                        ) : null}
                      </div>

                      {/* Capital allocation preview */}
                      <div className="rounded-3xl border border-gray-800 bg-gray-950/40 p-4">
                        <div className="flex items-center gap-2">
                          <StatusBadge tone="neutral">CAPITAL</StatusBadge>
                          <p className="text-sm font-medium text-gray-200">
                            Allocation preview
                          </p>
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-3">
                          <div className="rounded-2xl border border-gray-800 bg-gray-950/60 p-3">
                            <p className="text-[11px] uppercase tracking-[0.14em] text-gray-500">
                              Total capital
                            </p>
                            <p className="mt-2 text-sm font-semibold text-gray-100">
                              ₹{totalCapital.toLocaleString("en-IN")}
                            </p>
                          </div>
                          <div className="rounded-2xl border border-gray-800 bg-gray-950/60 p-3">
                            <p className="text-[11px] uppercase tracking-[0.14em] text-gray-500">
                              Per-market allocation
                            </p>
                            <p className="mt-2 text-sm font-semibold text-gray-100">
                              ₹
                              {marketCap.toLocaleString("en-IN", {
                                maximumFractionDigits: 0,
                              })}
                            </p>
                          </div>
                          <div className="rounded-2xl border border-gray-800 bg-gray-950/60 p-3">
                            <p className="text-[11px] uppercase tracking-[0.14em] text-gray-500">
                              Per-strategy allocation
                            </p>
                            <p className="mt-2 text-sm font-semibold text-gray-100">
                              ₹
                              {allocatedCapital.toLocaleString("en-IN", {
                                maximumFractionDigits: 0,
                              })}
                            </p>
                          </div>
                          <div className="rounded-2xl border border-gray-800 bg-gray-950/60 p-3">
                            <p className="text-[11px] uppercase tracking-[0.14em] text-gray-500">
                              Remaining capital
                            </p>
                            <p className="mt-2 text-sm font-semibold text-gray-100">
                              ₹
                              {remainingCapital.toLocaleString("en-IN", {
                                maximumFractionDigits: 0,
                              })}
                            </p>
                          </div>
                        </div>
                        <div className="mt-4 space-y-2">
                          {capitalCards.length > 0 ? (
                            capitalCards.map((item) => (
                              <div
                                key={item.strategyKey}
                                className="rounded-2xl border border-gray-800 bg-gray-950/60 p-3"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-sm font-medium text-gray-100">
                                    {item.strategyKey}
                                  </p>
                                  <StatusBadge
                                    tone={
                                      item.settings.priority === "HIGH"
                                        ? "danger"
                                        : item.settings.priority === "MEDIUM"
                                          ? "warning"
                                          : "neutral"
                                    }
                                  >
                                    {item.settings.priority}
                                  </StatusBadge>
                                </div>
                                <p className="mt-2 text-xs text-gray-500">
                                  Per trade ₹
                                  {item.perTradeCapital.toLocaleString(
                                    "en-IN",
                                    { maximumFractionDigits: 0 },
                                  )}{" "}
                                  · Max active ₹
                                  {item.maxActiveCapital.toLocaleString(
                                    "en-IN",
                                    { maximumFractionDigits: 0 },
                                  )}
                                </p>
                              </div>
                            ))
                          ) : (
                            <div className="rounded-2xl border border-dashed border-gray-800 bg-gray-950/40 px-4 py-8 text-center">
                              <p className="text-sm text-gray-300">
                                No strategies selected
                              </p>
                              <p className="mt-1 text-xs text-gray-500">
                                Pick up to two strategies to see per-market and
                                per-strategy capital allocation.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Strategy selection */}
                    <div className="mt-5">
                      <div className="mb-3 flex items-center gap-2">
                        <StatusBadge tone="success">STRATEGY</StatusBadge>
                        <p className="text-sm font-medium text-gray-200">
                          Select up to 2 strategies
                        </p>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {(strategiesByMarket[market.id] ?? []).map(
                          (strategy) => {
                            const selected = config.strategyKeys.includes(
                              strategy.strategyKey,
                            );
                            return (
                              <button
                                key={strategy.strategyKey}
                                type="button"
                                disabled={
                                  isBotActiveHere ||
                                  (!selected && config.strategyKeys.length >= 2)
                                }
                                onClick={() =>
                                  toggleStrategy(
                                    market.id,
                                    strategy.strategyKey,
                                  )
                                }
                                className={`rounded-2xl border p-4 text-left transition ${
                                  selected
                                    ? "border-brand-500/50 bg-brand-500/10"
                                    : "border-gray-800 bg-gray-950/60 hover:border-gray-700"
                                } disabled:cursor-not-allowed disabled:opacity-50`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <span className="text-sm font-medium text-gray-100">
                                    {strategy.name}
                                  </span>
                                  <StatusBadge
                                    tone={
                                      strategy.riskLevel === "HIGH"
                                        ? "danger"
                                        : strategy.riskLevel === "MEDIUM"
                                          ? "warning"
                                          : "success"
                                    }
                                  >
                                    {strategy.riskLevel}
                                  </StatusBadge>
                                </div>
                                <p className="mt-2 text-xs text-gray-400">
                                  {strategy.description}
                                </p>
                                <div className="mt-3 grid gap-1 text-[11px] text-gray-500">
                                  <div>
                                    Win rate{" "}
                                    {strategy.historicalPerformance.winRate}%
                                  </div>
                                  <div>
                                    Average return{" "}
                                    {
                                      strategy.historicalPerformance
                                        .averageReturn
                                    }
                                    %
                                  </div>
                                  <div>
                                    Max drawdown{" "}
                                    {strategy.historicalPerformance.maxDrawdown}
                                    %
                                  </div>
                                </div>
                              </button>
                            );
                          },
                        )}
                      </div>
                    </div>

                    {/* Per-strategy settings */}
                    {config.strategyKeys.length > 0 ? (
                      <div className="mt-5 space-y-4">
                        {config.strategyKeys.map((strategyKey) => {
                          const settings =
                            config.strategySettings[strategyKey] ??
                            defaultStrategySettings();
                          return (
                            <div
                              key={strategyKey}
                              className="rounded-3xl border border-gray-800 bg-gray-950/40 p-4"
                            >
                              <div className="flex items-center gap-2">
                                <StatusBadge tone="neutral">
                                  STRATEGY
                                </StatusBadge>
                                <p className="text-sm font-medium text-gray-200">
                                  {strategyKey}
                                </p>
                              </div>
                              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                <label className="space-y-1.5">
                                  <span className="flex items-center gap-2 text-xs text-gray-500">
                                    Priority
                                    <InfoTip text="Higher-priority strategies can reserve room when capital is tight in AGGRESSIVE mode." />
                                  </span>
                                  <select
                                    disabled={isBotActiveHere}
                                    value={settings.priority}
                                    onChange={(event) =>
                                      updateMarket(market.id, (current) => ({
                                        ...current,
                                        strategySettings: {
                                          ...current.strategySettings,
                                          [strategyKey]: {
                                            ...settings,
                                            priority: event.target.value as
                                              | "HIGH"
                                              | "MEDIUM"
                                              | "LOW",
                                          },
                                        },
                                      }))
                                    }
                                    className="w-full rounded-xl border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-gray-100"
                                  >
                                    <option value="HIGH">HIGH</option>
                                    <option value="MEDIUM">MEDIUM</option>
                                    <option value="LOW">LOW</option>
                                  </select>
                                </label>
                                <NumberField
                                  label="Cooldown after trade"
                                  tip="Minimum wait time before this strategy can re-enter."
                                  value={settings.cooldownAfterTradeSec}
                                  min={0}
                                  max={86400}
                                  suffix="s"
                                  disabled={isBotActiveHere}
                                  onChange={(value) =>
                                    updateMarket(market.id, (current) => ({
                                      ...current,
                                      strategySettings: {
                                        ...current.strategySettings,
                                        [strategyKey]: {
                                          ...settings,
                                          cooldownAfterTradeSec: value,
                                        },
                                      },
                                    }))
                                  }
                                />
                                <NumberField
                                  label="Per trade %"
                                  tip="Soft capital per entry. Effective order size is min(per-trade %, global max position size, available capital)."
                                  value={
                                    settings.capitalAllocation.perTradePercent
                                  }
                                  min={0.1}
                                  max={100}
                                  step={0.1}
                                  suffix="%"
                                  disabled={isBotActiveHere || !isAggressive}
                                  onChange={(value) =>
                                    updateMarket(market.id, (current) => ({
                                      ...current,
                                      strategySettings: {
                                        ...current.strategySettings,
                                        [strategyKey]: {
                                          ...settings,
                                          capitalAllocation: {
                                            ...settings.capitalAllocation,
                                            perTradePercent: value,
                                          },
                                        },
                                      },
                                    }))
                                  }
                                />
                                <NumberField
                                  label="Max active %"
                                  tip="Upper exposure cap for this strategy while AGGRESSIVE mode is active."
                                  value={
                                    settings.capitalAllocation.maxActivePercent
                                  }
                                  min={0.1}
                                  max={100}
                                  step={0.1}
                                  suffix="%"
                                  disabled={isBotActiveHere || !isAggressive}
                                  onChange={(value) =>
                                    updateMarket(market.id, (current) => ({
                                      ...current,
                                      strategySettings: {
                                        ...current.strategySettings,
                                        [strategyKey]: {
                                          ...settings,
                                          capitalAllocation: {
                                            ...settings.capitalAllocation,
                                            maxActivePercent: value,
                                          },
                                        },
                                      },
                                    }))
                                  }
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    {/* Save bar */}
                    <div className="sticky-actions mt-5">
                      <div className="text-xs text-gray-500">
                        Selected:{" "}
                        {config.strategyKeys.length
                          ? config.strategyKeys.join(", ")
                          : "None"}
                      </div>
                      <Button
                        onClick={() => handleSave(market.id, config)}
                        disabled={
                          isBotActiveHere ||
                          saveMutation.isPending ||
                          config.strategyKeys.length === 0
                        }
                      >
                        {savingMarket === market.id ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Saving…
                          </>
                        ) : (
                          "Save market settings"
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
