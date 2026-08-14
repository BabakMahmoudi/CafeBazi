"use client";

import { useEffect } from "react";
import { init, isTMA, mockTelegramEnv } from "@telegram-apps/sdk-react";

function mockLaunchEnvironment() {
  mockTelegramEnv({
    launchParams: {
      tgWebAppVersion: "8.0",
      tgWebAppPlatform: "web",
      tgWebAppThemeParams: {
        bg_color: "#faf6f0",
        text_color: "#241a12",
        hint_color: "#8a7b6d",
        link_color: "#2481cc",
        button_color: "#7c4a21",
        button_text_color: "#ffffff",
        secondary_bg_color: "#efe6da",
      },
      tgWebAppStartParam: "s1",
      tgWebAppData:
        "user=%7B%22id%22%3A777000%2C%22first_name%22%3A%22Developer%22%2C%22last_name%22%3A%22%22%2C%22username%22%3A%22dev%22%2C%22language_code%22%3A%22fa%22%7D&auth_date=0&hash=dev-mock",
    },
  });
}

export function TelegramProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    try {
      if (!isTMA()) {
        mockLaunchEnvironment();
      }
      init();
    } catch {
      // best-effort outside Telegram
    }
  }, []);

  return <>{children}</>;
}
