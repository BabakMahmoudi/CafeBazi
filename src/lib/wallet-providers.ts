"use client";

import albedo from "@albedo-link/intent";
import { requestAccess, signTransaction } from "@stellar/freighter-api";
import { retrieveRawInitData } from "@telegram-apps/sdk-react";
import { telegramMockState } from "@/components/telegram-provider";

export type StellarWalletProvider = {
  id: "freighter" | "albedo";
  getPublicKey(): Promise<string>;
  signChallenge(xdr: string, networkPassphrase: string): Promise<string>;
};

const ALBEDO_NETWORKS: Record<string, "testnet" | "public"> = {
  "Test SDF Network ; September 2015": "testnet",
  "Public Global Stellar Network ; September 2015": "public",
};

export class UnsupportedNetworkError extends Error {
  constructor(networkPassphrase: string) {
    super(`Unsupported Stellar network: ${networkPassphrase}`);
    this.name = "UnsupportedNetworkError";
  }
}

export const freighterProvider: StellarWalletProvider = {
  id: "freighter",
  async getPublicKey() {
    const access = await requestAccess();
    if (access.error || !access.address) {
      throw new Error("Freighter access denied");
    }
    return access.address;
  },
  async signChallenge(xdr, networkPassphrase) {
    const signed = await signTransaction(xdr, { networkPassphrase });
    if (signed.error || !signed.signedTxXdr) {
      throw new Error("Freighter signature denied");
    }
    return signed.signedTxXdr;
  },
};

export const albedoProvider: StellarWalletProvider = {
  id: "albedo",
  async getPublicKey() {
    const result = await albedo.publicKey({});
    if (!result?.pubkey) {
      throw new Error("Albedo access denied");
    }
    return result.pubkey;
  },
  async signChallenge(xdr, networkPassphrase) {
    const network = ALBEDO_NETWORKS[networkPassphrase];
    if (!network) {
      throw new UnsupportedNetworkError(networkPassphrase);
    }
    const result = await albedo.tx({ xdr, network });
    if (!result?.signed_envelope_xdr) {
      throw new Error("Albedo signature denied");
    }
    return result.signed_envelope_xdr;
  },
};

export function readInitData(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  try {
    const webAppInitData = (
      window as Window & { Telegram?: { WebApp?: { initData?: string } } }
    ).Telegram?.WebApp?.initData;
    return webAppInitData || retrieveRawInitData();
  } catch {
    return undefined;
  }
}

export function isRealTelegramWebView(): boolean {
  return Boolean(readInitData()) && !telegramMockState.mocked;
}

export function isBrowserContext(): boolean {
  return typeof window !== "undefined" && !isRealTelegramWebView();
}

export function getWalletProviders(): StellarWalletProvider[] {
  return isBrowserContext() ? [freighterProvider, albedoProvider] : [];
}
