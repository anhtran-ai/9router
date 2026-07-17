"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, Modal } from "@/shared/components";

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function comboItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.combos)) return payload.combos;
  if (Array.isArray(payload?.items)) return payload.items;
  return null;
}

function exportFilename() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `9router-combos-${stamp}.json`;
}

function actionClasses(action) {
  if (action === "created") return "bg-green-500/10 text-green-600 dark:text-green-400";
  if (action === "updated") return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
  if (action === "failed") return "bg-red-500/10 text-red-600 dark:text-red-400";
  return "bg-amber-500/10 text-amber-600 dark:text-amber-400";
}

function StatusPanel({ status }) {
  if (!status) return null;
  const isError = status.type === "error";
  const isSuccess = status.type === "success";
  const borderClass = isError
    ? "border-red-500/30 bg-red-500/5"
    : isSuccess
      ? "border-green-500/30 bg-green-500/5"
      : "border-blue-500/30 bg-blue-500/5";
  const icon = isError ? "error" : isSuccess ? "check_circle" : "info";

  return (
    <div className={`rounded-[10px] border p-4 ${borderClass}`}>
      <div className="flex items-start gap-3">
        <span className="material-symbols-outlined mt-0.5 text-[20px]">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <p className="font-medium text-text-main">{status.title}</p>
            <span className="text-xs text-text-muted">{status.time}</span>
          </div>
          <p className="mt-1 text-sm text-text-muted">{status.message}</p>
        </div>
      </div>

      {status.summary && (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            ["Total", status.summary.total],
            ["Created", status.summary.created],
            ["Updated", status.summary.updated],
            ["Skipped", status.summary.skipped],
            ["Failed", status.summary.failed],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-surface px-3 py-2">
              <p className="text-xs text-text-muted">{label}</p>
              <p className="mt-0.5 text-lg font-semibold text-text-main">{value}</p>
            </div>
          ))}
        </div>
      )}

      {status.results?.length > 0 && (
        <div className="mt-4 max-h-64 overflow-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="sticky top-0 border-b border-border bg-surface text-xs uppercase text-text-muted">
              <tr>
                <th className="px-3 py-2">Combo</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {status.results.map((result, index) => (
                <tr key={`${result.name}-${index}`} className="border-b border-border-subtle last:border-0">
                  <td className="px-3 py-2 font-mono text-text-main">{result.name}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${actionClasses(result.action)}`}>
                      {result.action}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-text-muted">{result.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ExportCombosModal({
  isOpen,
  combos,
  selectedNames,
  onSelectedNamesChange,
  onClose,
  onExport,
  exporting,
}) {
  const selectAllRef = useRef(null);
  const selectedCount = combos.filter((combo) => selectedNames.has(combo.name)).length;
  const allSelected = combos.length > 0 && selectedCount === combos.length;
  const someSelected = selectedCount > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const toggleAll = () => {
    onSelectedNamesChange(new Set(allSelected ? [] : combos.map((combo) => combo.name)));
  };

  const toggleCombo = (name) => {
    const next = new Set(selectedNames);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onSelectedNamesChange(next);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Export Combos" size="lg">
      <div className="space-y-4">
        <div>
          <p className="text-sm text-text-muted">
            Choose the Combo items to include in the JSON file. All items are selected by default.
          </p>
          <p className="mt-1 text-xs text-text-muted">
            Only Combo definitions and routing strategies are exported.
          </p>
        </div>

        <div className="overflow-hidden rounded-[10px] border border-border">
          <label className="flex cursor-pointer items-center gap-3 border-b border-border bg-surface-2 px-3 py-2.5">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="size-4 shrink-0 cursor-pointer accent-primary"
            />
            <span className="flex-1 text-sm font-medium text-text-main">Select all</span>
            <span className="text-xs text-text-muted">{selectedCount} / {combos.length} selected</span>
          </label>

          <div className="max-h-[340px] overflow-y-auto custom-scrollbar">
            {combos.map((combo) => (
              <label
                key={combo.id || combo.name}
                className="flex cursor-pointer items-center gap-3 border-b border-border-subtle px-3 py-2.5 transition-colors last:border-0 hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={selectedNames.has(combo.name)}
                  onChange={() => toggleCombo(combo.name)}
                  className="size-4 shrink-0 cursor-pointer accent-primary"
                />
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <span className="material-symbols-outlined text-[17px]">layers</span>
                </span>
                <span className="min-w-0 flex-1">
                  <code className="block truncate font-mono text-sm font-medium text-text-main">{combo.name}</code>
                  <span className="text-xs text-text-muted">
                    {combo.models?.length || 0} model(s) · {combo.kind || "llm"}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-1 sm:flex-row">
          <Button variant="ghost" fullWidth onClick={onClose} disabled={exporting}>
            Cancel
          </Button>
          <Button
            fullWidth
            icon="download"
            loading={exporting}
            disabled={selectedCount === 0}
            onClick={onExport}
          >
            Export selected ({selectedCount})
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function ImportExportPage() {
  const fileRef = useRef(null);
  const [combos, setCombos] = useState([]);
  const [combosLoading, setCombosLoading] = useState(true);
  const [showExportModal, setShowExportModal] = useState(false);
  const [selectedComboNames, setSelectedComboNames] = useState(new Set());
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importPayload, setImportPayload] = useState(null);
  const [conflictPolicy, setConflictPolicy] = useState("update");
  const [status, setStatus] = useState(null);

  const loadCombos = useCallback(async () => {
    try {
      const response = await fetch("/api/combos", { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setCombos(data.combos || []);
    } finally {
      setCombosLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCombos();
  }, [loadCombos]);

  const openExportModal = () => {
    setSelectedComboNames(new Set(combos.map((combo) => combo.name)));
    setShowExportModal(true);
  };

  const handleExport = async () => {
    if (selectedComboNames.size === 0) return;
    setExporting(true);
    setStatus(null);
    try {
      const response = await fetch("/api/import-export/combos", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to export combos");
      const selectedCombos = data.combos.filter((combo) => selectedComboNames.has(combo.name));
      if (selectedCombos.length === 0) throw new Error("None of the selected Combos are still available");
      const exportData = { ...data, combos: selectedCombos };
      const filename = exportFilename();
      const blob = new Blob([`${JSON.stringify(exportData, null, 2)}\n`], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setShowExportModal(false);
      setStatus({
        type: "success",
        title: "Combo export completed",
        message: `Exported ${selectedCombos.length} combo item(s) to ${filename}.`,
        time: new Date().toLocaleString(),
      });
    } catch (error) {
      setStatus({
        type: "error",
        title: "Combo export failed",
        message: error.message,
        time: new Date().toLocaleString(),
      });
    } finally {
      setExporting(false);
    }
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    setImportFile(null);
    setImportPayload(null);
    if (!file) return;
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("Import file must be 2 MB or smaller");
      const parsed = JSON.parse(await file.text());
      const items = comboItems(parsed);
      if (!items) throw new Error("The JSON file does not contain a combos array");
      if (items.length === 0) throw new Error("The JSON file contains no combo items");
      setImportFile({ name: file.name, count: items.length, size: file.size });
      setImportPayload(parsed);
      setStatus({
        type: "info",
        title: "Combo import ready",
        message: `${file.name} contains ${items.length} combo item(s). Choose a conflict policy, then start the import.`,
        time: new Date().toLocaleString(),
      });
    } catch (error) {
      if (fileRef.current) fileRef.current.value = "";
      setStatus({
        type: "error",
        title: "Import file rejected",
        message: error.message,
        time: new Date().toLocaleString(),
      });
    }
  };

  const handleImport = async () => {
    if (!importPayload) return;
    setImporting(true);
    setStatus(null);
    try {
      const response = await fetch("/api/import-export/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: importPayload, conflictPolicy }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to import combos");
      const { summary } = data;
      setStatus({
        type: summary.failed > 0 ? "info" : "success",
        title: summary.failed > 0 ? "Combo import completed with errors" : "Combo import completed",
        message: `${summary.created} created, ${summary.updated} updated, ${summary.skipped} skipped, ${summary.failed} failed.`,
        time: new Date().toLocaleString(),
        summary,
        results: data.results || [],
      });
      await loadCombos();
    } catch (error) {
      setStatus({
        type: "error",
        title: "Combo import failed",
        message: error.message,
        time: new Date().toLocaleString(),
      });
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card
        title="Combos"
        subtitle="Transfer combo definitions and their routing strategy without exporting the rest of the database."
        icon="layers"
      >
        <div className="space-y-5">
          <div className="rounded-[10px] border border-blue-500/25 bg-blue-500/5 p-4 text-sm text-text-muted">
            <div className="flex items-start gap-2">
              <span className="material-symbols-outlined text-[19px] text-blue-500">info</span>
              <div className="space-y-1">
                <p className="font-medium text-text-main">Combo-only transfer</p>
                <p>Exports name, type, ordered models, fallback strategy and Fusion judge model.</p>
                <p>Provider connections, OAuth tokens, API keys and other settings are never included or changed.</p>
                <p>Imports match existing combos by name. Export a backup first before choosing Update existing.</p>
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-[12px] border border-border bg-bg p-4">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <span className="material-symbols-outlined text-[20px]">download</span>
                </div>
                <div>
                  <h3 className="font-medium text-text-main">Export Combos</h3>
                  <p className="mt-1 text-sm text-text-muted">
                    {combosLoading ? "Counting combo items..." : `${combos.length} combo item(s) currently available.`}
                  </p>
                </div>
              </div>
              <Button
                className="mt-5 w-full sm:w-auto"
                icon="download"
                disabled={combosLoading || combos.length === 0}
                onClick={openExportModal}
              >
                Export Combos
              </Button>
            </section>

            <section className="rounded-[12px] border border-border bg-bg p-4">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <span className="material-symbols-outlined text-[20px]">upload</span>
                </div>
                <div>
                  <h3 className="font-medium text-text-main">Import Combos</h3>
                  <p className="mt-1 text-sm text-text-muted">Choose a Combo export JSON file up to 2 MB.</p>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={handleFile}
                  className="block w-full text-sm text-text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:font-medium file:text-primary hover:file:bg-primary/15"
                />
                {importFile && (
                  <p className="text-xs text-text-muted">
                    Selected: <span className="font-medium text-text-main">{importFile.name}</span> · {importFile.count} item(s)
                  </p>
                )}
                <div>
                  <label htmlFor="combo-conflict-policy" className="mb-1.5 block text-xs font-medium text-text-main">
                    Existing combo with the same name
                  </label>
                  <select
                    id="combo-conflict-policy"
                    value={conflictPolicy}
                    onChange={(event) => setConflictPolicy(event.target.value)}
                    className="h-9 w-full rounded-[10px] border border-border bg-surface px-3 text-sm text-text-main"
                  >
                    <option value="update">Update definition and strategy</option>
                    <option value="skip">Skip existing combo</option>
                  </select>
                </div>
                <Button
                  className="w-full sm:w-auto"
                  icon="upload"
                  loading={importing}
                  disabled={!importPayload}
                  onClick={handleImport}
                >
                  Import Combos
                </Button>
              </div>
            </section>
          </div>

          <StatusPanel status={status} />
        </div>
      </Card>

      <ExportCombosModal
        isOpen={showExportModal}
        combos={combos}
        selectedNames={selectedComboNames}
        onSelectedNamesChange={setSelectedComboNames}
        onClose={() => setShowExportModal(false)}
        onExport={handleExport}
        exporting={exporting}
      />
    </div>
  );
}
