import {
  pgTable, text, timestamp, boolean, integer,
  decimal, jsonb, uuid, varchar, index, pgEnum,
  date, primaryKey, doublePrecision
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

// ─── Enums ────────────────────────────────────────────────────────────────────
export const marketTypeEnum       = pgEnum('market_type', ['indian', 'crypto', 'commodities', 'global'])
export const tradeSideEnum        = pgEnum('trade_side', ['buy', 'sell'])
export const tradeStatusEnum      = pgEnum('trade_status', ['pending', 'open', 'closed', 'cancelled', 'failed'])
export const botStatusEnum        = pgEnum('bot_status_enum', ['running', 'stopped', 'paused', 'error', 'stopping'])
export const signalEnum           = pgEnum('signal_type', ['buy', 'sell', 'hold'])
export const tradingModeEnum      = pgEnum('trading_mode', ['paper', 'live'])
export const botSessionStatusEnum = pgEnum('bot_session_status', ['running', 'stopped', 'error'])
export const closeLogStatusEnum   = pgEnum('close_log_status', ['pending', 'filled', 'partial', 'failed'])
export const strategyRiskLevelEnum = pgEnum('strategy_risk_level', ['LOW', 'MEDIUM', 'HIGH'])
export const strategyMarketEnum    = pgEnum('strategy_market_enum', ['CRYPTO', 'STOCKS', 'FOREX'])
export const strategyExecutionModeEnum = pgEnum('strategy_execution_mode', ['SAFE', 'AGGRESSIVE'])
export const strategyConfigSlotEnum = pgEnum('strategy_config_slot', ['PRIMARY', 'SECONDARY'])
export const backtestStatusEnum    = pgEnum('backtest_status', ['queued', 'completed', 'failed'])
export const positionModeEnum      = pgEnum('position_mode', ['NET', 'HEDGE'])
export const positionDirectionEnum = pgEnum('position_direction', ['LONG', 'SHORT'])
export const positionLifecycleEnum = pgEnum('position_lifecycle', ['open', 'closed'])

// ─── Users ────────────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id:            uuid('id').defaultRandom().primaryKey(),
  email:         varchar('email', { length: 255 }).notNull().unique(),
  name:          varchar('name', { length: 255 }),
  googleId:      varchar('google_id', { length: 255 }).unique(),
  avatarUrl:     text('avatar_url'),
  isActive:      boolean('is_active').default(true).notNull(),
  isWhitelisted: boolean('is_whitelisted').default(false).notNull(),
  createdAt:     timestamp('created_at').defaultNow().notNull(),
  lastLoginAt:   timestamp('last_login_at'),
}, (t) => ({
  emailIdx: index('users_email_idx').on(t.email),
}))

// ─── Access Codes ─────────────────────────────────────────────────────────────
export const accessCodes = pgTable('access_codes', {
  id:          uuid('id').defaultRandom().primaryKey(),
  code:        varchar('code', { length: 64 }).notNull().unique(),
  codeSha256:  varchar('code_sha256', { length: 64 }),
  label:       varchar('label', { length: 100 }),
  createdBy:   varchar('created_by', { length: 255 }).notNull(),
  expiresAt:   timestamp('expires_at').notNull(),
  isBurned:    boolean('is_burned').default(false).notNull(),
  burnedAt:    timestamp('burned_at'),
  burnedByIp:  varchar('burned_by_ip', { length: 64 }),
  usedByEmail: varchar('used_by_email', { length: 255 }),
  createdAt:   timestamp('created_at').defaultNow().notNull(),
})

// ─── Sessions ─────────────────────────────────────────────────────────────────
export const sessions = pgTable('sessions', {
  id:                uuid('id').defaultRandom().primaryKey(),
  userId:            uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tokenHash:         varchar('token_hash', { length: 255 }).notNull(),
  deviceFingerprint: text('device_fingerprint'),
  ipAddress:         varchar('ip_address', { length: 64 }),
  userAgent:         text('user_agent'),
  isActive:          boolean('is_active').default(true).notNull(),
  createdAt:         timestamp('created_at').defaultNow().notNull(),
  lastSeenAt:        timestamp('last_seen_at').defaultNow().notNull(),
  revokedAt:         timestamp('revoked_at'),
}, (t) => ({
  userIdx: index('sessions_user_idx').on(t.userId),
}))

