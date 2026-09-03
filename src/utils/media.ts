/**
 * Client-side media preferences for the game detail page.
 *
 * Currently just the trailer autoplay flag: when off (the default), opening a
 * game page shows its trailer and screenshots but never starts playback on its
 * own. Consumed by `GameView` as the `MediaSlider` `autoPlay` prop.
 */

const TRAILER_AUTOPLAY_KEY = "gv_trailer_autoplay";

export function isTrailerAutoplayEnabled(): boolean {
  try {
    return localStorage.getItem(TRAILER_AUTOPLAY_KEY) === "1";
  } catch {
    return false; // default OFF
  }
}

export function setTrailerAutoplayEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(TRAILER_AUTOPLAY_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
}
