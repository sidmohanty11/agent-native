import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockResolveBuilderCredentials = vi.fn();

vi.mock("../server/credential-provider.js", () => ({
  getBuilderProxyOrigin: () =>
    process.env.BUILDER_PROXY_ORIGIN ||
    process.env.AIR_HOST ||
    process.env.BUILDER_API_HOST ||
    "https://api.builder.io",
  resolveBuilderCredentials: () => mockResolveBuilderCredentials(),
}));

import { transcribeWithBuilder } from "./builder-transcription.js";

const successBody = {
  text: "hello world",
  language: "en",
  durationSeconds: 1,
  segments: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BUILDER_PROXY_ORIGIN;
  delete process.env.AIR_HOST;
  delete process.env.BUILDER_API_HOST;
  mockResolveBuilderCredentials.mockResolvedValue({
    privateKey: "private-key",
    publicKey: "space-id",
    userId: "builder-user",
    orgName: null,
    orgKind: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcribeWithBuilder", () => {
  it("posts audio to the public Builder API with private key, space id, and user id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribeWithBuilder({
        audioBytes: new Uint8Array([1, 2, 3]),
        mimeType: "video/webm",
        model: "gemini-3-1-flash-lite",
        diarize: false,
      }),
    ).resolves.toEqual(successBody);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      "https://api.builder.io/agent-native/transcribe-audio",
    );
    expect(parsed.searchParams.get("mimeType")).toBe("video/webm");
    expect(parsed.searchParams.get("model")).toBe("gemini-3-1-flash-lite");
    expect(parsed.searchParams.get("diarize")).toBe("false");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer private-key",
        "x-builder-api-key": "space-id",
        "x-builder-user-id": "builder-user",
        "Content-Type": "application/octet-stream",
      }),
    );
    expect(Buffer.from(init.body as ArrayBuffer)).toEqual(
      Buffer.from([1, 2, 3]),
    );
  });

  it("omits the optional user id header when Builder did not return one", async () => {
    mockResolveBuilderCredentials.mockResolvedValue({
      privateKey: "private-key",
      publicKey: "space-id",
      userId: null,
      orgName: null,
      orgKind: null,
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await transcribeWithBuilder({
      audioBytes: new Uint8Array([1]),
      mimeType: "audio/webm",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual(
      expect.not.objectContaining({ "x-builder-user-id": expect.anything() }),
    );
  });

  it("fails before fetch when Builder space id is missing", async () => {
    mockResolveBuilderCredentials.mockResolvedValue({
      privateKey: "private-key",
      publicKey: null,
      userId: "builder-user",
      orgName: null,
      orgKind: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribeWithBuilder({
        audioBytes: new Uint8Array([1]),
        mimeType: "audio/webm",
      }),
    ).rejects.toThrow("Builder space ID not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("respects a Builder proxy origin override", async () => {
    process.env.BUILDER_PROXY_ORIGIN = "https://builder-proxy.test";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(successBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await transcribeWithBuilder({
      audioBytes: new Uint8Array([1]),
      mimeType: "audio/webm",
    });

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(
      /^https:\/\/builder-proxy\.test\/agent-native\/transcribe-audio\?/,
    );
  });
});
