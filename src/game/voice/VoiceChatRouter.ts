import type { GameTransport } from "../network/types";
import { LiveKitVoiceSession } from "./LiveKitVoiceSession";
import { MIC_IDLE_MS, type VoiceBackend } from "./voiceConstants";
import {
    formatVoicePeersSnapshot,
    type VoiceConnectedPeer
} from "./voicePeerDebug";
import { VoiceSpeakingMonitor } from "./VoiceSpeakingMonitor";
import { LocalMutedMicMonitor } from "./LocalMutedMicMonitor";
import { WebRtcMeshVoiceSession } from "./WebRtcMeshVoiceSession";
import { getVoiceMicButtonInnerHtml } from "./voiceMicIcons";

/** Bottom bar: mute only (voice status text is queryable via debug `voice` / `vstatus`). */
export type VoiceBarUi = {
    muteButton: HTMLButtonElement | null;
};

export type { VoiceBackend } from "./voiceConstants";

type RouterOptions = {
    transport: GameTransport;
    tokenApiUrl: string;
    getRoomId: () => string;
    getDisplayName: () => string;
    getParticipantCount: () => number;
    getRemotePlayerIds: () => string[];
    getPlayerNameForId?: (playerId: string) => string;
    onSpeakingPeersChanged?: (speakingSocketIds: ReadonlySet<string>) => void;
    onMicOffSpeakingChanged?: (peerIds: ReadonlySet<string>) => void;
};

export class VoiceChatRouter {
    private readonly speakingMonitor: VoiceSpeakingMonitor;
    private readonly liveKit: LiveKitVoiceSession;
    private readonly mesh: WebRtcMeshVoiceSession;
    private voiceBar: VoiceBarUi = { muteButton: null };
    /** Last human-readable line from mesh / LiveKit (for debug `voice` / `vstatus`). */
    private lastVoiceStatusMessage = "音声待機中";
    private backend: VoiceBackend = "none";
    private routerJoining = false;
    /** True while leaving and rejoining LiveKit (tile-room change). */
    private switchingBackend = false;
    /** Queued reconnect if the player crossed another room boundary mid-switch. */
    private needsVoiceReconnect = false;
    private readonly peerVolumes = new Map<string, number>();
    private readonly peerMicMuted = new Map<string, boolean>();
    private readonly remoteMicOffSpeaking = new Set<string>();
    private lastSpeakingIds = new Set<string>();
    private localMutedMicSpeaking = false;
    private lastSentMicOffSpeaking = false;
    private readonly localMutedMicMonitor: LocalMutedMicMonitor;
    private micIdleTimer = 0;
    private lastMicActivityNoteAt = 0;

    constructor(private readonly options: RouterOptions) {
        const getPeerVolume = (peerId: string): number => this.peerVolumes.get(peerId) ?? 1;

        this.localMutedMicMonitor = new LocalMutedMicMonitor(
            () => this.getMicMuted(),
            (speaking) => {
                this.localMutedMicSpeaking = speaking;
                this.emitMicOffSpeakingStates();
            }
        );

        this.speakingMonitor = new VoiceSpeakingMonitor(0.045, (ids) => {
            if (this.mesh.isActive()) {
                this.lastSpeakingIds = new Set(ids);
                this.options.onSpeakingPeersChanged?.(ids);
                this.emitMicOffSpeakingStates();
            }
        });

        this.liveKit = new LiveKitVoiceSession({
            transport: options.transport,
            tokenApiUrl: options.tokenApiUrl,
            getRoomId: options.getRoomId,
            getDisplayName: options.getDisplayName,
            getPeerVolume,
            onActiveSpeakersChanged: (identities) => this.forwardLiveKitSpeakers(identities)
        });

        this.mesh = new WebRtcMeshVoiceSession({
            transport: options.transport,
            getLocalId: () => options.transport.getSocketId(),
            getRemoteIds: () => options.getRemotePlayerIds(),
            getPeerVolume,
            setStatus: (msg) => this.setStatusLine(msg),
            speakingMonitor: this.speakingMonitor
        });
    }

