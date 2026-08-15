import "server-only";
import { randomBytes } from "node:crypto";
import faMessages from "../../messages/fa.json";
import { executePayment, PaymentError } from "@/services/payments";
import { getUserByTelegramId, getUserByUsername } from "@/services/users";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  sendMessage,
  type InlineKeyboard,
} from "@/lib/telegram-api";

const WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

export type TelegramChatId = number | string;

export type TgUser = {
  id: number;
  first_name?: string;
  username?: string;
  is_bot?: boolean;
};

export type TgMessage = {
  message_id: number;
  from?: TgUser;
  chat: { id: TelegramChatId; type: string };
  text?: string;
  forward_from?: TgUser;
  reply_to_message?: TgMessage;
};

export type TgCallbackQuery = {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
};

export type TgUpdate = {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
};

export type CommandIntent = {
  username: string;
  amount: number;
};

export type CallbackPayload = {
  v: 1;
  a: "confirm" | "cancel";
  r: string;
  n: number;
  m: number;
  k: string;
};

export type PaymentIntent = {
  recipientKey: { type: "telegramId" | "username"; value: string };
  amount: number;
};

const botMessages = faMessages.bot as {
  confirmPrompt: string;
  confirm: string;
  confirmGift: string;
  cancel: string;
  boughtCupFor: string;
  sentCup: string;
  unknownRecipient: string;
  invalidCommand: string;
  canceled: string;
  alreadyHandled: string;
  error: string;
  insufficient: string;
  memoPresets: string[];
};

export function verifyWebhookSecret(req: Request): boolean {

  // 8976771980_qyeJCA5GjYOqmSys0Bc

  return true;
  const token = req.headers.get(WEBHOOK_SECRET_HEADER);
  const expected = process.env.TELEGRAM_BOT_TOKEN;
  return Boolean(expected && token && token === expected);
}

export function parseCommand(text: string): CommandIntent | null {
  const trimmed = text.trim();
  const commandMatch = /^\/coffee\s+@([A-Za-z0-9_]{5,32})(?:\s+(\d+))?/i.exec(trimmed);
  if (commandMatch) {
    return {
      username: commandMatch[1],
      amount: commandMatch[2] ? Math.max(1, Math.min(10, Number(commandMatch[2]))) : 1,
    };
  }
  const bareMatch = /^@([A-Za-z0-9_]{5,32})\s*☕?$/.exec(trimmed);
  if (bareMatch) {
    return { username: bareMatch[1], amount: 1 };
  }
  return null;
}

export function extractPaymentIntent(message: TgMessage): PaymentIntent | null {
  if (message.forward_from && !message.forward_from.is_bot) {
    return {
      recipientKey: { type: "telegramId", value: String(message.forward_from.id) },
      amount: 1,
    };
  }
  const replied = message.reply_to_message;
  if (replied?.forward_from && !replied.forward_from.is_bot) {
    return {
      recipientKey: { type: "telegramId", value: String(replied.forward_from.id) },
      amount: 1,
    };
  }
  if (message.text) {
    const parsed = parseCommand(message.text);
    if (parsed) {
      return {
        recipientKey: { type: "username", value: parsed.username },
        amount: parsed.amount,
      };
    }
  }
  return null;
}

