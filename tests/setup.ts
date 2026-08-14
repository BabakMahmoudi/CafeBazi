process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://user:pass@localhost:5432/cafe_bazi_test";
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "123456789:AA_TELEGRAM_BOT_TEST_TOKEN";
process.env.KEY_ENCRYPTION_KEY =
  process.env.KEY_ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-jwt-secret";
process.env.STELLAR_NETWORK = "testnet";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.TAK_ISSUER_PUBLIC_KEY =
  process.env.TAK_ISSUER_PUBLIC_KEY ?? "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
process.env.CRON_SECRET = process.env.CRON_SECRET ?? "test-cron-secret";
process.env.NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME =
  process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "cafe_bazi_test_bot";