    getPeerVolume(peerId: string): number {
        return this.peerVolumes.get(peerId) ?? 1;
    }

    setPeerVolume(peerId: string, volume: number): void {
        const clamped = Math.max(0, Math.min(1, volume));
        this.peerVolumes.set(peerId, clamped);
        this.mesh.setPeerVolume(peerId, clamped);
        this.liveKit.setPeerVolume(peerId, clamped);
    }

    getPeerMicMuted(peerId: string): boolean {
        const selfId = this.options.transport.getSocketId();
        if (peerId === selfId) return this.getMicMuted();
        return this.peerMicMuted.get(peerId) ?? false;
    }

    handleRemoteMicState(fromPlayerId: string, micMuted: boolean): void {
        this.peerMicMuted.set(fromPlayerId, micMuted);
        this.emitMicOffSpeakingStates();
    }

    clearPeerMicState(playerId: string): void {
        this.peerMicMuted.delete(playerId);
        this.remoteMicOffSpeaking.delete(playerId);
        this.emitMicOffSpeakingStates();
    }

    handleRemoteMutedSpeaking(fromPlayerId: string, speaking: boolean): void {
        if (speaking) {
            this.remoteMicOffSpeaking.add(fromPlayerId);
        } else {
            this.remoteMicOffSpeaking.delete(fromPlayerId);
        }
        this.emitMicOffSpeakingStates();
    }

    /** Re-broadcast local mic state (e.g. when a new player joins the room). */
    rebroadcastMicState(): void {
        this.broadcastMicState();
    }

    getVoiceBackend(): VoiceBackend {
        return this.backend;
    }

    /** Mic muted in current voice backend, or LiveKit preference while disconnected. */
    getMicMuted(): boolean {
        if (this.backend === "webrtc") return this.mesh.getMicMuted();
        return this.liveKit.getMicMuted();
    }

    /** Same text mesh/LiveKit would show (e.g. "Voice connected (WebRTC mesh, mic muted)"). */
    getVoiceStatusMessage(): string {
        return this.lastVoiceStatusMessage;
    }

    /** Connected voice peers with display names (for debug live panel). */
    getVoiceConnectedPeers(): VoiceConnectedPeer[] {
        const nameFor = (id: string): string =>
            this.options.getPlayerNameForId?.(id) ?? id.slice(0, 8);

        if (this.backend === "webrtc") {
            return this.mesh.getConnectedPeerSummaries().map((p) => ({
                id: p.id,
                name: nameFor(p.id),
                link: "webrtc" as const,
                state: p.state
            }));
        }
        if (this.backend === "livekit") {
            return this.liveKit.getConnectedPeerSummaries().map((p) => ({
                id: p.id,
                name: p.name || nameFor(p.id),
                link: "livekit" as const,
                state: p.state
            }));
        }
        return [];
    }

    getVoicePeersSnapshot(): string {
        const lines = [
            formatVoicePeersSnapshot(this.backend, this.getVoiceConnectedPeers()),
            this.getMicMuted()
                ? "※ マイクはミュート中です。下の音声ボタンでオンにしないと相手に聞こえません。"
                : "※ マイクはオンです。"
        ];
        return lines.join("\n");
    }

    /** Keep mesh peers aligned with proximity (corridor) or same-tile-room members. */
    syncVoicePeersToRoom(): void {
        if (this.backend !== "webrtc" || !this.mesh.isActive()) return;
        const allowed = new Set(this.options.getRemotePlayerIds());
        this.mesh.prunePeersExcept(allowed);
        for (const id of allowed) {
            void this.mesh.onRemotePlayerJoined(id);
        }
    }

