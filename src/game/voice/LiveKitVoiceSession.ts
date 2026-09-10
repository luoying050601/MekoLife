import type { Room } from "livekit-client";
import type { GameTransport } from "../network/types";

export type LiveKitVoiceUi = {
    joinButton: HTMLButtonElement | null;
    leaveButton: HTMLButtonElement | null;
    muteButton: HTMLButtonElement | null;
    statusText: HTMLSpanElement | null;
    /** If set, called for every status line (e.g. debug panel); still updates statusText when present. */
    onStatusMessage?: (message: string) => void;
};

type Options = {
    transport: GameTransport;
    tokenApiUrl: string;
    getRoomId: () => string;
    getDisplayName: () => string;
    getPeerVolume?: (peerId: string) => number;
    /** Fired when LiveKit reports who is currently speaking (identities = socket ids from JWT). */
    onActiveSpeakersChanged?: (identities: ReadonlySet<string>) => void;
};

export type LiveKitPeerSummary = {
    id: string;
    name: string;
    state: string;
};

function isLiveKitConnected(room: Room | undefined): boolean {
    return room?.state === "connected";
}

function resolveAudioTrackSid(
    publication: { trackSid?: string },
    track: { sid?: string; mediaStreamTrack?: MediaStreamTrack }
): string {
    return publication.trackSid ?? track.sid ?? track.mediaStreamTrack?.id ?? "";
}

export class LiveKitVoiceSession {
    private room: Room | undefined;
    private lk: typeof import("livekit-client") | undefined;
    private readonly remoteAudioBySid = new Map<string, HTMLAudioElement>();
    private readonly remoteAudioByIdentity = new Map<string, HTMLAudioElement[]>();
    private ui: LiveKitVoiceUi = {
        joinButton: null,
        leaveButton: null,
        muteButton: null,
        statusText: null
    };
    private micMuted = true;
    private joining = false;
    private unregisterActiveSpeakers: (() => void) | undefined;

    constructor(private readonly options: Options) {}

    getConnectedPeerSummaries(): LiveKitPeerSummary[] {
        const r = this.room;
        if (!r || !isLiveKitConnected(r)) return [];
        const out: LiveKitPeerSummary[] = [];
        for (const [, p] of r.remoteParticipants) {
            const hasAudio = [...p.audioTrackPublications.values()].some(
                (pub) => pub.isSubscribed && pub.track
            );
            out.push({
                id: p.identity,
                name: p.name || p.identity,
                state: hasAudio ? "audio subscribed" : "in room"
            });
        }
        return out;
    }

    bindUi(ui: LiveKitVoiceUi): void {
        this.ui = ui;
        this.ui.joinButton?.addEventListener("click", () => void this.join());
        this.ui.leaveButton?.addEventListener("click", () => void this.leave());
        this.ui.muteButton?.addEventListener("click", () => void this.toggleMute());
        this.syncUi();
    }

    isConnected(): boolean {
        return isLiveKitConnected(this.room);
    }

    isJoining(): boolean {
        return this.joining;
    }

    getMicMuted(): boolean {
        return this.micMuted;
    }

    setPeerVolume(identity: string, volume: number): void {
        const els = this.remoteAudioByIdentity.get(identity);
        if (!els) return;
        for (const el of els) {
            el.volume = volume;
        }
    }

    /** Re-run button disabled state (used when buttons are wired externally). */
    refreshUi(): void {
        this.syncUi();
    }

    join(): Promise<void> {
        return this.joinVoice();
    }

    leave(): Promise<void> {
        return this.leaveVoice();
    }

    getDiagnostics(): string {
        const r = this.room;
        if (!r || !isLiveKitConnected(r)) {
            return "LiveKit: not connected";
        }
        const lines = [
            `LiveKit: room_state=${r.state}`,
            `local_identity=${r.localParticipant.identity}`,
            `remote_count=${r.remoteParticipants.size}`
        ];
        return lines.join("\n");
    }

    private setStatus(message: string): void {
        this.ui.onStatusMessage?.(message);
        if (this.ui.statusText) {
            this.ui.statusText.textContent = message;
        }
    }

    private syncUi(): void {
        const inRoom = isLiveKitConnected(this.room);
        if (this.ui.joinButton) {
            this.ui.joinButton.disabled = this.joining || inRoom;
        }
        if (this.ui.leaveButton) {
            this.ui.leaveButton.disabled = !inRoom;
        }
        if (this.ui.muteButton) {
            this.ui.muteButton.disabled = false;
            this.ui.muteButton.textContent = this.micMuted ? "ミュート解除" : "ミュート";
        }
    }

    private async loadLiveKit(): Promise<typeof import("livekit-client")> {
        if (!this.lk) {
            this.lk = await import("livekit-client");
        }
        return this.lk;
    }