// ─── Market Configs ───────────────────────────────────────────────────────────
export const marketConfigs = pgTable('market_configs', {
  id:         uuid('id').defaultRandom().primaryKey(),
  userId:     uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType: marketTypeEnum('market_type').notNull(),
  isActive:   boolean('is_active').default(true).notNull(),
  algoName:   varchar('algo_name', { length: 100 }),
  paperMode:  boolean('paper_mode').default(true).notNull(),
  mode:       tradingModeEnum('mode').default('paper').notNull(),
  createdAt:  timestamp('created_at').defaultNow().notNull(),
  updatedAt:  timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userMarketIdx: index('market_configs_user_market_idx').on(t.userId, t.marketType),
}))

// ─── Strategy Catalog ────────────────────────────────────────────────────────
export const strategies = pgTable('strategies', {
  id:                uuid('id').defaultRandom().primaryKey(),
  strategyKey:       varchar('strategy_key', { length: 100 }).notNull().unique(),
  name:              varchar('name', { length: 120 }).notNull().unique(),
  description:       text('description').notNull(),
  riskLevel:         strategyRiskLevelEnum('risk_level').notNull(),
  supportedMarkets:  jsonb('supported_markets').$type<Array<'CRYPTO' | 'STOCKS' | 'FOREX'>>().notNull(),
  supportedTimeframes: jsonb('supported_timeframes').$type<string[]>().notNull(),
  historicalWinRate: decimal('historical_win_rate', { precision: 6, scale: 2 }).notNull(),
  historicalAvgReturn: decimal('historical_avg_return', { precision: 10, scale: 4 }).notNull(),
  historicalMaxDrawdown: decimal('historical_max_drawdown', { precision: 10, scale: 4 }).notNull(),
  historicalSharpeRatio: decimal('historical_sharpe_ratio', { precision: 10, scale: 4 }).notNull(),
  isActive:          boolean('is_active').default(true).notNull(),
  createdAt:         timestamp('created_at').defaultNow().notNull(),
  updatedAt:         timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  keyIdx: index('strategies_key_idx').on(t.strategyKey),
  activeIdx: index('strategies_active_idx').on(t.isActive),
}))

export const marketStrategyConfigs = pgTable('market_strategy_configs', {
  id:            uuid('id').defaultRandom().primaryKey(),
  userId:        uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType:    marketTypeEnum('market_type').notNull(),
  executionMode: strategyExecutionModeEnum('execution_mode').default('SAFE').notNull(),
  positionMode:  positionModeEnum('position_mode').default('NET').notNull(),
  allowHedgeOpposition: boolean('allow_hedge_opposition').default(false).notNull(),
  conflictBlocking: boolean('conflict_blocking').default(false).notNull(),
  aggressiveConfirmedAt: timestamp('aggressive_confirmed_at'),
  maxPositionsPerSymbol: integer('max_positions_per_symbol').default(2).notNull(),
  maxCapitalPerStrategyPct: decimal('max_capital_per_strategy_pct', { precision: 6, scale: 2 }).default('25.00').notNull(),
  maxDrawdownPct: decimal('max_drawdown_pct', { precision: 6, scale: 2 }).default('12.00').notNull(),
  conflictWarnings: jsonb('conflict_warnings').$type<Array<{ code: string; severity: 'info' | 'warning' | 'blocking'; message: string }>>().default([]).notNull(),
  exchangeCapabilities: jsonb('exchange_capabilities').$type<{ supportsHedgeMode: boolean; effectivePositionMode?: 'NET' | 'HEDGE'; warning?: string } | null>(),
  createdAt:     timestamp('created_at').defaultNow().notNull(),
  updatedAt:     timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userMarketIdx: index('market_strategy_configs_user_market_idx').on(t.userId, t.marketType),
}))

