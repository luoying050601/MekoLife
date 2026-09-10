import type {
    GameTransport,
    VoiceWebRtcAnswerPayload,
    VoiceWebRtcIcePayload,
    VoiceWebRtcOfferPayload
} from "../network/types";
import { devWarn } from "../devWarn";
import { createPeerConnection } from "../screenshare/WebRTCSession";
import type { VoiceSpeakingMonitor } from "./VoiceSpeakingMonitor";

type Options = {
    transport: GameTransport;
    getLocalId: () => string | undefined;
    getRemoteIds: () => string[];
    getPeerVolume?: (peerId: string) => number;
    setStatus: (message: string) => void;
    speakingMonitor?: VoiceSpeakingMonitor;
};

export type WebRtcMeshPeerSummary = {
    id: string;
    state: string;
};

export class WebRtcMeshVoiceSession {
    private localStream: MediaStream | undefined;
    /** Clones per remote peer — one MediaStreamTrack cannot be bound to multiple PCs reliably. */
    private readonly localTrackClonesByPeer = new Map<string, MediaStreamTrack[]>();
    private readonly peers = new Map<string, RTCPeerConnection>();
    private readonly pendingIce = new Map<string, RTCIceCandidateInit[]>();
    private readonly remoteAudio = new Map<string, HTMLAudioElement>();
    /** Offers received before voice session is active (see onOffer). */
    private readonly pendingOffers = new Map<string, VoiceWebRtcOfferPayload>();
    /** Room peers that joined before our voice session was active. */
    private readonly deferredRemoteJoins = new Set<string>();
    private readonly traceLog: string[] = [];
    private active = false;
    private micMuted = false;
    private joining = false;

    constructor(private readonly options: Options) {}

    private trace(message: string): void {
        const line = `${new Date().toISOString().slice(11, 23)} ${message}`;
        this.traceLog.push(line);
        if (this.traceLog.length > 24) {
            this.traceLog.shift();
        }
    }

    /** Last mesh events for debug command `vmesh`. */
    getTraceLog(): readonly string[] {
        return this.traceLog;
    }

    getConnectedPeerSummaries(): WebRtcMeshPeerSummary[] {
        const out: WebRtcMeshPeerSummary[] = [];
        for (const [id, pc] of this.peers) {
            const hasAudio = this.remoteAudio.has(id);
            const conn = pc.connectionState;
            const ice = pc.iceConnectionState;
            let state: string;
            if (hasAudio && (conn === "connected" || ice === "connected" || ice === "completed")) {
                state = "音声あり";
            } else if (conn === "connected" || ice === "connected" || ice === "completed") {
                state = "接続済・音声待ち";
            } else {
                state = `${conn}/${ice}`;
            }
            out.push({ id, state });
        }
        return out;
    }

    /** Drop mesh links to players not in the allowed set (e.g. left tile room). */
    prunePeersExcept(allowedIds: ReadonlySet<string>): void {
        for (const [id, pc] of [...this.peers.entries()]) {
            if (!allowedIds.has(id) || pc.connectionState === "failed" || pc.connectionState === "disconnected") {
                this.trace(`prune peer ${id} state=${pc.connectionState}`);
                this.closePeer(id);
            }
        }
        for (const id of [...this.pendingOffers.keys()]) {
            if (!allowedIds.has(id)) {
                this.pendingOffers.delete(id);
            }
        }
    }

    isActive(): boolean {
        return this.active;
    }

    isJoining(): boolean {
        return this.joining;
    }

    getSignalHandlers() {
        return {
            onVoiceWebRtcOffer: (payload: VoiceWebRtcOfferPayload) => void this.onOffer(payload),
            onVoiceWebRtcAnswer: (payload: VoiceWebRtcAnswerPayload) => void this.onAnswer(payload),
            onVoiceWebRtcIce: (payload: VoiceWebRtcIcePayload) => void this.onIce(payload)
        };
    }

