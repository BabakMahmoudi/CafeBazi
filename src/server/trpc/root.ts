import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router, protectedProcedure } from "./middleware";
import { clearSessionCookie } from "@/lib/auth";
import { USER_ROLES } from "@/db/schema";
import { env } from "@/lib/env";
import {
  createUserForAdmin,
  listUsersForAdmin,
  syncUserBalanceForAdmin,
  updateUserForAdmin,
} from "@/services/admin";
import {
  issueChallenge,
  linkWallet,
  listWalletLinks,
  unlinkWallet,
  verifyChallenge,
} from "@/services/auth-stellar";
import { executePayment, getPaymentStatus } from "@/services/payments";
import { createGameSession, spinRoulette } from "@/services/games";
import { getRecipientPicker } from "@/services/recipients";
import { getActiveShopBySlug, listActiveShops } from "@/services/shops";
import { getWallet, syncBalanceFromChain } from "@/services/wallet";

const amountSchema = z.bigint().positive();
const roleSchema = z.enum(USER_ROLES);

export const appRouter = router({
  wallet: router({
    get: protectedProcedure.query(async ({ ctx }) => getWallet(ctx.user.id)),
    sync: protectedProcedure.mutation(async ({ ctx }) => syncBalanceFromChain(ctx.user.id)),
  }),
  payments: router({
    create: protectedProcedure
      .input(
        z.object({
          shopSlug: z.string().min(1).max(24),
          cups: z.number().int().min(1).max(20),
          table: z.string().trim().max(10).optional(),
          memo: z.string().trim().max(100).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const shop = await getActiveShopBySlug(input.shopSlug);
        if (!shop) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Shop not found or inactive" });
        }
        return executePayment({
          userId: ctx.user.id,
          shopId: shop.id,
          amount: BigInt(input.cups),
          type: "purchase",
          source: "miniapp",
          table: input.table,
          memo: input.memo,
        });
      }),
    send: protectedProcedure
      .input(
        z.object({
          recipientId: z.string().min(1),
          amount: amountSchema,
          memo: z.string().trim().max(100).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        executePayment({
          userId: ctx.user.id,
          recipientUserId: input.recipientId,
          amount: input.amount,
          type: "p2p",
          source: "miniapp",
          memo: input.memo,
        }),
      ),
    sendExternal: protectedProcedure
      .input(
        z.object({
          address: z.string().trim().min(1).max(56),
          amount: amountSchema,
          memo: z.string().trim().max(100).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        executePayment({
          userId: ctx.user.id,
          destinationAddress: input.address,
          amount: input.amount,
          type: "withdrawal",
          source: "miniapp",
          memo: input.memo,
        }),
      ),
    status: protectedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const payment = await getPaymentStatus(ctx.user.id, input.id);
        if (!payment) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }
        return payment;
      }),
    recipients: protectedProcedure
      .input(z.object({ query: z.string().trim().max(32).optional() }))
      .query(async ({ ctx, input }) => getRecipientPicker(ctx.user.id, input.query)),
  }),
  shops: router({
    listActive: protectedProcedure.query(() => listActiveShops()),
  }),
  wallets: router({
    list: protectedProcedure.query(async ({ ctx }) => ({
      wallets: await listWalletLinks(ctx.user.id),
      takContractId: env.TAK_CONTRACT_ID || null,
    })),
    linkStart: protectedProcedure
      .input(z.object({ publicKey: z.string().trim().min(1).max(56) }))
      .mutation(({ input }) => issueChallenge({ publicKey: input.publicKey, purpose: "link" })),
    linkVerify: protectedProcedure
      .input(z.object({ signedChallengeXdr: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const publicKey = await verifyChallenge({
          signedChallengeXdr: input.signedChallengeXdr,
          purpose: "link",
        });
        const linked = await linkWallet(ctx.user.id, publicKey);
        return { publicKey: linked };
      }),
    unlink: protectedProcedure
      .input(z.object({ publicKey: z.string().trim().min(1).max(56) }))
      .mutation(({ ctx, input }) => unlinkWallet(ctx.user.id, input.publicKey)),
  }),
  session: router({
    role: protectedProcedure.query(({ ctx }) => ctx.user.role),
    logout: protectedProcedure.mutation(async () => {
      await clearSessionCookie();
      return { ok: true };
    }),
  }),
  games: router({
    session: protectedProcedure.mutation(async ({ ctx }) => createGameSession(ctx.user.id)),
    spin: protectedProcedure
      .input(
        z.object({
          sessionId: z.string().min(1),
          nonce: z.string().min(1),
          hmac: z.string().min(1),
          spinType: z.enum(["free", "paid"]),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        spinRoulette({ userId: ctx.user.id, ...input }),
      ),
  }),
  admin: router({
    users: router({
      list: adminProcedure
        .input(
          z.object({
            query: z.string().trim().max(64).optional(),
            limit: z.number().int().min(1).max(100).default(50),
            offset: z.number().int().min(0).default(0),
          }),
        )
        .query(({ input }) => listUsersForAdmin(input)),
      create: adminProcedure
        .input(
          z.object({
            firstName: z.string().trim().min(1).max(100),
            telegramId: z.string().trim().regex(/^\d+$/).max(32).optional(),
            telegramUsername: z.string().trim().max(32).optional(),
            phone: z.string().trim().max(32).optional(),
            role: roleSchema,
          }),
        )
        .mutation(({ input }) => createUserForAdmin(input)),
      update: adminProcedure
        .input(
          z.object({
            userId: z.string().min(1),
            firstName: z.string().trim().min(1).max(100).optional(),
            telegramUsername: z.string().trim().max(32).optional(),
            phone: z.string().trim().max(32).nullable().optional(),
            role: roleSchema.optional(),
          }),
        )
        .mutation(({ ctx, input }) =>
          updateUserForAdmin({ ...input, actorUserId: ctx.user.id }),
        ),
      syncBalance: adminProcedure
        .input(z.object({ userId: z.string().min(1) }))
        .mutation(({ input }) => syncUserBalanceForAdmin(input.userId)),
    }),
  }),
});

export type AppRouter = typeof appRouter;