export const marketStrategySelections = pgTable('market_strategy_selections', {
  id:         uuid('id').defaultRandom().primaryKey(),
  configId:   uuid('config_id').references(() => marketStrategyConfigs.id, { onDelete: 'cascade' }).notNull(),
  strategyId: uuid('strategy_id').references(() => strategies.id, { onDelete: 'cascade' }).notNull(),
  slot:       strategyConfigSlotEnum('slot').notNull(),
  createdAt:  timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  configSlotIdx: index('market_strategy_selections_config_slot_idx').on(t.configId, t.slot),
  strategyIdx: index('market_strategy_selections_strategy_idx').on(t.strategyId),
}))

export const backtestRuns = pgTable('backtest_runs', {
  id:                 uuid('id').defaultRandom().primaryKey(),
  userId:             uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType:         marketTypeEnum('market_type').notNull(),
  asset:              varchar('asset', { length: 100 }).notNull(),
  timeframe:          varchar('timeframe', { length: 20 }).notNull(),
  dateFrom:           timestamp('date_from').notNull(),
  dateTo:             timestamp('date_to').notNull(),
  initialCapital:     decimal('initial_capital', { precision: 20, scale: 2 }).notNull(),
  strategyKeys:       jsonb('strategy_keys').$type<string[]>().notNull(),
  executionMode:      strategyExecutionModeEnum('execution_mode').notNull(),
  positionMode:       positionModeEnum('position_mode').default('NET').notNull(),
  allowHedgeOpposition: boolean('allow_hedge_opposition').default(false).notNull(),
  strategyConfigId:   uuid('strategy_config_id'),
  status:             backtestStatusEnum('status').default('queued').notNull(),
  performanceMetrics: jsonb('performance_metrics'),
  equityCurve:        jsonb('equity_curve'),
  tradeSummary:       jsonb('trade_summary'),
  strategyBreakdown:  jsonb('strategy_breakdown'),
  comparisonLabel:    varchar('comparison_label', { length: 150 }),
  errorMessage:       text('error_message'),
  createdAt:          timestamp('created_at').defaultNow().notNull(),
  completedAt:        timestamp('completed_at'),
}, (t) => ({
  userCreatedIdx: index('backtest_runs_user_created_idx').on(t.userId, t.createdAt),
  statusIdx: index('backtest_runs_status_idx').on(t.status),
}))

export const strategyConfigs = pgTable('strategy_configs', {
  id:                 uuid('id').defaultRandom().primaryKey(),
  userId:             uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType:         marketTypeEnum('market_type').notNull(),
  executionMode:      strategyExecutionModeEnum('execution_mode').notNull(),
  positionMode:       positionModeEnum('position_mode').default('NET').notNull(),
  allowHedgeOpposition: boolean('allow_hedge_opposition').default(false).notNull(),
  strategyKeys:       jsonb('strategy_keys').$type<string[]>().notNull(),
  asset:              varchar('asset', { length: 100 }),
  timeframe:          varchar('timeframe', { length: 20 }),
  initialCapital:     decimal('initial_capital', { precision: 20, scale: 2 }),
  conflictWarnings:   jsonb('conflict_warnings').$type<Array<{ code: string; severity: 'info' | 'warning' | 'blocking'; message: string }>>().default([]).notNull(),
  exchangeCapabilities: jsonb('exchange_capabilities').$type<{ supportsHedgeMode: boolean; effectivePositionMode?: 'NET' | 'HEDGE'; warning?: string } | null>(),
  source:             varchar('source', { length: 30 }).default('manual').notNull(),
  createdAt:          timestamp('created_at').defaultNow().notNull(),
  updatedAt:          timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userMarketIdx: index('strategy_configs_user_market_idx').on(t.userId, t.marketType, t.createdAt),
}))

