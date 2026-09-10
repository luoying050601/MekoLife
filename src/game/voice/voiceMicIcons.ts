/** Inline SVGs for #voice-mute; uses currentColor (inherits button text color). */
const SVG_ATTR =
    'xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="voice-mute-icon" aria-hidden="true" focusable="false"';

/** Microphone on (unmuted, in voice). */
const MIC_ON = `<svg ${SVG_ATTR}><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;

/** Muted or not connected: same mic + diagonal strike. */
const MIC_SLASH = `<svg ${SVG_ATTR}><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

export function getVoiceMicButtonInnerHtml(showSlash: boolean): string {
    return showSlash ? MIC_SLASH : MIC_ON;
}
