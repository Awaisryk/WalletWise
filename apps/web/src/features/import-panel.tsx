import { useRef, useState } from "react";
import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAppStore } from "@/store/app.store";

interface ImportJobResult {
  status: string;
  rowsTotal: number;
  rowsImported: number;
  rowsSkipped: number;
  report: unknown;
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * CSV import. Reads the chosen file as text, POSTs it to `/import/csv` (the
 * body is `{ csv }`), then polls `GET /import/:jobId` once a second until the
 * job is `done`/`failed`. All requests use `credentials: "include"` so the
 * SuperTokens session cookie rides along (the Vite proxy keeps them
 * same-origin in dev, but we're explicit).
 */
export function ImportPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const { importStatus, setImportStatus, resetImportStatus } = useAppStore();
  const busy = importStatus.phase === "uploading" || importStatus.phase === "polling";

  async function pollUntilDone(jobId: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const res = await fetch(`/import/${jobId}`, { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Status check failed (${res.status})`);
      }
      const job = (await res.json()) as ImportJobResult;
      if (job.status === "done") {
        setImportStatus({
          phase: "done",
          rowsImported: job.rowsImported,
          rowsSkipped: job.rowsSkipped,
          rowsTotal: job.rowsTotal,
        });
        return;
      }
      if (job.status === "failed") {
        setImportStatus({
          phase: "failed",
          rowsImported: job.rowsImported,
          rowsSkipped: job.rowsSkipped,
          rowsTotal: job.rowsTotal,
          error: "Import failed. Check the file and try again.",
        });
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    setImportStatus({ phase: "failed", error: "Import timed out." });
  }

  async function handleImport() {
    if (!file) return;
    resetImportStatus();
    setImportStatus({ phase: "uploading" });
    try {
      const csv = await file.text();
      const res = await fetch("/import/csv", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      if (!res.ok) {
        throw new Error(`Upload failed (${res.status})`);
      }
      const { jobId } = (await res.json()) as { jobId: string };
      setImportStatus({ phase: "polling", jobId });
      await pollUntilDone(jobId);
    } catch (err) {
      setImportStatus({
        phase: "failed",
        error: err instanceof Error ? err.message : "Import failed.",
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Upload className="h-4 w-4" /> Import transactions
        </CardTitle>
        <CardDescription>
          Upload a bank CSV to populate your transactions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={busy}
          />
          <Button onClick={handleImport} disabled={!file || busy} size="sm">
            {busy ? "Importing…" : "Import"}
          </Button>
        </div>
        <ImportStatusLine />
      </CardContent>
    </Card>
  );
}

function ImportStatusLine() {
  const { phase, rowsImported, rowsSkipped, error } = useAppStore(
    (s) => s.importStatus,
  );

  if (phase === "idle") return null;
  if (phase === "uploading") {
    return <p className="text-sm text-muted-foreground">Uploading…</p>;
  }
  if (phase === "polling") {
    return <p className="text-sm text-muted-foreground">Processing…</p>;
  }
  if (phase === "failed") {
    return <p className="text-sm text-destructive">{error ?? "Import failed."}</p>;
  }
  // done
  return (
    <p className="text-sm text-muted-foreground">
      Imported {rowsImported}, skipped {rowsSkipped}.
    </p>
  );
}
