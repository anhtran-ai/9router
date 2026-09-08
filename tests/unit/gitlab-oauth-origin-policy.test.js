import { afterEach, describe, expect, it, vi } from "vitest";

import gitlab from "../../src/lib/oauth/providers/gitlab.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitLab OAuth origin policy", () => {
  it("preserves explicit self-hosted GitLab for the administrator OAuth flow", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "gitlab-access-token",
          refresh_token: "gitlab-refresh-token",
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ username: "admin-approved-user" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await gitlab.exchangeToken(
      gitlab.config,
      "authorization-code",
      "http://localhost:20128/callback",
      "pkce-verifier",
      "state",
      {
        baseUrl: "http://127.0.0.1:8929/gitlab",
        clientId: "admin-client",
        clientSecret: "admin-secret",
      },
    );

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8929/gitlab/oauth/token");
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:8929/gitlab/api/v4/user");
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer gitlab-access-token");
    expect(gitlab.mapTokens(tokens).providerSpecificData).toMatchObject({
      baseUrl: "http://127.0.0.1:8929/gitlab",
      clientId: "admin-client",
      username: "admin-approved-user",
    });
  });
});