    /** Rejoin current backend after Socket.IO reconnect (identity is the new socket id). */
    reconnectMedia(): void {
        if (this.switchingBackend || this.routerJoining) {
            this.needsVoiceReconnect = true;
            return;
        }
        this.beginBackendSwitch(this.leaveAll(), "再接続しています…");
    }

    /** Local player crossed a tile-room boundary: LiveKit in rooms, WebRTC in corridor. */
    onLocalTileRoomChanged(_previousRoom: string, nextRoom: string): void {
        const statusLine = nextRoom === "corridor"
            ? "近くの人と WebRTC で接続しています…"
            : "部屋を移動したため LiveKit に再接続しています…";
        if (this.switchingBackend || this.routerJoining) {
            this.needsVoiceReconnect = true;
            return;
        }
        this.beginBackendSwitch(this.leaveAll(), statusLine);
    }

    /** Multi-line text for debug console (`vinfo`). */
    getVoiceDebugReport(): string {
        return [
            `voice_backend=${this.backend}`,
            this.mesh.getDiagnostics(),
            this.liveKit.getDiagnostics(),
            this.speakingMonitor.getDiagnostics()
        ].join("\n");
    }

    /** WebRTC mesh event trace (`vmesh`). */
    getMeshTraceLog(): string {
        const lines = [`voice_backend=${this.backend}`, ...this.mesh.getTraceLog()];
        if (!lines.length) {
            return "voice_backend=" + this.backend + "\n(mesh trace empty)";
        }
        return lines.join("\n");
    }

    getMeshSignalHandlers() {
        return this.mesh.getSignalHandlers();
    }

    bindUi(ui: VoiceBarUi): void {
        this.voiceBar = ui;
        this.liveKit.bindUi({
            joinButton: null,
            leaveButton: null,
            muteButton: null,
            statusText: null,
            onStatusMessage: (msg) => {
                this.setStatusLine(msg);
            }
        });

        this.voiceBar.muteButton?.addEventListener("click", () => void this.onMuteClick());
        this.syncButtons();
    }

    onRoomRosterChanged(): void {
        this.syncButtons();
    }

    private beginBackendSwitch(leave: Promise<void>, statusLine: string): void {
        const mutedPref = this.getMicMuted();
        this.switchingBackend = true;
        void leave.then(async () => {
            try {
                this.backend = "none";
                this.speakingMonitor.clear();
                this.lastSpeakingIds.clear();
                this.localMutedMicSpeaking = false;
                this.lastSentMicOffSpeaking = false;
                void this.syncLocalMutedMicMonitor();
                this.options.onSpeakingPeersChanged?.(new Set());
                this.options.onMicOffSpeakingChanged?.(new Set());
                this.setStatusLine(statusLine);
                this.syncButtons();
                await this.joinInternal();
                await this.applyMicPreference(mutedPref);
            } finally {
                this.switchingBackend = false;
                this.syncButtons();
                if (this.needsVoiceReconnect) {
                    this.needsVoiceReconnect = false;
                    this.onLocalTileRoomChanged(this.options.getRoomId(), this.options.getRoomId());
                }
            }
        });
    }

    dispose(): void {
        this.clearMicIdleTimer();
        void this.leaveAll();
        this.localMutedMicMonitor.stop();
        this.speakingMonitor.dispose();
        this.mesh.dispose();
        this.liveKit.dispose();
    }

    private setStatusLine(message: string): void {
        this.lastVoiceStatusMessage = message;
    }

    private syncButtons(): void {
        if (this.voiceBar.muteButton) {
            this.voiceBar.muteButton.disabled = false;
            const micMuted = this.getMicMuted();
            this.voiceBar.muteButton.innerHTML = getVoiceMicButtonInnerHtml(micMuted);
            this.voiceBar.muteButton.setAttribute(
                "aria-label",
                micMuted ? "マイクをオン" : "ミュート"
            );
            this.voiceBar.muteButton.title = micMuted ? "マイクをオン" : "ミュート";
        }

        this.liveKit.refreshUi();
    }

