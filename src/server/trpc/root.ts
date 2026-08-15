import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, protectedProcedure } from "./middleware";
import { executePayment, getPaymentStatus } from "@/services/payments";
import { getRecipientPicker } from "@/services/recipients";
import { getActiveShopBySlug, listActiveShops } from "@/services/shops";
import { getWallet, syncBalanceFromChain } from "@/services/wallet";

const amountSchema = z.bigint().positive();

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
});

export type AppRouter = typeof appRouter;