export const strategyPositions = pgTable('strategy_positions', {
  id:                  uuid('id').defaultRandom().primaryKey(),
  userId:              uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType:          marketTypeEnum('market_type').notNull(),
  symbol:              varchar('symbol', { length: 50 }).notNull(),
  strategyId:          uuid('strategy_id').references(() => strategies.id, { onDelete: 'set null' }),
  strategyKey:         varchar('strategy_key', { length: 100 }).notNull(),
  executionMode:       strategyExecutionModeEnum('execution_mode').notNull(),
  positionMode:        positionModeEnum('position_mode').default('NET').notNull(),
  direction:           positionDirectionEnum('direction').notNull(),
  lifecycle:           positionLifecycleEnum('lifecycle').default('open').notNull(),
  size:                decimal('size', { precision: 20, scale: 8 }).notNull(),
  remainingSize:       decimal('remaining_size', { precision: 20, scale: 8 }).notNull(),
  entryPrice:          decimal('entry_price', { precision: 20, scale: 8 }).notNull(),
  exitPrice:           decimal('exit_price', { precision: 20, scale: 8 }),
  realizedPnl:         decimal('realized_pnl', { precision: 20, scale: 8 }).default('0').notNull(),
  unrealizedPnl:       decimal('unrealized_pnl', { precision: 20, scale: 8 }).default('0').notNull(),
  maxAdverseExcursion: decimal('max_adverse_excursion', { precision: 20, scale: 8 }).default('0').notNull(),
  metadata:            jsonb('metadata'),
  openedAt:            timestamp('opened_at').defaultNow().notNull(),
  closedAt:            timestamp('closed_at'),
}, (t) => ({
  userSymbolIdx: index('strategy_positions_user_symbol_idx').on(t.userId, t.marketType, t.symbol, t.lifecycle),
  strategyIdx: index('strategy_positions_strategy_idx').on(t.userId, t.marketType, t.strategyKey, t.lifecycle),
}))

export const strategyPerformance = pgTable('strategy_performance', {
  id:                 uuid('id').defaultRandom().primaryKey(),
  userId:             uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType:         marketTypeEnum('market_type').notNull(),
  strategyId:         uuid('strategy_id').references(() => strategies.id, { onDelete: 'set null' }),
  strategyKey:        varchar('strategy_key', { length: 100 }).notNull(),
  totalTrades:        integer('total_trades').default(0).notNull(),
  winningTrades:      integer('winning_trades').default(0).notNull(),
  losingTrades:       integer('losing_trades').default(0).notNull(),
  openPositions:      integer('open_positions').default(0).notNull(),
  realizedPnl:        decimal('realized_pnl', { precision: 20, scale: 8 }).default('0').notNull(),
  unrealizedPnl:      decimal('unrealized_pnl', { precision: 20, scale: 8 }).default('0').notNull(),
  maxDrawdownPct:     decimal('max_drawdown_pct', { precision: 8, scale: 4 }).default('0').notNull(),
  lastBacktestReturnPct: decimal('last_backtest_return_pct', { precision: 10, scale: 4 }),
  lastTradeAt:        timestamp('last_trade_at'),
  updatedAt:          timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userStrategyIdx: index('strategy_performance_user_market_strategy_idx').on(t.userId, t.marketType, t.strategyKey),
}))

export const backtestResults = pgTable('backtest_results', {
  id:                 uuid('id').defaultRandom().primaryKey(),
  runId:              uuid('run_id').references(() => backtestRuns.id, { onDelete: 'cascade' }).notNull(),
  userId:             uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType:         marketTypeEnum('market_type').notNull(),
  strategyKeys:       jsonb('strategy_keys').$type<string[]>().notNull(),
  executionMode:      strategyExecutionModeEnum('execution_mode').notNull(),
  positionMode:       positionModeEnum('position_mode').default('NET').notNull(),
  strategyBreakdown:  jsonb('strategy_breakdown'),
  performanceMetrics: jsonb('performance_metrics').notNull(),
  equityCurve:        jsonb('equity_curve').notNull(),
  tradeSummary:       jsonb('trade_summary').notNull(),
  createdAt:          timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  runIdx: index('backtest_results_run_idx').on(t.runId),
  userIdx: index('backtest_results_user_idx').on(t.userId, t.createdAt),
}))

// ─── Exchange APIs ─────────────────────────────────────────────────────────────
export const exchangeApis = pgTable('exchange_apis', {
  id:            uuid('id').defaultRandom().primaryKey(),
  userId:        uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType:    marketTypeEnum('market_type').notNull(),
  exchangeName:  varchar('exchange_name', { length: 100 }).notNull(),
  exchangeLabel: varchar('exchange_label', { length: 100 }),
  apiKeyEnc:     text('api_key_enc').notNull(),
  apiSecretEnc:  text('api_secret_enc').notNull(),
  extraFieldsEnc:text('extra_fields_enc'),
  isVerified:    boolean('is_verified').default(false).notNull(),
  isActive:      boolean('is_active').default(true).notNull(),
  lastVerifiedAt:timestamp('last_verified_at'),
  createdAt:     timestamp('created_at').defaultNow().notNull(),
  updatedAt:     timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  userExchangeIdx: index('exchange_apis_user_idx').on(t.userId, t.marketType),
}))