    /** Scene boot or roster upgrade; mic defaults muted on LiveKit join. */
    async autoJoinVoiceMuted(): Promise<void> {
        await this.joinInternal();
    }

    private async joinInternal(): Promise<void> {
        if (this.routerJoining) return;

        this.routerJoining = true;
        this.syncButtons();

        try {
            if (this.options.getRoomId() === "corridor") {
                if (this.liveKit.isConnected()) {
                    await this.liveKit.leave();
                }
                if (!this.mesh.isActive()) {
                    this.options.onSpeakingPeersChanged?.(new Set());
                    this.options.onMicOffSpeakingChanged?.(new Set());
                    await this.mesh.join();
                }
                this.backend = this.mesh.isActive() ? "webrtc" : "none";
                this.syncVoicePeersToRoom();
                await this.syncLocalMutedMicMonitor();
                this.broadcastMicState();
                if (this.backend === "webrtc" && !this.getMicMuted()) this.noteMicActivity();
                return;
            }

            if (this.mesh.isActive()) {
                await this.mesh.leave();
            }
            if (this.liveKit.isConnected()) {
                this.backend = "livekit";
                return;
            }

            this.options.onSpeakingPeersChanged?.(new Set());
            this.options.onMicOffSpeakingChanged?.(new Set());
            await this.liveKit.join();
            this.backend = this.liveKit.isConnected() ? "livekit" : "none";
            await this.syncLocalMutedMicMonitor();
            this.broadcastMicState();
            if (!this.getMicMuted()) this.noteMicActivity();
        } finally {
            this.routerJoining = false;
            this.syncButtons();
            if (this.needsVoiceReconnect && !this.switchingBackend) {
                this.needsVoiceReconnect = false;
                this.onLocalTileRoomChanged(this.options.getRoomId(), this.options.getRoomId());
            }
        }
    }

    private async leaveAll(): Promise<void> {
        await this.liveKit.leave();
        await this.mesh.leave();
        this.speakingMonitor.clear();
        this.lastSpeakingIds.clear();
        this.localMutedMicSpeaking = false;
        this.syncBroadcastMicOffSpeaking(false);
        this.lastSentMicOffSpeaking = false;
        await this.syncLocalMutedMicMonitor();
        this.backend = "none";
        this.options.onSpeakingPeersChanged?.(new Set());
        this.options.onMicOffSpeakingChanged?.(new Set());
    }

    private async onMuteClick(): Promise<void> {
        if (this.backend === "webrtc") {
            await this.mesh.toggleMute();
        } else {
            await this.liveKit.toggleMute();
        }
        if (!this.getMicMuted()) this.noteMicActivity();
        this.broadcastMicState();
        this.emitMicOffSpeakingStates();
        this.syncButtons();
    }

    /** Reset the 3-minute mic idle timer (speech, movement, or unmute). */
    noteMicActivity(): void {
        if (this.getMicMuted()) {
            this.clearMicIdleTimer();
            return;
        }
        const now = Date.now();
        if (this.micIdleTimer && now - this.lastMicActivityNoteAt < 1000) return;
        this.lastMicActivityNoteAt = now;
        this.clearMicIdleTimer();
        this.micIdleTimer = window.setTimeout(() => {
            void this.muteMicAfterIdle();
        }, MIC_IDLE_MS);
    }

    private clearMicIdleTimer(): void {
        if (this.micIdleTimer) {
            window.clearTimeout(this.micIdleTimer);
            this.micIdleTimer = 0;
        }
    }

    private async muteMicAfterIdle(): Promise<void> {
        this.micIdleTimer = 0;
        if (this.getMicMuted()) return;
        if (this.backend === "webrtc") {
            await this.mesh.setMicMuted(true);
        } else {
            await this.liveKit.setMicMuted(true);
        }
        this.broadcastMicState();
        this.emitMicOffSpeakingStates();
        this.syncButtons();
        this.setStatusLine("3分間操作がなかったためマイクをオフにしました");
    }