    getDiagnostics(): string {
        const self = this.options.getLocalId() ?? "(none)";
        const lines = [
            `webrtc_mesh: active=${this.active} joining=${this.joining} self=${self}`,
            `  peers=${this.peers.size} pending_offers=${this.pendingOffers.size} deferred_joins=${this.deferredRemoteJoins.size}`
        ];
        for (const [id, pc] of this.peers) {
            lines.push(
                `  peer ${id}: ice=${pc.iceConnectionState} conn=${pc.connectionState} sig=${pc.signalingState}`
            );
        }
        lines.push(`  remote_audio_el=${this.remoteAudio.size}`);
        lines.push(this.options.speakingMonitor?.getDiagnostics() ?? "  speaking_monitor: (none)");
        return lines.join("\n");
    }

    async join(): Promise<void> {
        if (this.joining) return;
        if (this.active) {
            await this.leave();
        }
        const self = this.options.getLocalId();
        if (!self) {
            this.options.setStatus("音声 (WebRTC): ソケット未接続");
            return;
        }

        this.joining = true;
        this.options.setStatus("音声 (WebRTC): マイクを要求しています...");

        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: false
            });
        } catch (err) {
            devWarn("voice-mic", err);
            this.localStream = undefined;
            this.options.setStatus("音声 (WebRTC): マイクが拒否されたか利用できません");
            this.joining = false;
            return;
        }

        this.active = true;
        this.micMuted = true;
        this.applyMuteToClones(false);

        await this.connectInitiatorPeers(self);
        await this.flushDeferredRemoteJoins(self);
        await this.flushPendingOffers();

        void this.options.speakingMonitor?.attachStream(self, this.localStream);

        this.options.setStatus("音声接続済み（WebRTC mesh・マイクオフ）");
        this.joining = false;
        this.trace(`join done peers=${this.peers.size}`);
    }

    async leave(): Promise<void> {
        if (!this.active && !this.localStream) return;
        this.active = false;
        this.joining = false;

        this.options.speakingMonitor?.clear();

        for (const [, pc] of this.peers) {
            pc.close();
        }
        this.peers.clear();
        this.pendingIce.clear();
        this.pendingOffers.clear();
        this.deferredRemoteJoins.clear();

        for (const [, el] of this.remoteAudio) {
            el.remove();
        }
        this.remoteAudio.clear();

        for (const [, clones] of this.localTrackClonesByPeer) {
            for (const c of clones) {
                c.stop();
            }
        }
        this.localTrackClonesByPeer.clear();

        if (this.localStream) {
            for (const t of this.localStream.getTracks()) {
                t.stop();
            }
            this.localStream = undefined;
        }

        this.micMuted = false;
        this.options.setStatus("音声待機中");
    }

    dispose(): void {
        void this.leave();
    }

    /** Call when a remote player appears in the same tile room. */
    async onRemotePlayerJoined(remoteId: string): Promise<void> {
        const self = this.options.getLocalId();
        if (!self || remoteId === self) return;

        if (!this.active || !this.localStream) {
            this.deferredRemoteJoins.add(remoteId);
            this.trace(`deferred join ${remoteId} (voice not active)`);
            return;
        }

        if (self < remoteId) {
            this.trace(`onRemotePlayerJoined initiate -> ${remoteId}`);
            await this.ensureInitiatorPeer(remoteId);
        } else {
            this.trace(`onRemotePlayerJoined wait offer from ${remoteId} (self>=remote)`);
        }
    }

    onRemotePlayerLeft(remoteId: string): void {
        this.closePeer(remoteId);
    }

    async toggleMute(): Promise<void> {
        await this.setMicMuted(!this.micMuted);
    }

    async setMicMuted(muted: boolean): Promise<void> {
        this.micMuted = muted;
        if (this.active) {
            this.applyMuteToClones(!muted);
        }
    }

    getMicMuted(): boolean {
        return this.micMuted;
    }

    private applyMuteToClones(enabled: boolean): void {
        for (const [, clones] of this.localTrackClonesByPeer) {
            for (const c of clones) {
                c.enabled = enabled;
            }
        }
    }

    setPeerVolume(peerId: string, volume: number): void {
        const audio = this.remoteAudio.get(peerId);
        if (audio) {
            audio.volume = volume;
        }
    }

    private closePeer(remoteId: string): void {
        this.options.speakingMonitor?.detach(remoteId);

        const clones = this.localTrackClonesByPeer.get(remoteId);
        if (clones) {
            for (const c of clones) {
                c.stop();
            }
            this.localTrackClonesByPeer.delete(remoteId);
        }
        const pc = this.peers.get(remoteId);
        if (pc) {
            pc.close();
            this.peers.delete(remoteId);
        }
        this.pendingIce.delete(remoteId);
        this.pendingOffers.delete(remoteId);
        this.deferredRemoteJoins.delete(remoteId);
        const el = this.remoteAudio.get(remoteId);
        if (el) {
            el.remove();
            this.remoteAudio.delete(remoteId);
        }
    }

    private attachRemoteAudio(remoteId: string, stream: MediaStream): void {
        const existing = this.remoteAudio.get(remoteId);
        if (existing) {
            existing.srcObject = null;
            existing.remove();
        }
        const audio = document.createElement("audio");
        audio.autoplay = true;
        audio.setAttribute("playsinline", "");
        audio.muted = false;
        audio.dataset.voicePeer = remoteId;
        audio.srcObject = stream;
        audio.volume = this.options.getPeerVolume?.(remoteId) ?? 1;
        document.body.appendChild(audio);
        void audio.play().catch(() => undefined);
        this.remoteAudio.set(remoteId, audio);
        void this.options.speakingMonitor?.attachStream(remoteId, stream);
    }

    private addLocalTracksToPeer(pc: RTCPeerConnection, peerId: string): void {
        const stream = this.localStream;
        if (!stream) return;
        const clones: MediaStreamTrack[] = [];
        for (const track of stream.getTracks()) {
            const clone = track.clone();
            clone.enabled = !this.micMuted;
            clones.push(clone);
            pc.addTrack(clone, new MediaStream([clone]));
        }
        this.localTrackClonesByPeer.set(peerId, clones);
    }

    private async connectInitiatorPeers(self: string): Promise<void> {
        for (const remoteId of this.options.getRemoteIds()) {
            if (self < remoteId) {
                await this.ensureInitiatorPeer(remoteId);
            }
        }
    }

    private async flushDeferredRemoteJoins(self: string): Promise<void> {
        if (!this.deferredRemoteJoins.size) return;
        const ids = [...this.deferredRemoteJoins];
        this.deferredRemoteJoins.clear();
        this.trace(`flush deferred joins n=${ids.length}`);
        for (const remoteId of ids) {
            if (self < remoteId) {
                await this.ensureInitiatorPeer(remoteId);
            }
        }
    }

    private async flushPendingOffers(): Promise<void> {
        if (!this.pendingOffers.size) return;
        const payloads = [...this.pendingOffers.values()];
        this.pendingOffers.clear();
        this.trace(`flush pending offers n=${payloads.length}`);
        for (const payload of payloads) {
            await this.handleOffer(payload);
        }
    }

    private wirePeerLifecycle(pc: RTCPeerConnection, remoteId: string): void {
        pc.addEventListener("connectionstatechange", () => {
            const s = pc.connectionState;
            if (s === "failed" || s === "closed") {
                this.trace(`peer ${remoteId} connection ${s}`);
                this.closePeer(remoteId);
            }
        });
    }

    private async ensureInitiatorPeer(remoteId: string): Promise<void> {
        const self = this.options.getLocalId();
        const stream = this.localStream;
        if (!self || !stream || self >= remoteId || this.peers.has(remoteId)) return;

        this.trace(`send offer -> ${remoteId}`);

        const pc = createPeerConnection({
            onIceCandidate: (candidate) => {
                this.options.transport.sendVoiceWebRtcIce({ toPlayerId: remoteId, candidate });
            },
            onTrack: (remoteStream) => {
                this.attachRemoteAudio(remoteId, remoteStream);
            }
        });

        this.wirePeerLifecycle(pc, remoteId);
        this.addLocalTracksToPeer(pc, remoteId);

        this.peers.set(remoteId, pc);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.options.transport.sendVoiceWebRtcOffer({
            toPlayerId: remoteId,
            offer: pc.localDescription ?? offer
        });
    }

    private async onOffer(payload: VoiceWebRtcOfferPayload): Promise<void> {
        const { fromPlayerId } = payload;
        if (!this.active || !this.localStream) {
            if (fromPlayerId) {
                this.pendingOffers.set(fromPlayerId, payload);
                this.trace(`offer queued from ${fromPlayerId} (voice not active)`);
            }
            return;
        }
        await this.handleOffer(payload);
    }

    private async handleOffer(payload: VoiceWebRtcOfferPayload): Promise<void> {
        const self = this.options.getLocalId();
        const { fromPlayerId, offer } = payload;
        if (!self || !fromPlayerId || fromPlayerId >= self) {
            this.trace(`offer ignored from ${fromPlayerId ?? "?"} (initiator rule)`);
            return;
        }

        let pc = this.peers.get(fromPlayerId);
        if (pc) {
            this.trace(`offer duplicate from ${fromPlayerId}`);
            return;
        }

        this.trace(`answer offer from ${fromPlayerId}`);

        pc = createPeerConnection({
            onIceCandidate: (candidate) => {
                this.options.transport.sendVoiceWebRtcIce({ toPlayerId: fromPlayerId, candidate });
            },
            onTrack: (remoteStream) => {
                this.attachRemoteAudio(fromPlayerId, remoteStream);
            }
        });

        this.wirePeerLifecycle(pc, fromPlayerId);
        this.peers.set(fromPlayerId, pc);

        try {
            await pc.setRemoteDescription(offer);
            this.addLocalTracksToPeer(pc, fromPlayerId);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.options.transport.sendVoiceWebRtcAnswer({
                toPlayerId: fromPlayerId,
                answer: pc.localDescription ?? answer
            });
            await this.flushPendingIce(fromPlayerId, pc);
        } catch (err) {
            devWarn("voice-webrtc-offer", err);
            this.trace(`offer failed from ${fromPlayerId}`);
            this.closePeer(fromPlayerId);
        }
    }

    private async onAnswer(payload: VoiceWebRtcAnswerPayload): Promise<void> {
        const self = this.options.getLocalId();
        const { fromPlayerId, answer } = payload;
        if (!self || !fromPlayerId || self >= fromPlayerId) return;

        const pc = this.peers.get(fromPlayerId);
        if (!pc) return;

        try {
            await pc.setRemoteDescription(answer);
            await this.flushPendingIce(fromPlayerId, pc);
        } catch (err) {
            devWarn("voice-webrtc-answer", err);
        }
    }

    private async onIce(payload: VoiceWebRtcIcePayload): Promise<void> {
        const { fromPlayerId, candidate } = payload;
        const pc = this.peers.get(fromPlayerId);
        if (!pc || !pc.remoteDescription) {
            const q = this.pendingIce.get(fromPlayerId) ?? [];
            q.push(candidate);
            this.pendingIce.set(fromPlayerId, q);
            return;
        }

        try {
            await pc.addIceCandidate(candidate);
        } catch (err) {
            devWarn("voice-webrtc-ice", err);
        }
    }

    private async flushPendingIce(peerId: string, pc: RTCPeerConnection): Promise<void> {
        const queued = this.pendingIce.get(peerId);
        if (!queued?.length) return;
        for (const c of queued) {
            try {
                await pc.addIceCandidate(c);
            } catch (err) {
                devWarn("voice-webrtc-ice-queue", err);
            }
        }
        this.pendingIce.delete(peerId);
    }
}
