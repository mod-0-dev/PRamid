type ToastType = "success" | "error" | "info"

export function showToast(message: string, type: ToastType = "info"): void {
  const container = document.getElementById("toast-container") as HTMLElement
  const toast = document.createElement("div")
  toast.className = `toast toast-${type}`
  toast.textContent = message

  container.appendChild(toast)

  // Animate in
  requestAnimationFrame(() => toast.classList.add("visible"))

  // Remove after 4 s
  setTimeout(() => {
    toast.classList.remove("visible")
    toast.addEventListener("transitionend", () => toast.remove(), { once: true })
  }, 4000)
}
