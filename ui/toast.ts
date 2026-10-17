import type { Tone } from "./index";

let stack: HTMLElement | undefined;

/** Shows `message` above everything (dialogs included) for `ms`, then removes it. */
export function toast(message: string, tone: Tone = "neutral", ms = 4000): void {
  if (!stack?.isConnected) {
    stack = document.createElement("section");
    stack.className = "xz-toasts";
    stack.setAttribute("popover", "manual");
    stack.setAttribute("aria-live", "polite");
    document.body.append(stack);
  }
  const item = document.createElement("div");
  item.className = "xz-toast";
  item.dataset["tone"] = tone;
  item.dataset["depth"] = "3";
  item.setAttribute("role", "status");
  item.textContent = message;
  stack.append(item);
  // Showing again moves the stack to the top of the top layer, above a dialog opened since.
  stack.hidePopover?.();
  stack.showPopover?.();
  const own = stack;
  setTimeout(() => {
    item.remove();
    if (own.childElementCount === 0) own.hidePopover?.();
  }, ms);
}