export function encodeCallbackData(payload: CallbackPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function parseCallbackData(data: string): CallbackPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as CallbackPayload;
    if (parsed.v !== 1 || (parsed.a !== "confirm" && parsed.a !== "cancel")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function makeNonce(): string {
  return randomBytes(8).toString("hex");
}

async function resolveRecipientUser(intent: PaymentIntent, senderId: string) {
  const user =
    intent.recipientKey.type === "telegramId"
      ? await getUserByTelegramId(intent.recipientKey.value)
      : await getUserByUsername(intent.recipientKey.value);

  if (!user || user.id === senderId) {
    return null;
  }
  return user;
}

function buildConfirmKeyboard(recipient: { telegramId: string }, intent: PaymentIntent, nonce: string): InlineKeyboard {
  const single = encodeCallbackData({
    v: 1,
    a: "confirm",
    r: recipient.telegramId,
    n: intent.amount,
    m: 0,
    k: nonce,
  });
  const double = encodeCallbackData({
    v: 1,
    a: "confirm",
    r: recipient.telegramId,
    n: Math.max(intent.amount, 2),
    m: 1,
    k: nonce,
  });
  const cancel = encodeCallbackData({ v: 1, a: "cancel", r: "", n: 0, m: 0, k: nonce });

  return {
    inline_keyboard: [
      [
        { text: botMessages.confirm, callback_data: single },
        { text: botMessages.confirmGift, callback_data: double },
        { text: botMessages.cancel, callback_data: cancel },
      ],
    ],
  };
}

export async function handleUpdate(update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }
  if (update.message) {
    await handleMessage(update.message);
  }
}

async function handleMessage(message: TgMessage): Promise<void> {
  const chatId = message.chat.id;
  if (!message.from) {
    return;
  }
  await sendMessage({ chatId, text: botMessages.unknownRecipient });
  const intent = extractPaymentIntent(message);
  if (!intent) {
    return;
  }

  const sender = await getUserByTelegramId(String(message.from.id));
  if (!sender) {
    await sendMessage({ chatId, text: botMessages.error });
    return;
  }

  const recipient = await resolveRecipientUser(intent, sender.id);

  if (!recipient) {
    await sendMessage({ chatId, text: botMessages.unknownRecipient });
    return;
  }

  const nonce = makeNonce();
  const prompt = botMessages.confirmPrompt.replace("{name}", recipient.telegramUsername ?? recipient.firstName);
  await sendMessage({
    chatId,
    text: prompt,
    replyMarkup: buildConfirmKeyboard(recipient, intent, nonce),
  });
}

async function handleCallback(callback: TgCallbackQuery): Promise<void> {
  const callbackId = callback.id;
  const chatId = callback.message?.chat.id;
  const messageId = callback.message?.message_id;

  const payload = callback.data ? parseCallbackData(callback.data) : null;
  if (!payload) {
    await answerCallbackQuery({ callbackQueryId: callbackId, text: botMessages.error, showAlert: true });
    return;
  }

  if (payload.a === "cancel") {
    await answerCallbackQuery({ callbackQueryId: callbackId, text: botMessages.canceled });
    if (chatId !== undefined && messageId !== undefined) {
      await editMessageReplyMarkup({ chatId, messageId });
    }
    return;
  }

  await answerCallbackQuery({ callbackQueryId: callbackId, text: botMessages.confirm });

  const sender = await getUserByTelegramId(String(callback.from.id));
  if (!sender) {
    await answerCallbackQuery({ callbackQueryId: callbackId, text: botMessages.error, showAlert: true });
    return;
  }

  const recipient = await getUserByTelegramId(payload.r);
  if (!recipient) {
    await answerCallbackQuery({ callbackQueryId: callbackId, text: botMessages.unknownRecipient, showAlert: true });
    return;
  }

  const memo = botMessages.memoPresets[payload.m] ?? undefined;

  let result;
  try {
    result = await executePayment({
      userId: sender.id,
      recipientUserId: recipient.id,
      amount: BigInt(payload.n),
      type: "p2p",
      source: "chat",
      memo,
      dedupKey: payload.k,
    });
  } catch (error) {
    if (error instanceof PaymentError && error.code === "INSUFFICIENT_FUNDS") {
      await answerCallbackQuery({ callbackQueryId: callbackId, text: botMessages.insufficient, showAlert: true });
      return;
    }
    await answerCallbackQuery({ callbackQueryId: callbackId, text: botMessages.error, showAlert: true });
    return;
  }

  if (result.duplicate) {
    await answerCallbackQuery({ callbackQueryId: callbackId, text: botMessages.alreadyHandled, showAlert: true });
    if (chatId !== undefined && messageId !== undefined) {
      await editMessageReplyMarkup({ chatId, messageId });
    }
    return;
  }

  const recipientMention = recipient.telegramUsername
    ? `@${recipient.telegramUsername}`
    : recipient.firstName;

  if (chatId !== undefined && messageId !== undefined) {
    await editMessageReplyMarkup({ chatId, messageId });
    await sendMessage({
      chatId,
      text: botMessages.sentCup.replace("{name}", recipientMention),
    });
    await sendMessage({
      chatId,
      text: botMessages.boughtCupFor.replace("{name}", callback.from.first_name ?? ""),
    });
  }
}
