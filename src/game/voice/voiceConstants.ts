export type VoiceBackend = "none" | "webrtc" | "livekit";

/** Inclusive upper bound for WebRTC mesh (self + remotes). Kept for unused mesh cap/debug. */
export const VOICE_WEBRTC_MAX_PARTICIPANTS = 4;

/** Inclusive lower bound for LiveKit SFU (self + remotes). Kept for unused mesh code. */
export const VOICE_LIVEKIT_MIN_PARTICIPANTS = VOICE_WEBRTC_MAX_PARTICIPANTS + 1;

/** Auto-mute after this long with no speech or movement while mic is on. */
export const MIC_IDLE_MS = 3 * 60 * 1000;

/** Corridor / outside rooms: start a WebRTC link at or inside this distance. */
export const PROXIMITY_VOICE_CONNECT_PX = 150;

/** Corridor / outside rooms: drop the WebRTC link beyond this distance (hysteresis). */
export const PROXIMITY_VOICE_DROP_PX = 190;

/** Rooms use LiveKit; corridor uses proximity WebRTC. */
export function shouldUseLiveKitForParticipantCount(_participantCount: number): boolean {
    return true;
}

/** Short debug line to confirm active switching policy. */
export function getVoiceBackendPolicySummary(): string {
    return "voice_policy=room_livekit_corridor_webrtc";
}