// ─── Bot Status ───────────────────────────────────────────────────────────────
export const botStatuses = pgTable('bot_statuses', {
  id:                   uuid('id').defaultRandom().primaryKey(),
  userId:               uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
  status:               botStatusEnum('status').default('stopped').notNull(),
  activeMarkets:        jsonb('active_markets').$type<string[]>().default([]),
  startedAt:            timestamp('started_at'),
  stoppedAt:            timestamp('stopped_at'),
  lastHeartbeat:        timestamp('last_heartbeat'),
  lastSignal:           text('last_signal'),
  errorMessage:         text('error_message'),
  updatedAt:            timestamp('updated_at').defaultNow().notNull(),
  stopMode:             varchar('stop_mode', { length: 20 }),
  stoppingAt:           timestamp('stopping_at'),
  stopTimeoutSec:       integer('stop_timeout_sec').default(300),
  watchdogRestartCount: integer('watchdog_restart_count').default(0).notNull(),
})

// ─── Bot Sessions ─────────────────────────────────────────────────────────────
export const botSessions = pgTable('bot_sessions', {
  id:           uuid('id').defaultRandom().primaryKey(),
  userId:       uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  exchange:     varchar('exchange', { length: 100 }).notNull().default('unknown'),
  market:       varchar('market', { length: 50 }).notNull(),
  mode:         tradingModeEnum('mode').default('paper').notNull(),
  status:       botSessionStatusEnum('status').default('running').notNull(),
  startedAt:    timestamp('started_at').defaultNow().notNull(),
  endedAt:      timestamp('ended_at'),
  totalTrades:  integer('total_trades').default(0).notNull(),
  openTrades:   integer('open_trades').default(0).notNull(),
  closedTrades: integer('closed_trades').default(0).notNull(),
  totalPnl:     decimal('total_pnl', { precision: 20, scale: 8 }).default('0'),
  errorMessage: text('error_message'),
  metadata:     jsonb('metadata'),
}, (t) => ({
  userIdx:    index('bot_sessions_user_idx').on(t.userId),
  startedIdx: index('bot_sessions_started_idx').on(t.startedAt),
  statusIdx:  index('bot_sessions_status_idx').on(t.status),
}))

// ─── Risk Settings ────────────────────────────────────────────────────────────
export const riskSettings = pgTable('risk_settings', {
  id:               uuid('id').defaultRandom().primaryKey(),
  userId:           uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
  maxPositionPct:   decimal('max_position_pct', { precision: 5, scale: 2 }).default('2.00').notNull(),
  stopLossPct:      decimal('stop_loss_pct',    { precision: 5, scale: 2 }).default('1.50').notNull(),
  takeProfitPct:    decimal('take_profit_pct',  { precision: 5, scale: 2 }).default('3.00').notNull(),
  maxDailyLossPct:  decimal('max_daily_loss_pct',{ precision: 5, scale: 2 }).default('5.00').notNull(),
  maxOpenTrades:    integer('max_open_trades').default(3).notNull(),
  cooldownSeconds:  integer('cooldown_seconds').default(300).notNull(),
  trailingStop:     boolean('trailing_stop').default(false).notNull(),
  paperBalance:     decimal('paper_balance', { precision: 20, scale: 2 }).default('10000.00').notNull(),
  updatedAt:        timestamp('updated_at').defaultNow().notNull(),
})

