import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  albedo: {
    publicKey: vi.fn(),
    tx: vi.fn(),
  },
  freighter: {
    requestAccess: vi.fn(),
    signTransaction: vi.fn(),
  },
  sdkReact: {
    retrieveRawInitData: vi.fn(),
  },
}));

vi.mock("@albedo-link/intent", () => ({ default: h.albedo }));
vi.mock("@stellar/freighter-api", () => h.freighter);
vi.mock("@telegram-apps/sdk-react", () => h.sdkReact);

import { telegramMockState } from "@/components/telegram-provider";
import {
  albedoProvider,
  freighterProvider,
  getWalletProviders,
  isBrowserContext,
  isRealTelegramWebView,
  readInitData,
  UnsupportedNetworkError,
} from "@/lib/wallet-providers";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function stubBrowserWindow() {
  vi.stubGlobal("window", {} as unknown as Window);
}

function stubTelegramWebView(initData = "query_id=1&user=%7B%7D") {
  vi.stubGlobal("window", {
    Telegram: { WebApp: { initData } },
  } as unknown as Window);
}

beforeEach(() => {
  vi.clearAllMocks();
  telegramMockState.mocked = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readInitData", () => {
  it("prefers window.Telegram.WebApp.initData", () => {
    stubTelegramWebView("real-init-data");
    expect(readInitData()).toBe("real-init-data");
    expect(h.sdkReact.retrieveRawInitData).not.toHaveBeenCalled();
  });

  it("falls back to retrieveRawInitData", () => {
    stubBrowserWindow();
    h.sdkReact.retrieveRawInitData.mockReturnValue("sdk-init-data");
    expect(readInitData()).toBe("sdk-init-data");
  });

  it("returns undefined when window is missing", () => {
    expect(readInitData()).toBeUndefined();
    expect(h.sdkReact.retrieveRawInitData).not.toHaveBeenCalled();
  });

  it("returns undefined when retrieveRawInitData throws", () => {
    stubBrowserWindow();
    h.sdkReact.retrieveRawInitData.mockImplementation(() => {
      throw new Error("not a TMA");
    });
    expect(readInitData()).toBeUndefined();
  });
});

describe("isRealTelegramWebView", () => {
  it("is true only with real initData and no mock", () => {
    stubTelegramWebView();
    expect(isRealTelegramWebView()).toBe(true);
  });

  it("is false when the mock environment is active", () => {
    stubTelegramWebView();
    telegramMockState.mocked = true;
    expect(isRealTelegramWebView()).toBe(false);
  });

  it("is false without initData", () => {
    stubBrowserWindow();
    expect(isRealTelegramWebView()).toBe(false);
  });

  it("is false outside a browser", () => {
    expect(isRealTelegramWebView()).toBe(false);
  });
});

describe("isBrowserContext", () => {
  it("is true in a plain browser", () => {
    stubBrowserWindow();
    expect(isBrowserContext()).toBe(true);
  });

  it("is false in a real Telegram WebView", () => {
    stubTelegramWebView();
    expect(isBrowserContext()).toBe(false);
  });

  it("is true in a browser with the mock environment active", () => {
    stubTelegramWebView();
    telegramMockState.mocked = true;
    expect(isBrowserContext()).toBe(true);
  });

  it("is false outside a browser", () => {
    expect(isBrowserContext()).toBe(false);
  });
});

describe("getWalletProviders", () => {
  it("returns freighter and albedo in a browser context", () => {
    stubBrowserWindow();
    expect(getWalletProviders().map((p) => p.id)).toEqual(["freighter", "albedo"]);
  });

  it("returns nothing in a real Telegram WebView", () => {
    stubTelegramWebView();
    expect(getWalletProviders()).toEqual([]);
  });

  it("returns nothing without window", () => {
    expect(getWalletProviders()).toEqual([]);
  });
});

describe("freighterProvider", () => {
  it("resolves the active public key", async () => {
    h.freighter.requestAccess.mockResolvedValue({ address: ADDRESS });
    await expect(freighterProvider.getPublicKey()).resolves.toBe(ADDRESS);
  });

  it("rejects when requestAccess returns an error", async () => {
    h.freighter.requestAccess.mockResolvedValue({ address: "", error: { code: 1 } });
    await expect(freighterProvider.getPublicKey()).rejects.toThrow();
  });

  it("signs a challenge with the network passphrase", async () => {
    h.freighter.signTransaction.mockResolvedValue({ signedTxXdr: "signed-xdr", signerAddress: ADDRESS });
    await expect(freighterProvider.signChallenge("challenge-xdr", TESTNET_PASSPHRASE)).resolves.toBe(
      "signed-xdr",
    );
    expect(h.freighter.signTransaction).toHaveBeenCalledWith("challenge-xdr", {
      networkPassphrase: TESTNET_PASSPHRASE,
    });
  });

  it("rejects when signTransaction returns an error", async () => {
    h.freighter.signTransaction.mockResolvedValue({ signedTxXdr: "", signerAddress: "", error: { code: 1 } });
    await expect(freighterProvider.signChallenge("challenge-xdr", TESTNET_PASSPHRASE)).rejects.toThrow();
  });
});

describe("albedoProvider", () => {
  it("resolves the user-selected public key", async () => {
    h.albedo.publicKey.mockResolvedValue({ pubkey: ADDRESS, signed_message: "m", signature: "s" });
    await expect(albedoProvider.getPublicKey()).resolves.toBe(ADDRESS);
  });

  it("rejects when albedo.publicKey fails", async () => {
    h.albedo.publicKey.mockRejectedValue({ error: "rejected" });
    await expect(albedoProvider.getPublicKey()).rejects.toBeTruthy();
  });

  it("maps the testnet passphrase and returns the signed envelope", async () => {
    h.albedo.tx.mockResolvedValue({
      xdr: "challenge-xdr",
      tx_hash: "hash",
      signed_envelope_xdr: "signed-envelope",
      network: "testnet",
      result: {},
    });
    await expect(
      albedoProvider.signChallenge("challenge-xdr", TESTNET_PASSPHRASE),
    ).resolves.toBe("signed-envelope");
    expect(h.albedo.tx).toHaveBeenCalledWith({ xdr: "challenge-xdr", network: "testnet" });
  });

  it("maps the public passphrase", async () => {
    h.albedo.tx.mockResolvedValue({ signed_envelope_xdr: "signed-envelope" });
    await albedoProvider.signChallenge("challenge-xdr", PUBLIC_PASSPHRASE);
    expect(h.albedo.tx).toHaveBeenCalledWith({ xdr: "challenge-xdr", network: "public" });
  });

  it("rejects with UnsupportedNetworkError for an unknown passphrase", async () => {
    await expect(
      albedoProvider.signChallenge("challenge-xdr", "Some Private Network"),
    ).rejects.toBeInstanceOf(UnsupportedNetworkError);
    expect(h.albedo.tx).not.toHaveBeenCalled();
  });

  it("rejects when albedo.tx fails", async () => {
    h.albedo.tx.mockRejectedValue({ error: "rejected" });
    await expect(albedoProvider.signChallenge("challenge-xdr", TESTNET_PASSPHRASE)).rejects.toBeTruthy();
  });
});
