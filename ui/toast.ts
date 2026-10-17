import type { Tone } from "./index";

let stack: HTMLElement | undefined;
let shown = false;

/** Shows `message` above everything (dialogs included) for `ms`, then removes it. */
export function toast(message: string, tone: Tone = "neutral", ms = 4000): void {
  if (!stack?.isConnected) {
    stack = document.createElement("section");
    stack.className = "xz-toasts";
    stack.setAttribute("popover", "manual");
    stack.setAttribute("aria-live", "polite");
    document.body.append(stack);
    shown = false;
  }
  const item = document.createElement("div");
  item.className = "xz-toast";
  item.dataset["tone"] = tone;
  item.dataset["depth"] = "3";
  item.setAttribute("role", "status");
  item.textContent = message;
  stack.append(item);
  // Showing again lifts the stack above a dialog opened since; otherwise the visible toasts stay put.
  if (shown && document.querySelector("dialog[open]")) {
    stack.hidePopover?.();
    shown = false;
  }
  if (!shown) {
    stack.showPopover?.();
    shown = true;
  }
  const own = stack;
  setTimeout(() => {
    item.remove();
    if (own.childElementCount === 0 && own === stack) {
      own.hidePopover?.();
      shown = false;
    }
  }, ms);
}
