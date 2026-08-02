import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ registerTraeSession: vi.fn(() => true) }));

vi.mock("next/server", () => ({
  NextResponse: { json: (body, init) => Response.json(body, init) },
}));

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens: vi.fn(),
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

vi.mock("@/models", () => ({ createProviderConnection: vi.fn() }));

vi.mock("@/lib/oauth/utils/server", () => ({
  startCodexProxy: vi.fn(), stopCodexProxy: vi.fn(), registerCodexSession: vi.fn(), getCodexSessionStatus: vi.fn(), clearCodexSession: vi.fn(),
  startXaiProxy: vi.fn(), stopXaiProxy: vi.fn(), registerXaiSession: vi.fn(), getXaiSessionStatus: vi.fn(), clearXaiSession: vi.fn(),
  startTraeProxy: vi.fn(), stopTraeProxy: vi.fn(), registerTraeSession: mocks.registerTraeSession, getTraeSessionStatus: vi.fn(), clearTraeSession: vi.fn(),
  startWindsurfProxy: vi.fn(), stopWindsurfProxy: vi.fn(), registerWindsurfSession: vi.fn(), getWindsurfSessionStatus: vi.fn(), clearWindsurfSession: vi.fn(),
  startZedProxy: vi.fn(), stopZedProxy: vi.fn(), registerZedSession: vi.fn(), getZedSessionStatus: vi.fn(), clearZedSession: vi.fn(),
}));

vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));
vi.mock("@/lib/oauth/constants/oauth", () => ({ ZED_HOSTED_CONFIG: { defaultNativeAppPort: 58443 } }));

const { POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

describe("OAuth proxy session registration", () => {
  it("reads state from the POST body and registers the proxy session", async () => {
    const request = new Request("https://router.example/api/oauth/trae/register-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "state-1" }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ provider: "trae", action: "register-session" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mocks.registerTraeSession).toHaveBeenCalledWith({ state: "state-1" });
  });
});
