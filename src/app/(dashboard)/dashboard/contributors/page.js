"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card } from "@/shared/components";
import { OAUTH_PROVIDERS } from "@/shared/constants/providers";

const DEFAULT_PROVIDERS = ["claude", "codex"];

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function ContributorsAdminPage() {
  const providerOptions = useMemo(
    () => Object.entries(OAUTH_PROVIDERS).filter(([, provider]) => !provider.hidden),
    [],
  );
  const [selected, setSelected] = useState(DEFAULT_PROVIDERS);
  const [expiresInMinutes, setExpiresInMinutes] = useState(30);
  const [invites, setInvites] = useState([]);
  const [createdUrl, setCreatedUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const loadInvites = useCallback(async () => {
    const response = await fetch("/api/contributor-admin/invites", { cache: "no-store" });
    const data = await response.json();
    if (response.ok) setInvites(data.invites || []);
  }, []);

  useEffect(() => {
    loadInvites();
  }, [loadInvites]);

  const toggleProvider = (id) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  };

  const createInvite = async () => {
    setLoading(true);
    setError("");
    setCreatedUrl("");
    try {
      const response = await fetch("/api/contributor-admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowedProviders: selected, expiresInMinutes }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to create invite");
      setCreatedUrl(data.url);
      await loadInvites();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const copyUrl = async () => {
    await navigator.clipboard.writeText(createdUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const revoke = async (id) => {
    await fetch(`/api/contributor-admin/invites?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadInvites();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-main">Contributors</h1>
        <p className="mt-1 text-sm text-text-muted">Create scoped, one-time links for people contributing OAuth accounts.</p>
      </div>

      <Card title="Create contribution link" subtitle="The link closes after the first successful OAuth connection." icon="person_add">
        <div className="space-y-5">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-main">Allowed providers</label>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {providerOptions.map(([id, provider]) => (
                <label key={id} className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-border bg-bg px-3 py-2.5 text-sm text-text-main">
                  <input
                    type="checkbox"
                    checked={selected.includes(id)}
                    onChange={() => toggleProvider(id)}
                    className="h-4 w-4 accent-[var(--color-brand-500)]"
                  />
                  <span className="material-symbols-outlined text-[19px]" style={{ color: provider.color }}>
                    {provider.icon || "smart_toy"}
                  </span>
                  <span>{provider.name || id}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="max-w-xs">
            <label className="mb-2 block text-sm font-medium text-text-main">Expires after</label>
            <select
              value={expiresInMinutes}
              onChange={(event) => setExpiresInMinutes(Number(event.target.value))}
              className="h-9 w-full rounded-[10px] border border-border bg-surface px-3 text-sm text-text-main"
            >
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={240}>4 hours</option>
              <option value={1440}>24 hours</option>
            </select>
          </div>

          <Button icon="link" loading={loading} disabled={selected.length === 0} onClick={createInvite}>
            Create one-time link
          </Button>

          {error && <p className="text-sm text-red-500">{error}</p>}
          {createdUrl && (
            <div className="rounded-[10px] border border-green-500/30 bg-green-500/5 p-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-green-600">Copy this link now</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input readOnly value={createdUrl} className="h-9 min-w-0 flex-1 rounded-[8px] border border-border bg-surface px-3 text-sm text-text-main" />
                <Button size="sm" variant="secondary" icon="content_copy" onClick={copyUrl}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="mt-2 text-xs text-text-muted">The secret is never stored in plaintext and cannot be displayed again.</p>
            </div>
          )}
        </div>
      </Card>

      <Card title="Recent links" icon="history">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2">Providers</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Expires / Used</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => (
                <tr key={invite.id} className="border-b border-border-subtle last:border-0">
                  <td className="px-3 py-3 text-text-main">{formatDate(invite.createdAt)}</td>
                  <td className="px-3 py-3 text-text-muted">{invite.allowedProviders.join(", ")}</td>
                  <td className="px-3 py-3 capitalize text-text-main">{invite.status}</td>
                  <td className="px-3 py-3 text-text-muted">{formatDate(invite.usedAt || invite.expiresAt)}</td>
                  <td className="px-3 py-3 text-right">
                    {invite.status === "active" && (
                      <Button size="sm" variant="ghost" onClick={() => revoke(invite.id)}>Revoke</Button>
                    )}
                  </td>
                </tr>
              ))}
              {invites.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-8 text-center text-text-muted">No contribution links yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
