/**
 * Tiny entry without dependencies, safe to import eagerly in the app shell:
 *
 *   if (hasPendingSession()) (await loadRecorder()).createFeedbackRecorder(opts).restore();
 */
export const PENDING_FLAG = 'agent-feedback:pending';

/** True while a feedback session exists (recording or finished but not handed over yet). */
export function hasPendingSession(): boolean {
  try {
    return !!localStorage.getItem(PENDING_FLAG);
  } catch {
    return false;
  }
}

export const loadRecorder = () => import('./index');
