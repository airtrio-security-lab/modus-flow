/**
 * Unsent submission draft, kept on this device only (per-viewer convenience).
 * Cleared after a successful submission or by «Начать заново».
 */
const KEY = 'modus.draft.v1';
export interface Draft {
  kind: 'problem' | 'idea';
  title: string;
  problem: string;
  proposal: string;
  criteria: string;
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (d.kind !== 'problem' && d.kind !== 'idea') return null;
    return { kind: d.kind, title: String(d.title ?? ''), problem: String(d.problem ?? ''), proposal: String(d.proposal ?? ''), criteria: String(d.criteria ?? '') };
  } catch {
    return null;
  }
}

export function saveDraft(d: Draft) {
  try {
    if (!d.title.trim() && !d.problem.trim() && !d.proposal.trim() && !d.criteria.trim()) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* storage unavailable: the form still works, just without a draft */
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
