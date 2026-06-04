import { create } from "zustand";

/** Status of the most recent CSV import (drives the small status line). */
export type ImportPhase = "idle" | "uploading" | "polling" | "done" | "failed";

export interface ImportStatus {
  phase: ImportPhase;
  jobId: string | null;
  rowsImported: number;
  rowsSkipped: number;
  rowsTotal: number;
  /** Human-readable error, set when phase is "failed". */
  error: string | null;
}

interface AppState {
  /** Conversation id sent in the `/ai/chat` body. Stable per browser session. */
  conversationId: string;
  importStatus: ImportStatus;
  setImportStatus: (next: Partial<ImportStatus>) => void;
  resetImportStatus: () => void;
}

const initialImportStatus: ImportStatus = {
  phase: "idle",
  jobId: null,
  rowsImported: 0,
  rowsSkipped: 0,
  rowsTotal: 0,
  error: null,
};

/** Generate a conversation id once per page load. */
function makeConversationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const useAppStore = create<AppState>((set) => ({
  conversationId: makeConversationId(),
  importStatus: initialImportStatus,
  setImportStatus: (next) =>
    set((state) => ({ importStatus: { ...state.importStatus, ...next } })),
  resetImportStatus: () => set({ importStatus: initialImportStatus }),
}));