// ─── Trades ───────────────────────────────────────────────────────────────────
export const trades = pgTable('trades', {
  id:              uuid('id').defaultRandom().primaryKey(),
  userId:          uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  sessionId:       uuid('session_id').references(() => botSessions.id, { onDelete: 'set null' }),
  exchangeName:    varchar('exchange_name', { length: 100 }).notNull(),
  marketType:      marketTypeEnum('market_type').notNull(),
  symbol:          varchar('symbol', { length: 50 }).notNull(),
  side:            tradeSideEnum('side').notNull(),
  quantity:        decimal('quantity',   { precision: 20, scale: 8 }).notNull(),
  entryPrice:      decimal('entry_price',{ precision: 20, scale: 8 }).notNull(),
  exitPrice:       decimal('exit_price', { precision: 20, scale: 8 }),
  stopLoss:        decimal('stop_loss',  { precision: 20, scale: 8 }),
  takeProfit:      decimal('take_profit',{ precision: 20, scale: 8 }),
  pnl:             decimal('pnl',        { precision: 20, scale: 8 }),
  pnlPct:          decimal('pnl_pct',    { precision: 8,  scale: 4 }),
  feeRate:         decimal('fee_rate',   { precision: 8,  scale: 6 }).default('0.001'),
  feeAmount:       decimal('fee_amount', { precision: 20, scale: 8 }),
  netPnl:          decimal('net_pnl',    { precision: 20, scale: 8 }),
  filledQuantity:  decimal('filled_quantity', { precision: 20, scale: 8 }).default('0'),
  remainingQuantity: decimal('remaining_quantity', { precision: 20, scale: 8 }),
  status:          tradeStatusEnum('status').default('pending').notNull(),
  algoUsed:        varchar('algo_used', { length: 100 }),
  strategyKey:     varchar('strategy_key', { length: 100 }),
  positionScopeKey: varchar('position_scope_key', { length: 160 }).default('default').notNull(),
  signalId:        uuid('signal_id'),
  isPaper:         boolean('is_paper').default(true).notNull(),
  exchangeOrderId: varchar('exchange_order_id', { length: 255 }),
  openedAt:        timestamp('opened_at').defaultNow().notNull(),
  closedAt:        timestamp('closed_at'),
  metadata:        jsonb('metadata'),
  botSessionRef:   varchar('bot_session_ref', { length: 100 }),
  closeAttempts:   integer('close_attempts').default(0),
  closeError:      text('close_error'),
}, (t) => ({
  userIdx:      index('trades_user_idx').on(t.userId),
  symbolIdx:    index('trades_symbol_idx').on(t.symbol),
  statusIdx:    index('trades_status_idx').on(t.status),
  openedIdx:    index('trades_opened_idx').on(t.openedAt),
  sessionIdx:   index('trades_session_idx').on(t.sessionId),
  userOpenIdx:  index('idx_trades_user_open').on(t.userId, t.status),
  strategyIdx:  index('trades_strategy_idx').on(t.strategyKey),
  scopeIdx:     index('trades_scope_idx').on(t.userId, t.marketType, t.symbol, t.positionScopeKey),
  // NOTE: The active-scope unique partial index is created via raw SQL migration.
  // It allows one open trade per user/market/symbol/position_scope_key while
  // still supporting multiple aggressive live positions on the same symbol.
}))

// ─── Position Close Log ───────────────────────────────────────────────────────
export const positionCloseLog = pgTable('position_close_log', {
  id:              uuid('id').defaultRandom().primaryKey(),
  userId:          uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  tradeId:         uuid('trade_id').references(() => trades.id, { onDelete: 'cascade' }).notNull(),
  attempt:         integer('attempt').default(1).notNull(),
  status:          closeLogStatusEnum('status').notNull(),
  quantityReq:     decimal('quantity_req',  { precision: 20, scale: 8 }),
  quantityFill:    decimal('quantity_fill', { precision: 20, scale: 8 }),
  exchangeOrderId: varchar('exchange_order_id', { length: 255 }),
  errorMessage:    text('error_message'),
  attemptedAt:     timestamp('attempted_at').defaultNow().notNull(),
  filledAt:        timestamp('filled_at'),
}, (t) => ({
  tradeIdx: index('idx_close_log_trade').on(t.tradeId),
  userIdx:  index('idx_close_log_user').on(t.userId, t.attemptedAt),
}))

