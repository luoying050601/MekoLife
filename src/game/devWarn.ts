/** Logs WebRTC / media failures in development only (production stays silent). */
export function devWarn(scope: string, err: unknown): void {
    if (!import.meta.env.DEV) return;
    console.warn(`[YmetaLife:${scope}]`, err);
}
