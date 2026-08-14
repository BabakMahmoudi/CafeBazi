import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InlineKeyboard } from "@/lib/telegram-api";
import {
  encodeCallbackData,
  extractPaymentIntent,
  handleUpdate,
  parseCallbackData,
  parseCommand,
  verifyWebhookSecret,
  type CallbackPayload,
  type TgUpdate,
} from "@/services/bot";

type SendMessageInput = {
  chatId: number | string;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  replyMarkup?: InlineKeyboard;
};

const h = vi.hoisted(() => ({
  executePayment: vi.fn(
    async (_input: unknown): Promise<Record<string, unknown>> => ({
      id: "tx1",
      txHash: "h1",
      status: "confirmed",
      amount: 1n,
      type: "p2p",
      memo: null,
      duplicate: false,
    }),
  ),
  getUserByTelegramId: vi.fn(async (_id: string) => null as unknown),
  getUserByUsername: vi.fn(async (_username: string) => null as unknown),
  sendMessage: vi.fn(async (_input: SendMessageInput) => ({})),
  answerCallbackQuery: vi.fn(
    async (_input: { callbackQueryId: string; text?: string; showAlert?: boolean }) => true,
  ),
  editMessageReplyMarkup: vi.fn(
    async (_input: { chatId: number | string; messageId: number; replyMarkup?: InlineKeyboard }) => ({}),
  ),
}));

vi.mock("@/services/payments", async () => {
  const real = await vi.importActual<typeof import("@/services/payments")>(
    "@/services/payments",
  );
  return { ...real, executePayment: h.executePayment };
});

vi.mock("@/services/users", () => ({
  getUserByTelegramId: h.getUserByTelegramId,
  getUserByUsername: h.getUserByUsername,
}));

vi.mock("@/lib/telegram-api", () => ({
  sendMessage: h.sendMessage,
  answerCallbackQuery: h.answerCallbackQuery,
  editMessageReplyMarkup: h.editMessageReplyMarkup,
}));

const senderUser = { id: "sender", telegramId: "100", telegramUsername: "ali", firstName: "Ali", role: "member" };
const recipientUser = { id: "recipient", telegramId: "200", telegramUsername: "reza", firstName: "Reza", role: "member" };

function messageUpdate(overrides: Record<string, unknown>): TgUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 100, first_name: "Ali", username: "ali" },
      chat: { id: 100, type: "private" },
      ...overrides,
    },
  } as TgUpdate;
}

