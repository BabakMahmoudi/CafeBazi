import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const USER_ROLES = ["member", "merchant", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const STELLAR_ACCOUNT_STATUSES = ["active", "pending_funding", "disabled"] as const;
export type StellarAccountStatus = (typeof STELLAR_ACCOUNT_STATUSES)[number];

export const TRANSACTION_TYPES = [
  "purchase",
  "p2p",
  "gift",
  "mint",
  "burn",
  "redemption",
  "withdrawal",
  "lottery",
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ["pending", "submitted", "confirmed", "failed"] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const CONTACT_SOURCES = ["username", "transfer", "phone"] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export const GAME_NAMES = [
  "espresso_roulette",
  "brewing_speed_challenge",
  "barista_puzzle",
] as const;
export type GameName = (typeof GAME_NAMES)[number];

export const GAME_SESSION_STATUSES = ["active", "used", "expired"] as const;
export type GameSessionStatus = (typeof GAME_SESSION_STATUSES)[number];

export const LOTTERY_DRAW_STATUSES = ["scheduled", "drawn", "paid"] as const;
export type LotteryDrawStatus = (typeof LOTTERY_DRAW_STATUSES)[number];

export const REDEMPTION_STATUSES = ["pending", "dispatched", "cancelled"] as const;
export type RedemptionStatus = (typeof REDEMPTION_STATUSES)[number];

export const WALLET_LINK_SOURCES = ["stellar"] as const;
export type WalletLinkSource = (typeof WALLET_LINK_SOURCES)[number];

export const AUTH_CHALLENGE_PURPOSES = ["login", "link"] as const;
export type AuthChallengePurpose = (typeof AUTH_CHALLENGE_PURPOSES)[number];

export const AUTH_CHALLENGE_STATUSES = ["pending", "used", "expired"] as const;
export type AuthChallengeStatus = (typeof AUTH_CHALLENGE_STATUSES)[number];

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    telegramId: text("telegram_id").notNull(),
    telegramUsername: text("telegram_username"),
    firstName: text("first_name").notNull(),
    phone: text("phone"),
    role: text("role", { enum: USER_ROLES }).notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_telegram_id_unique").on(table.telegramId),
    index("users_telegram_username_idx").on(table.telegramUsername),
  ],
);

export const stellarAccounts = pgTable(
  "stellar_accounts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
    publicKey: text("public_key").notNull(),
    encryptedSecret: text("encrypted_secret").notNull(),
    status: text("status", { enum: STELLAR_ACCOUNT_STATUSES })
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stellar_accounts_public_key_unique").on(table.publicKey),
    index("stellar_accounts_user_id_idx").on(table.userId),
  ],
);

export const coffeeShops = pgTable(
  "coffee_shops",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    merchantId: text("merchant_id").notNull().references(() => users.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    address: text("address"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("coffee_shops_slug_unique").on(table.slug),
    index("coffee_shops_merchant_id_idx").on(table.merchantId),
    index("coffee_shops_is_active_idx").on(table.isActive),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    txHash: text("tx_hash").notNull(),
    type: text("type", { enum: TRANSACTION_TYPES }).notNull(),
    status: text("status", { enum: TRANSACTION_STATUSES }).notNull().default("pending"),
    amount: numeric("amount", { precision: 30, scale: 0 }).notNull(),
    fromAccount: text("from_account"),
    toAccount: text("to_account"),
    memo: text("memo"),
    userId: text("user_id").references(() => users.id),
    shopId: text("shop_id").references(() => coffeeShops.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("transactions_tx_hash_unique").on(table.txHash),
    index("transactions_user_created_idx").on(table.userId, table.createdAt),
    index("transactions_status_idx").on(table.status),
  ],
);

export const balances = pgTable(
  "balances",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").references(() => users.id),
    shopId: text("shop_id").references(() => coffeeShops.id),
    amount: numeric("amount", { precision: 30, scale: 0 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("balances_user_id_unique").on(table.userId),
    uniqueIndex("balances_shop_id_unique").on(table.shopId),
  ],
);

export const contacts = pgTable(
  "contacts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
    contactUserId: text("contact_user_id").notNull().references(() => users.id),
    source: text("source", { enum: CONTACT_SOURCES }).notNull().default("username"),
    nickname: text("nickname"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contacts_user_contact_unique").on(table.userId, table.contactUserId),
    index("contacts_user_last_used_idx").on(table.userId, table.lastUsedAt),
  ],
);

export const gameSessions = pgTable(
  "game_sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
    game: text("game", { enum: GAME_NAMES }).notNull(),
    nonce: text("nonce").notNull(),
    hmac: text("hmac").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: GAME_SESSION_STATUSES }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("game_sessions_user_game_created_idx").on(table.userId, table.game, table.createdAt),
  ],
);

export const gameScores = pgTable(
  "game_scores",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
    gameSessionId: text("game_session_id").notNull().references(() => gameSessions.id),
    score: integer("score").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("game_scores_user_id_idx").on(table.userId),
    uniqueIndex("game_scores_session_unique").on(table.gameSessionId),
  ],
);

export const lotteryDraws = pgTable(
  "lottery_draws",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    week: text("week").notNull(),
    status: text("status", { enum: LOTTERY_DRAW_STATUSES }).notNull().default("scheduled"),
    winnerUserId: text("winner_user_id").references(() => users.id),
    ledgerHash: text("ledger_hash"),
    prize: numeric("prize", { precision: 30, scale: 0 }).notNull().default("100"),
    drawnAt: timestamp("drawn_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("lottery_draws_week_unique").on(table.week),
  ],
);

export const lotteryEntries = pgTable(
  "lottery_entries",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    drawId: text("draw_id").notNull().references(() => lotteryDraws.id),
    userId: text("user_id").notNull().references(() => users.id),
    tickets: integer("tickets").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("lottery_entries_draw_user_unique").on(table.drawId, table.userId),
    index("lottery_entries_draw_id_idx").on(table.drawId),
  ],
);

export const inventory = pgTable("inventory", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  item: text("item").notNull(),
  quantityGrams: numeric("quantity_grams", { precision: 30, scale: 0 }).notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const redemptions = pgTable(
  "redemptions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    shopId: text("shop_id").notNull().references(() => coffeeShops.id),
    amountTak: numeric("amount_tak", { precision: 30, scale: 0 }).notNull(),
    beansGrams: numeric("beans_grams", { precision: 30, scale: 0 }).notNull(),
    status: text("status", { enum: REDEMPTION_STATUSES }).notNull().default("pending"),
    adminId: text("admin_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("redemptions_shop_id_idx").on(table.shopId),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    actorUserId: text("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_log_actor_created_idx").on(table.actorUserId, table.createdAt),
    index("audit_log_action_idx").on(table.action),
  ],
);

export const walletLinks = pgTable(
  "wallet_links",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id),
    publicKey: text("public_key").notNull(),
    source: text("source", { enum: WALLET_LINK_SOURCES }).notNull().default("stellar"),
    label: text("label"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("wallet_links_public_key_unique").on(table.publicKey),
    index("wallet_links_user_id_idx").on(table.userId),
  ],
);

export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    publicKey: text("public_key").notNull(),
    nonce: text("nonce").notNull(),
    purpose: text("purpose", { enum: AUTH_CHALLENGE_PURPOSES }).notNull(),
    status: text("status", { enum: AUTH_CHALLENGE_STATUSES }).notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_challenges_nonce_unique").on(table.nonce),
    index("auth_challenges_status_idx").on(table.status),
    index("auth_challenges_public_key_idx").on(table.publicKey),
  ],
);