export const failedLiveOrders = pgTable('failed_live_orders', {
  id:              uuid('id').defaultRandom().primaryKey(),
  userId:          uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  exchangeName:    varchar('exchange_name', { length: 100 }).notNull(),
  marketType:      marketTypeEnum('market_type').notNull(),
  symbol:          varchar('symbol', { length: 50 }).notNull(),
  side:            tradeSideEnum('side').notNull(),
  quantity:        decimal('quantity',   { precision: 20, scale: 8 }).notNull(),
  entryPrice:      decimal('entry_price',{ precision: 20, scale: 8 }).notNull(),
  exchangeOrderId: varchar('exchange_order_id', { length: 255 }),
  failReason:      text('fail_reason').notNull(),
  cancelAttempted: boolean('cancel_attempted').default(false).notNull(),
  cancelSucceeded: boolean('cancel_succeeded').default(false).notNull(),
  cancelError:     text('cancel_error'),
  requiresManualReview: boolean('requires_manual_review').default(true).notNull(),
  resolvedAt:      timestamp('resolved_at'),
  createdAt:       timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  userIdx:   index('failed_orders_user_idx').on(t.userId),
  reviewIdx: index('failed_orders_review_idx').on(t.requiresManualReview, t.createdAt),
}))

// ─── Algo Signals ─────────────────────────────────────────────────────────────
export const algoSignals = pgTable('algo_signals', {
  id:                 uuid('id').defaultRandom().primaryKey(),
  userId:             uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType:         marketTypeEnum('market_type').notNull(),
  symbol:             varchar('symbol', { length: 50 }).notNull(),
  signal:             signalEnum('signal').notNull(),
  confidence:         decimal('confidence', { precision: 5, scale: 2 }),
  algoName:           varchar('algo_name', { length: 100 }),
  timeframe:          varchar('timeframe', { length: 20 }),
  indicatorsSnapshot: jsonb('indicators_snapshot'),
  wasExecuted:        boolean('was_executed').default(false).notNull(),
  createdAt:          timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  userIdx:    index('signals_user_idx').on(t.userId),
  createdIdx: index('signals_created_idx').on(t.createdAt),
}))

// ─── Mode Audit Logs ──────────────────────────────────────────────────────────
export const modeAuditLogs = pgTable('mode_audit_logs', {
  id:        uuid('id').defaultRandom().primaryKey(),
  userId:    uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  scope:     varchar('scope', { length: 50 }).notNull(),
  fromMode:  tradingModeEnum('from_mode').notNull(),
  toMode:    tradingModeEnum('to_mode').notNull(),
  ipAddress: varchar('ip_address', { length: 64 }),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  userIdx:    index('audit_user_idx').on(t.userId),
  createdIdx: index('audit_created_idx').on(t.createdAt),
}))

// ─── Risk State ───────────────────────────────────────────────────────────────
// F10: Added last_loss_time (double precision = UTC epoch seconds float).
// Persists risk_manager.last_loss_time across bot restarts so cooldowns
// are correctly enforced even after a crash or Render restart.
export const riskState = pgTable('risk_state', {
  userId:         uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType:     varchar('market_type', { length: 50 }).notNull(),
  dailyLoss:      decimal('daily_loss', { precision: 20, scale: 8 }).notNull().default('0'),
  openTradeCount: integer('open_trade_count').notNull().default(0),
  dayDate:        date('day_date').notNull().defaultNow(),
  updatedAt:      timestamp('updated_at').notNull().defaultNow(),
  // F10: new column — persists last_loss_time for cooldown enforcement on restart
  lastLossTime:   doublePrecision('last_loss_time'),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.marketType, t.dayDate] }),
}))

// ─── Reconciliation Log ───────────────────────────────────────────────────────
export const reconciliationLog = pgTable('reconciliation_log', {
  userId:      uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  marketType:  varchar('market_type', { length: 50 }).notNull(),
  lastRunAt:   timestamp('last_run_at').notNull().defaultNow(),
  tradesFixed: integer('trades_fixed').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.marketType] }),
}))

