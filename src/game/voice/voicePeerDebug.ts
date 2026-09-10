import type { VoiceBackend } from "./voiceConstants";

export type VoiceConnectedPeer = {
    id: string;
    name: string;
    link: "webrtc" | "livekit";
    /** Short state, e.g. connected / ice=checking */
    state: string;
};

const LINK_LABEL_JA: Record<VoiceConnectedPeer["link"], string> = {
    webrtc: "WebRTC",
    livekit: "LiveKit"
};

function formatPeerLabelJa(p: VoiceConnectedPeer): string {
    return `${p.name}（${LINK_LABEL_JA[p.link]}）`;
}

/** Debug log lines (Japanese), e.g. 部屋に太郎（WebRTC）、花子（WebRTC）がいる */
export function formatVoicePeersSnapshot(
    backend: VoiceBackend,
    peers: readonly VoiceConnectedPeer[]
): string {
    const lines: string[] = [];

    if (backend === "none") {
        lines.push("部屋に音声で接続している人はいません");
        return lines.join("\n");
    }

    if (peers.length === 0) {
        lines.push("部屋に音声で接続している人はまだいません");
        return lines.join("\n");
    }

    const names = peers.map(formatPeerLabelJa).join("、");
    lines.push(`部屋に${names}がいる`);

    return lines.join("\n");
}