    /** 現在の部屋のプレイヤーを管理 */
    private currentRoomPlayers: Set<string> = new Set();

    /** 部屋が変更された際に音声セッションを更新 */
    onRoomChanged(newRoomId: string): void {
        const currentRoomId = this.options.getRoomId();
        if (currentRoomId !== newRoomId) {
            this.options.transport.leaveRoom({ roomId: currentRoomId }); // 現在の部屋を離れる
            this.options.transport.joinRoom({ roomId: newRoomId, name: this.options.getDisplayName() }); // 新しい部屋に参加
            this.currentRoomPlayers.clear(); // 部屋のプレイヤーをリセット
            this.syncButtons();
        }
    }

    /** リモートプレイヤーが参加した際に部屋を確認 */
    onRemotePlayerJoined(playerId: string, playerRoomId: string): void {
        if (playerRoomId !== this.options.getRoomId()) return;
        this.currentRoomPlayers.add(playerId);
        if (this.backend === "webrtc") {
            void this.mesh.onRemotePlayerJoined(playerId);
        }
    }

    /** Remote player left our tile room or disconnected. */
    onRemotePlayerLeft(playerId: string): void {
        this.currentRoomPlayers.delete(playerId);
        this.mesh.onRemotePlayerLeft(playerId);
        this.clearPeerMicState(playerId);
        this.syncVoicePeersToRoom();
    }

    private forwardLiveKitSpeakers(identities: ReadonlySet<string>): void {
        if (this.liveKit.isConnected()) {
            this.lastSpeakingIds = new Set(identities);
            this.options.onSpeakingPeersChanged?.(identities);
            this.emitMicOffSpeakingStates();
            const selfId = this.options.transport.getSocketId();
            if (selfId && identities.has(selfId)) {
                this.noteMicActivity();
            }
        }
    }

    private broadcastMicState(): void {
        if (this.backend === "none") return;
        const micMuted = this.getMicMuted();
        const selfId = this.options.transport.getSocketId();
        if (selfId) {
            this.peerMicMuted.set(selfId, micMuted);
        }
        this.options.transport.sendVoiceMicState({ micMuted });
    }

    private async applyMicPreference(muted: boolean): Promise<void> {
        await this.liveKit.setMicMuted(muted);
        await this.mesh.setMicMuted(muted);
        this.syncButtons();
        this.broadcastMicState();
    }

    private async syncLocalMutedMicMonitor(): Promise<void> {
        if (this.backend === "livekit") {
            await this.localMutedMicMonitor.start();
            return;
        }
        this.localMutedMicMonitor.stop();
    }

    private emitMicOffSpeakingStates(): void {
        const micOffSpeaking = new Set(this.remoteMicOffSpeaking);
        const selfId = this.options.transport.getSocketId();
        let selfMicOffSpeaking = false;

        if (selfId) {
            if (this.mesh.isActive() && this.lastSpeakingIds.has(selfId) && this.getMicMuted()) {
                selfMicOffSpeaking = true;
            }
            if (this.liveKit.isConnected() && this.localMutedMicSpeaking && this.getMicMuted()) {
                selfMicOffSpeaking = true;
            }
            if (selfMicOffSpeaking) {
                micOffSpeaking.add(selfId);
            }
            this.syncBroadcastMicOffSpeaking(selfMicOffSpeaking);
        }

        this.options.onMicOffSpeakingChanged?.(micOffSpeaking);
    }

    private syncBroadcastMicOffSpeaking(speaking: boolean): void {
        if (speaking === this.lastSentMicOffSpeaking) return;
        this.lastSentMicOffSpeaking = speaking;
        this.options.transport.sendVoiceMutedSpeaking({ speaking });
    }
}
