const START_PARAM_REGEX = /^s(\d+)(?:t(\d+))?$/;

export type QrPayload = {
  shopId: string;
  table?: string;
};

export function parseStartParam(param: string | null | undefined): QrPayload | null {
  if (!param) {
    return null;
  }
  const match = START_PARAM_REGEX.exec(param.trim());
  if (!match) {
    return null;
  }
  return {
    shopId: match[1],
    table: match[2] ? match[2] : undefined,
  };
}

export function buildStartParam(input: QrPayload): string {
  return input.table ? `s${input.shopId}t${input.table}` : `s${input.shopId}`;
}

export function buildStartAppUrl(botUsername: string, payload: QrPayload): string {
  const username = botUsername.trim().replace(/^@/, "");
  return `https://t.me/${username}?startapp=${encodeURIComponent(buildStartParam(payload))}`;
}
