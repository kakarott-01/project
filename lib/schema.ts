import {
  pgTable, text, timestamp, boolean, integer,
  decimal, jsonb, uuid, varchar, index, pgEnum
} from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

// ─── Enums ────────────────────────────────────────────────────────────────────
export const marketTypeEnum = pgEnum('market_type', [
  'indian', 'crypto', 'commodities', 'global'
])
export const tradeSideEnum    = pgEnum('trade_side', ['buy', 'sell'])
export const tradeStatusEnum  = pgEnum('trade_status', ['pending', 'open', 'closed', 'cancelled', 'failed'])
export const botStatusEnum    = pgEnum('bot_status_enum', ['running', 'stopped', 'paused', 'error', 'stopping'])
export const signalEnum       = pgEnum('signal_type', ['buy', 'sell', 'hold'])
export const tradingModeEnum  = pgEnum('trading_mode', ['paper', 'live'])
export const botSessionStatusEnum = pgEnum('bot_session_status', ['running', 'stopped', 'error'])
export const closeLogStatusEnum   = pgEnum('close_log_status', ['pending', 'filled', 'partial', 'failed'])

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
  id:             uuid('id').defaultRandom().primaryKey(),
  userId:         uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull().unique(),
  status:         botStatusEnum('status').default('stopped').notNull(),
  activeMarkets:  jsonb('active_markets').$type<string[]>().default([]),
  startedAt:      timestamp('started_at'),
  stoppedAt:      timestamp('stopped_at'),
  lastHeartbeat:  timestamp('last_heartbeat'),
  lastSignal:     text('last_signal'),
  errorMessage:   text('error_message'),
  updatedAt:      timestamp('updated_at').defaultNow().notNull(),
  // ── Stop behavior ──
  stopMode:       varchar('stop_mode', { length: 20 }),    // 'close_all' | 'graceful' | null
  stoppingAt:     timestamp('stopping_at'),                // when stop was initiated
  stopTimeoutSec: integer('stop_timeout_sec').default(300),// alert after N seconds
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
  status:          tradeStatusEnum('status').default('pending').notNull(),
  algoUsed:        varchar('algo_used', { length: 100 }),
  signalId:        uuid('signal_id'),
  isPaper:         boolean('is_paper').default(true).notNull(),
  exchangeOrderId: varchar('exchange_order_id', { length: 255 }),
  openedAt:        timestamp('opened_at').defaultNow().notNull(),
  closedAt:        timestamp('closed_at'),
  metadata:        jsonb('metadata'),
  // ── New: ownership & close tracking ──
  botSessionRef:   varchar('bot_session_ref', { length: 100 }), // "{userId}:{sessionId}"
  closeAttempts:   integer('close_attempts').default(0),
  closeError:      text('close_error'),
}, (t) => ({
  userIdx:      index('trades_user_idx').on(t.userId),
  symbolIdx:    index('trades_symbol_idx').on(t.symbol),
  statusIdx:    index('trades_status_idx').on(t.status),
  openedIdx:    index('trades_opened_idx').on(t.openedAt),
  sessionIdx:   index('trades_session_idx').on(t.sessionId),
  userOpenIdx:  index('idx_trades_user_open').on(t.userId, t.status),
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

// ─── Relations ────────────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ many, one }) => ({
  sessions:        many(sessions),
  marketConfigs:   many(marketConfigs),
  exchangeApis:    many(exchangeApis),
  trades:          many(trades),
  algoSignals:     many(algoSignals),
  modeAuditLogs:   many(modeAuditLogs),
  botSessions:     many(botSessions),
  positionCloseLogs: many(positionCloseLog),
  botStatus:       one(botStatuses,  { fields: [users.id], references: [botStatuses.userId] }),
  riskSettings:    one(riskSettings, { fields: [users.id], references: [riskSettings.userId] }),
}))

export const botSessionsRelations = relations(botSessions, ({ one, many }) => ({
  user:   one(users, { fields: [botSessions.userId], references: [users.id] }),
  trades: many(trades),
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
export type StopMode          = 'close_all' | 'graceful'