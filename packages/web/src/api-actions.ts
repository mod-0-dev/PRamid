import { showToast } from "./toast"

export type ActionResponse =
  | { ok: true; [key: string]: unknown }
  | { ok: false; conflict?: { branch: string; files: string[] }; error?: string }

/**
 * Disables the button and sets a pending label while awaiting a POST to the
 * given endpoint. Restores button state in a finally block and surfaces network
 * errors via toast. Calls onResult with the parsed JSON response.
 */
export async function postAction<T>(
  endpoint: string,
  body: Record<string, unknown>,
  btn: HTMLButtonElement,
  pendingLabel: string,
  onResult: (data: T) => void,
): Promise<void> {
  const restoreLabel = btn.textContent ?? ""
  btn.disabled = true
  btn.textContent = pendingLabel
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    onResult((await res.json()) as T)
  } catch {
    showToast("Network error — could not reach the server", "error")
  } finally {
    btn.disabled = false
    btn.textContent = restoreLabel
  }
}

/** Shows a conflict or generic API error as a toast. */
export function handleConflict(
  data: { conflict?: { branch: string; files: string[] }; error?: string },
  failedPrefix: string,
): void {
  if (data.conflict) {
    showToast(`Conflict in ${data.conflict.branch}: ${data.conflict.files.join(", ")}`, "error")
  } else {
    showToast(`${failedPrefix}: ${data.error ?? "unknown error"}`, "error")
  }
}
