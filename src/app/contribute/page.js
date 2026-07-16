"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, OAuthModal } from "@/shared/components";
import { OAUTH_PROVIDERS } from "@/shared/constants/providers";

export default function ContributorPage() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    fetch("/api/contribute/session", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        setSession(data);
      })
      .catch((err) => setError(err.message || "Contribution session is unavailable"))
      .finally(() => setLoading(false));
  }, []);

  const providers = useMemo(
    () =>
      (session?.allowedProviders || [])
        .map((id) => [id, OAUTH_PROVIDERS[id]])
        .filter(([, provider]) => provider),
    [session],
  );

  const finish = () => {
    setSelectedProvider(null);
    setCompleted(true);
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-bg flex items-center justify-center text-text-muted">
        Validating contribution session…
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg px-6 py-12">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[14px] bg-brand-500 text-white shadow-sm">
            <span className="material-symbols-outlined text-[30px]">hub</span>
          </div>
          <h1 className="text-3xl font-bold text-text-main">Contribute an AI account</h1>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-text-muted">
            Sign in directly with the provider you choose. 9Router stores the resulting OAuth credential;
            this page never reveals the administrator console or existing accounts.
          </p>
        </header>

        {completed ? (
          <section className="mx-auto max-w-lg rounded-[14px] border border-green-500/30 bg-surface p-8 text-center shadow-[var(--shadow-soft)]">
            <span className="material-symbols-outlined text-5xl text-green-500">check_circle</span>
            <h2 className="mt-3 text-xl font-semibold text-text-main">Contribution completed</h2>
            <p className="mt-2 text-sm text-text-muted">This one-time link is now closed. You may close this window.</p>
          </section>
        ) : error ? (
          <section className="mx-auto max-w-lg rounded-[14px] border border-red-500/30 bg-surface p-8 text-center">
            <span className="material-symbols-outlined text-4xl text-red-500">link_off</span>
            <h2 className="mt-3 text-lg font-semibold text-text-main">Link unavailable</h2>
            <p className="mt-2 text-sm text-red-500">{error}</p>
          </section>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {providers.map(([id, provider]) => (
                <article key={id} className="rounded-[14px] border border-border bg-surface p-5 shadow-[var(--shadow-soft)]">
                  <div className="flex items-center gap-4">
                    <div
                      className="flex h-11 w-11 items-center justify-center rounded-xl bg-bg"
                      style={{ color: provider.color || "var(--color-brand-500)" }}
                    >
                      <span className="material-symbols-outlined text-[26px]">{provider.icon || "smart_toy"}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="font-semibold text-text-main">{provider.name || id}</h2>
                      <p className="text-xs text-text-muted">OAuth connection</p>
                    </div>
                    <Button size="sm" onClick={() => setSelectedProvider(id)}>Connect</Button>
                  </div>
                </article>
              ))}
            </div>

            <p className="mt-8 text-center text-xs leading-5 text-text-muted">
              Only contribute an account you own and are authorized to connect. Provider subscription terms still apply.
            </p>
          </>
        )}
      </div>

      {selectedProvider && (
        <OAuthModal
          isOpen
          provider={selectedProvider}
          providerInfo={OAUTH_PROVIDERS[selectedProvider]}
          apiBase="/api/contribute/oauth"
          onSuccess={finish}
          onClose={() => setSelectedProvider(null)}
        />
      )}
    </main>
  );
}
