import { TRPCError, initTRPC } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context";
import { AuthChallengeError, WalletLinkError } from "@/services/auth-stellar";
import { PaymentError } from "@/services/payments";

export type { Context } from "./context";

function typedErrorCode(error: unknown): string | undefined {
  if (error instanceof PaymentError) {
    return error.code;
  }
  if (error instanceof AuthChallengeError || error instanceof WalletLinkError) {
    return error.code;
  }
  return undefined;
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter: ({ error, shape }) => {
    const typedCode = typedErrorCode(error.cause);
    if (typedCode) {
      return { ...shape, data: { ...shape.data, typedCode } };
    }
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;

const isAuthed = middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { user: ctx.user } });
});

export const protectedProcedure = publicProcedure.use(isAuthed);

const isAdmin = middleware(({ ctx, next }) => {
  if (!ctx.user || ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx: { user: ctx.user } });
});

export const adminProcedure = protectedProcedure.use(isAdmin);
