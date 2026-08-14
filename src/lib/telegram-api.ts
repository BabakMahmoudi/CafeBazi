import { env } from "@/lib/env";

type TelegramResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

async function call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as TelegramResponse<T>;
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description ?? "unknown error"}`);
  }
  return data.result as T;
}

export type TelegramChatId = number | string;

export type InlineKeyboard = {
  inline_keyboard: Array<
    Array<{
      text: string;
      callback_data?: string;
    }>
  >;
};

export async function sendMessage(input: {
  chatId: TelegramChatId;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  replyMarkup?: InlineKeyboard;
}) {
  return call<unknown>("sendMessage", {
    chat_id: input.chatId,
    text: input.text,
    parse_mode: input.parseMode,
    reply_markup: input.replyMarkup,
  });
}

export async function answerCallbackQuery(input: {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
}) {
  return call<boolean>("answerCallbackQuery", {
    callback_query_id: input.callbackQueryId,
    text: input.text,
    show_alert: input.showAlert,
  });
}

export async function editMessageReplyMarkup(input: {
  chatId: TelegramChatId;
  messageId: number;
  replyMarkup?: InlineKeyboard;
}) {
  return call<unknown>("editMessageReplyMarkup", {
    chat_id: input.chatId,
    message_id: input.messageId,
    reply_markup: input.replyMarkup,
  });
}

export async function setWebhook(input: {
  url: string;
  secretToken?: string;
  dropPendingUpdates?: boolean;
}) {
  return call<unknown>("setWebhook", {
    url: input.url,
    secret_token: input.secretToken,
    drop_pending_updates: input.dropPendingUpdates,
  });
}