    private async joinVoice(): Promise<void> {
        if (this.joining) return;
        if (isLiveKitConnected(this.room)) {
            await this.leaveVoice();
        }

        const identity = this.options.transport.getSocketId();
        if (!identity) {
            this.setStatus("ソケット未接続");
            return;
        }

        this.joining = true;
        this.syncUi();
        this.setStatus("音声トークンを取得中...");

        try {
            const res = await fetch(this.options.tokenApiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    roomId: this.options.getRoomId(),
                    identity,
                    displayName: this.options.getDisplayName()
                })
            });

            const data = (await res.json().catch(() => ({}))) as {
                error?: string;
                token?: string;
                url?: string;
            };

            if (!res.ok) {
                if (data.error === "livekit_not_configured") {
                    this.setStatus("音声: サーバーに LIVEKIT_* を設定してください");
                } else {
                    this.setStatus(`音声エラー (${res.status})`);
                }
                return;
            }

            if (!data.token || !data.url) {
                this.setStatus("音声: トークン応答が不正です");
                return;
            }

            const lk = await this.loadLiveKit();
            const { Room: LkRoom, RoomEvent, Track } = lk;

            const room = new LkRoom({ adaptiveStream: true, dynacast: true });
            this.room = room;

            room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
                if (track.kind !== Track.Kind.Audio) return;
                const sid = resolveAudioTrackSid(publication, track) || `lk-audio-${Date.now()}`;
                const el = track.attach() as HTMLAudioElement;
                el.dataset.lkSid = sid;
                el.dataset.lkIdentity = participant.identity;
                el.volume = this.options.getPeerVolume?.(participant.identity) ?? 1;
                document.body.appendChild(el);
                void el.play().catch(() => {
                    // Autoplay blocked until user gesture; Join click usually suffices.
                });
                this.remoteAudioBySid.set(sid, el);
                const byIdentity = this.remoteAudioByIdentity.get(participant.identity) ?? [];
                byIdentity.push(el);
                this.remoteAudioByIdentity.set(participant.identity, byIdentity);
            });

            room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
                if (track.kind !== Track.Kind.Audio) return;
                const sid = resolveAudioTrackSid(publication, track);
                if (!sid) return;
                const el = this.remoteAudioBySid.get(sid);
                if (el) {
                    track.detach(el);
                    el.remove();
                    this.remoteAudioBySid.delete(sid);
                    const list = this.remoteAudioByIdentity.get(participant.identity);
                    if (list) {
                        const next = list.filter((a) => a !== el);
                        if (next.length) {
                            this.remoteAudioByIdentity.set(participant.identity, next);
                        } else {
                            this.remoteAudioByIdentity.delete(participant.identity);
                        }
                    }
                }
            });

            room.on(RoomEvent.Disconnected, () => {
                if (this.room !== room) return;
                this.unregisterActiveSpeakers?.();
                this.unregisterActiveSpeakers = undefined;
                this.options.onActiveSpeakersChanged?.(new Set());
                this.room = undefined;
                this.clearRemoteAudio();
                this.setStatus("音声待機中");
                this.syncUi();
            });

            await room.connect(data.url, data.token);

            const onSpeakers = (speakers: { identity: string }[]) => {
                this.options.onActiveSpeakersChanged?.(new Set(speakers.map((s) => s.identity)));
            };
            room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
            this.unregisterActiveSpeakers = () => {
                room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
            };

            await room.startAudio().catch(() => undefined);
            await this.applyMicrophoneEnabled();
            this.setStatus(
                this.micMuted
                    ? "音声接続済み（LiveKit・マイクオフ）"
                    : "音声接続済み（LiveKit）"
            );
        } catch (e) {
            this.setStatus(e instanceof Error ? `音声: ${e.message}` : "音声に失敗しました");
            await this.leaveVoice();
        } finally {
            this.joining = false;
            this.syncUi();
        }
    }

    async toggleMute(): Promise<void> {
        await this.setMicMuted(!this.micMuted);
    }

    async setMicMuted(muted: boolean): Promise<void> {
        this.micMuted = muted;
        await this.applyMicrophoneEnabled();
        this.syncUi();
    }

    private async applyMicrophoneEnabled(): Promise<void> {
        const room = this.room;
        if (!room || !isLiveKitConnected(room)) return;
        await room.localParticipant.setMicrophoneEnabled(!this.micMuted);
    }

    private clearRemoteAudio(): void {
        for (const [, el] of this.remoteAudioBySid) {
            el.remove();
        }
        this.remoteAudioBySid.clear();
        this.remoteAudioByIdentity.clear();
    }

    private async leaveVoice(): Promise<void> {
        const room = this.room;
        if (!room) {
            this.syncUi();
            return;
        }
        this.unregisterActiveSpeakers?.();
        this.unregisterActiveSpeakers = undefined;
        this.options.onActiveSpeakersChanged?.(new Set());
        this.room = undefined;
        try {
            await room.disconnect(true);
        } catch {
            // ignore
        }
        this.clearRemoteAudio();
        this.setStatus("音声待機中");
        this.syncUi();
    }

    dispose(): void {
        void this.leaveVoice();
    }
}
