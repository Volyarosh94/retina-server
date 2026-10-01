import { useEffect } from "react";

export type ShortcutMap = Record<string, (e: KeyboardEvent) => void>;

/** Controls that take Space or Enter themselves when they hold focus. */
const PRESSABLE = "button, [role='button'], a[href], summary";

/**
 * Wire up a small set of single-key shortcuts.  Ignores events fired while
 * an input/textarea is focused so typing into the search box doesn't
 * accidentally toggle the trail layer, and ignores events when focus is outside
 * the map surface so that console controls (like the header's theme radiogroup)
 * are not interrupted.  Space and Enter on a focused button or link are that
 * control's: Space is also the map's pause, and taking it there paused the
 * feed instead of pressing the button.  A held key fires once, not once per
 * repeat: every binding is a toggle or a one-off.
 */
export function useKeyboardShortcuts(map: ShortcutMap, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          // Allow Escape to bubble even from inputs so users can close the
          // search box with the keyboard.
          if (e.key !== "Escape") return;
        }
      }
      if ((e.key === " " || e.key === "Enter") && target instanceof Element && target.closest(PRESSABLE)) return;
      // Ignore when a modifier is pressed — we don't want to intercept
      // browser shortcuts (Cmd+R, Ctrl+L, …).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A key pressed while something outside the surface holds focus
      // belongs to whatever holds it. With nothing
      // focused the target is the body, which is outside the surface but is
      // nobody else's control, so it still reaches the map.
      const focused = document.activeElement;
      if (focused && focused !== document.body && !focused.closest?.(".map-surface")) return;
      const handler = map[e.key] || map[e.key.toLowerCase()];
      if (handler) {
        handler(e);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [map, enabled]);
}