// ─── Relations ────────────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ many, one }) => ({
  sessions:           many(sessions),
  marketConfigs:      many(marketConfigs),
  marketStrategyConfigs: many(marketStrategyConfigs),
  exchangeApis:       many(exchangeApis),
  trades:             many(trades),
  algoSignals:        many(algoSignals),
  backtestRuns:       many(backtestRuns),
  strategyConfigs:    many(strategyConfigs),
  strategyPositions:  many(strategyPositions),
  strategyPerformances: many(strategyPerformance),
  backtestResults:    many(backtestResults),
  modeAuditLogs:      many(modeAuditLogs),
  botSessions:        many(botSessions),
  positionCloseLogs:  many(positionCloseLog),
  failedLiveOrders:   many(failedLiveOrders),
  riskStates:         many(riskState),
  reconciliationLogs: many(reconciliationLog),
  botStatus:          one(botStatuses,  { fields: [users.id], references: [botStatuses.userId] }),
  riskSettings:       one(riskSettings, { fields: [users.id], references: [riskSettings.userId] }),
}))

export const botSessionsRelations = relations(botSessions, ({ one, many }) => ({
  user:   one(users, { fields: [botSessions.userId], references: [users.id] }),
  trades: many(trades),
}))

export const marketStrategyConfigsRelations = relations(marketStrategyConfigs, ({ one, many }) => ({
  user: one(users, { fields: [marketStrategyConfigs.userId], references: [users.id] }),
  selections: many(marketStrategySelections),
}))

export const marketStrategySelectionsRelations = relations(marketStrategySelections, ({ one }) => ({
  config: one(marketStrategyConfigs, { fields: [marketStrategySelections.configId], references: [marketStrategyConfigs.id] }),
  strategy: one(strategies, { fields: [marketStrategySelections.strategyId], references: [strategies.id] }),
}))

export const backtestRunsRelations = relations(backtestRuns, ({ one }) => ({
  user: one(users, { fields: [backtestRuns.userId], references: [users.id] }),
}))

export const tradesRelations = relations(trades, ({ one, many }) => ({
  user:      one(users,       { fields: [trades.userId],    references: [users.id] }),
  session:   one(botSessions, { fields: [trades.sessionId], references: [botSessions.id] }),
  closeLogs: many(positionCloseLog),
}))

export const positionCloseLogRelations = relations(positionCloseLog, ({ one }) => ({
  user:  one(users,  { fields: [positionCloseLog.userId],  references: [users.id] }),
  trade: one(trades, { fields: [positionCloseLog.tradeId], references: [trades.id] }),
}))

// ─── Types ────────────────────────────────────────────────────────────────────
export type User              = typeof users.$inferSelect
export type NewUser           = typeof users.$inferInsert
export type AccessCode        = typeof accessCodes.$inferSelect
export type Session           = typeof sessions.$inferSelect
export type MarketConfig      = typeof marketConfigs.$inferSelect
export type Strategy         = typeof strategies.$inferSelect
export type MarketStrategyConfig = typeof marketStrategyConfigs.$inferSelect
export type MarketStrategySelection = typeof marketStrategySelections.$inferSelect
export type ExchangeApi       = typeof exchangeApis.$inferSelect
export type Trade             = typeof trades.$inferSelect
export type NewTrade          = typeof trades.$inferInsert
export type AlgoSignal        = typeof algoSignals.$inferSelect
export type BotStatus         = typeof botStatuses.$inferSelect
export type RiskSettings      = typeof riskSettings.$inferSelect
export type ModeAuditLog      = typeof modeAuditLogs.$inferSelect
export type TradingMode       = 'paper' | 'live'
export type BotSession        = typeof botSessions.$inferSelect
export type NewBotSession     = typeof botSessions.$inferInsert
export type PositionCloseLog  = typeof positionCloseLog.$inferSelect
export type FailedLiveOrder   = typeof failedLiveOrders.$inferSelect
export type RiskState         = typeof riskState.$inferSelect
export type ReconciliationLog = typeof reconciliationLog.$inferSelect
export type StopMode          = 'close_all' | 'graceful'
export type BacktestRun       = typeof backtestRuns.$inferSelect
export type StrategyConfigSnapshot = typeof strategyConfigs.$inferSelect
export type StrategyPosition = typeof strategyPositions.$inferSelect
export type StrategyPerformanceRow = typeof strategyPerformance.$inferSelect
export type BacktestResult = typeof backtestResults.$inferSelect
