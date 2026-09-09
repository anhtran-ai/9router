"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function TokenExchangeClient({ token }) {
  const router = useRouter();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/contribute/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to open contribution link");
        if (active) router.replace("/contribute");
      })
      .catch((err) => active && setError(err.message));
    return () => {
      active = false;
    };
  }, [router, token]);

  return (
    <main className="min-h-screen bg-bg flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-[14px] border border-border bg-surface p-8 text-center shadow-[var(--shadow-elev)]">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500/10 text-brand-500">
          <span className="material-symbols-outlined text-[28px]">key</span>
        </div>
        <h1 className="text-xl font-semibold text-text-main">Opening contribution portal</h1>
        {error ? (
          <p className="mt-3 text-sm text-red-500">{error}</p>
        ) : (
          <p className="mt-3 text-sm text-text-muted">Validating your one-time link…</p>
        )}
      </div>
    </main>
  );
}