describe("bot service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("verifyWebhookSecret", () => {
    it("accepts the matching secret-token header", () => {
      const req = new Request("https://example.test/api/bot/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": process.env.TELEGRAM_BOT_TOKEN ?? "" },
      });
      expect(verifyWebhookSecret(req)).toBe(true);
    });

    it("rejects a wrong header", () => {
      const req = new Request("https://example.test/api/bot/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "wrong-token" },
      });
      expect(verifyWebhookSecret(req)).toBe(false);
    });

    it("rejects a missing header", () => {
      const req = new Request("https://example.test/api/bot/webhook", { method: "POST" });
      expect(verifyWebhookSecret(req)).toBe(false);
    });
  });

  describe("parseCommand", () => {
    it("parses /coffee @username N", () => {
      expect(parseCommand("/coffee @reza2 2")).toEqual({ username: "reza2", amount: 2 });
    });

    it("defaults /coffee @username to one cup", () => {
      expect(parseCommand("/coffee @reza2")).toEqual({ username: "reza2", amount: 1 });
    });

    it("parses a bare @username ☕", () => {
      expect(parseCommand("@reza2 ☕")).toEqual({ username: "reza2", amount: 1 });
    });

    it("rejects non-payment text", () => {
      expect(parseCommand("hello world")).toBeNull();
      expect(parseCommand("/start")).toBeNull();
    });

    it("clamps absurd amounts", () => {
      expect(parseCommand("/coffee @reza2 999")?.amount).toBe(10);
    });
  });

  describe("extractPaymentIntent", () => {
    it("extracts the forward_from sender", () => {
      const intent = extractPaymentIntent(
        messageUpdate({ forward_from: { id: 200, first_name: "Reza", username: "reza" } }).message!,
      );
      expect(intent).toEqual({ recipientKey: { type: "telegramId", value: "200" }, amount: 1 });
    });

    it("extracts the reply_to_message forward_from", () => {
      const intent = extractPaymentIntent(
        messageUpdate({
          reply_to_message: {
            message_id: 5,
            from: { id: 100, first_name: "Ali" },
            chat: { id: 100, type: "private" },
            forward_from: { id: 200, first_name: "Reza", username: "reza" },
          },
        }).message!,
      );
      expect(intent).toEqual({ recipientKey: { type: "telegramId", value: "200" }, amount: 1 });
    });

    it("extracts a command-style mention", () => {
      const intent = extractPaymentIntent(
        messageUpdate({ text: "/coffee @reza2 2" }).message!,
      );
      expect(intent).toEqual({ recipientKey: { type: "username", value: "reza2" }, amount: 2 });
    });

    it("ignores forwarded messages from bots", () => {
      const intent = extractPaymentIntent(
        messageUpdate({
          forward_from: { id: 999, first_name: "Bot", is_bot: true },
          text: "random",
        }).message!,
      );
      expect(intent).toBeNull();
    });

    it("returns null for an unrelated message", () => {
      expect(extractPaymentIntent(messageUpdate({ text: "سلام" }).message!)).toBeNull();
    });
  });

  describe("callback payload encoding", () => {
    it("round-trips a confirm payload", () => {
      const payload: CallbackPayload = {
        v: 1,
        a: "confirm",
        r: "200",
        n: 1,
        m: 0,
        k: "abc123",
      };
      expect(parseCallbackData(encodeCallbackData(payload))).toEqual(payload);
    });

    it("rejects garbage data", () => {
      expect(parseCallbackData("not-json")).toBeNull();
      expect(
        parseCallbackData(
          encodeCallbackData({ v: 2, a: "confirm", r: "1", n: 1, m: 0, k: "x" } as unknown as CallbackPayload),
        ),
      ).toBeNull();
    });
  });

  describe("forward-to-pay flow", () => {
    it("shows a confirm keyboard before any payment executes", async () => {
      h.getUserByTelegramId.mockImplementation(async (id: string) =>
        id === "100" ? senderUser : id === "200" ? recipientUser : null,
      );

      await handleUpdate(
        messageUpdate({ forward_from: { id: 200, first_name: "Reza", username: "reza" } }),
      );

      expect(h.executePayment).not.toHaveBeenCalled();
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      const [message] = h.sendMessage.mock.calls[0];
      expect(message.replyMarkup!.inline_keyboard).toHaveLength(1);
      expect(message.text).toContain("reza");
    });

    it("confirms via callback and executes the shared payment path", async () => {
      h.getUserByTelegramId.mockImplementation(async (id: string) =>
        id === "100" ? senderUser : id === "200" ? recipientUser : null,
      );

      await handleUpdate(
        messageUpdate({ forward_from: { id: 200, first_name: "Reza", username: "reza" } }),
      );
      const [sent] = h.sendMessage.mock.calls[0];
      const confirmData = sent.replyMarkup!.inline_keyboard[0][0].callback_data;

      await handleUpdate({
        update_id: 2,
        callback_query: {
          id: "cb1",
          from: { id: 100, first_name: "Ali", username: "ali" },
          message: { message_id: 10, chat: { id: 100, type: "private" } },
          data: confirmData,
        },
      });

      expect(h.executePayment).toHaveBeenCalledTimes(1);
      expect(h.executePayment.mock.calls[0][0] as Record<string, unknown>).toMatchObject({
        userId: "sender",
        recipientUserId: "recipient",
        amount: 1n,
        type: "p2p",
        source: "chat",
        memo: "☕",
      });
      expect(h.answerCallbackQuery).toHaveBeenCalled();
      expect(h.editMessageReplyMarkup).toHaveBeenCalled();
      expect(h.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it("does not confirm payment for an unknown recipient", async () => {
      h.getUserByTelegramId.mockImplementation(async (id: string) =>
        id === "100" ? senderUser : null,
      );

      await handleUpdate(
        messageUpdate({ forward_from: { id: 999, first_name: "Ghost", username: "ghost" } }),
      );

      expect(h.executePayment).not.toHaveBeenCalled();
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
      const [message] = h.sendMessage.mock.calls[0];
      expect(message.text).toContain("هنوز به کافه بازی نپیوسته");
    });

    it("guards against self-sends (sender == forward sender)", async () => {
      h.getUserByTelegramId.mockImplementation(async (id: string) =>
        id === "100" ? senderUser : null,
      );

      await handleUpdate(
        messageUpdate({ forward_from: { id: 100, first_name: "Ali", username: "ali" } }),
      );

      expect(h.executePayment).not.toHaveBeenCalled();
      expect(h.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("treats a double-tap on the same nonce as duplicate", async () => {
      h.getUserByTelegramId.mockImplementation(async (id: string) =>
        id === "100" ? senderUser : id === "200" ? recipientUser : null,
      );

      await handleUpdate(
        messageUpdate({ forward_from: { id: 200, first_name: "Reza", username: "reza" } }),
      );
      const [sent] = h.sendMessage.mock.calls[0];
      const confirmData = sent.replyMarkup!.inline_keyboard[0][0].callback_data;

      h.executePayment.mockResolvedValueOnce({
        id: "tx1",
        txHash: "h1",
        status: "confirmed",
        amount: 1n,
        type: "p2p",
        memo: null,
        duplicate: true,
      });

      await handleUpdate({
        update_id: 3,
        callback_query: {
          id: "cb1",
          from: { id: 100, first_name: "Ali", username: "ali" },
          message: { message_id: 10, chat: { id: 100, type: "private" } },
          data: confirmData,
        },
      });

      expect(h.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("قبلاً پردازش") }),
      );
    });

    it("answers insufficient-funds errors distinctly", async () => {
      h.getUserByTelegramId.mockImplementation(async (id: string) =>
        id === "100" ? senderUser : id === "200" ? recipientUser : null,
      );
      const { PaymentError } = await vi.importActual<typeof import("@/services/payments")>(
        "@/services/payments",
      );
      h.executePayment.mockRejectedValue(new PaymentError("no funds", "INSUFFICIENT_FUNDS"));

      await handleUpdate(
        messageUpdate({ forward_from: { id: 200, first_name: "Reza", username: "reza" } }),
      );
      const [sent] = h.sendMessage.mock.calls[0];
      const confirmData = sent.replyMarkup!.inline_keyboard[0][0].callback_data;

      await handleUpdate({
        update_id: 4,
        callback_query: {
          id: "cb2",
          from: { id: 100, first_name: "Ali", username: "ali" },
          message: { message_id: 10, chat: { id: 100, type: "private" } },
          data: confirmData,
        },
      });

      expect(h.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("موجودی") }),
      );
    });
  });
});
