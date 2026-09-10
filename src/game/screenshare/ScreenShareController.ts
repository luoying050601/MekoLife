import type { NetworkPlayer } from "../network/types";
import { devWarn } from "../devWarn";
import { FrameRelay } from "./FrameRelay";
import { LiveKitScreenShareSession } from "./LiveKitScreenShareSession";
import { ViewerOverlay } from "./ViewerOverlay";
import { createPeerConnection } from "./WebRTCSession";
import { getVoiceBackendPolicySummary } from "../voice/voiceConstants";
import type {
    ScreenShareControllerOptions,
    ScreenShareSignalHandlers,
    ScreenShareUiElements,
    ShareStatus
} from "./types";

export class ScreenShareController {
    private readonly frameRelay = new FrameRelay();
    private readonly overlay = new ViewerOverlay();
    private readonly senderPeers = new Map<string, RTCPeerConnection>();
    private readonly receiverPeers = new Map<string, RTCPeerConnection>();
    private readonly pendingIce = new Map<string, RTCIceCandidateInit[]>();
    private readonly remoteNames = new Map<string, string>();
    private readonly activeRemoteSharers = new Map<string, string>();
    private readonly liveKitSession: LiveKitScreenShareSession;

    private localStream: MediaStream | undefined;
    private currentSharerId: string | undefined;
    private currentSharerName = "参加者";
    private ui: ScreenShareUiElements = {
        startButton: null,
        stopButton: null,
        statusText: null
    };
    private status: ShareStatus = "idle";
    private roomReady = false;
    private currentRoomId: string = "room1";  // Track current room
    private activeDialog: HTMLDivElement | undefined;
    /** Pending share request: { fromPlayerId, fromPlayerName } */
    private pendingShareRequest: { fromPlayerId: string; fromPlayerName: string } | undefined;
    private activeBackend: "webrtc" | "livekit" = "livekit";
    private reconcilingBackend = false;
    private needsReconcile = false;

    constructor(private readonly options: ScreenShareControllerOptions) {
        this.liveKitSession = new LiveKitScreenShareSession({
            tokenApiUrl: options.tokenApiUrl,
            getRoomId: options.getRoomId,
            getDisplayName: options.getDisplayName,
            getLocalPlayerId: options.getLocalPlayerId,
            onRemoteShareStarted: (playerId, name, stream) => {
                this.activeRemoteSharers.set(playerId, name);
                this.currentSharerId = playerId;
                this.currentSharerName = name;
                this.overlay.showStream(playerId, name, stream);
                this.setStatus(this.localStream ? "sharing" : "viewing", this.localStream ? "画面を共有中" : `${name} の画面を視聴中`);
            },
            onRemoteShareStopped: (playerId) => {
                this.activeRemoteSharers.delete(playerId);
                this.overlay.removeShare(playerId);
                if (this.currentSharerId === playerId) {
                    const fallback = this.activeRemoteSharers.entries().next().value as [string, string] | undefined;
                    this.currentSharerId = fallback?.[0];
                    this.currentSharerName = fallback?.[1] ?? "参加者";
                }
                this.setStatus(this.localStream ? "sharing" : (this.currentSharerId ? "viewing" : "idle"), this.localStream ? "画面を共有中" : (this.currentSharerId ? `${this.currentSharerName} の画面を視聴中` : "共有なし"));
            }
        });
    }

    bindUi(elements: ScreenShareUiElements): void {
        this.ui = elements;

        // CRITICAL: Ensure buttons START disabled - don't trust HTML or anything else
        if (this.ui.startButton) {
            this.ui.startButton.disabled = true;
            this.ui.startButton.setAttribute("disabled", "");
        }
        if (this.ui.stopButton) {
            this.ui.stopButton.disabled = true;
            this.ui.stopButton.setAttribute("disabled", "");
        }

        this.ui.startButton?.addEventListener("click", () => {
            void this.startShare();
        });

        this.ui.stopButton?.addEventListener("click", () => {
            this.stopShare();
        });

        if (this.ui.statusText) {
            this.ui.statusText.textContent = "ルームに接続中...";
        }
        // Now sync UI to ensure correct initial state
        this.syncUi();
    }

    /** One line for debug console (`share` command). */
    getDebugSnapshot(): string {
        const rtc = this.senderPeers.size + this.receiverPeers.size;
        const participantCount = this.options.getParticipantCount();
        const preferred = this.shouldUseLiveKitBackend() ? "livekit" : "none";
        const senderTransport = this.activeBackend === "livekit"
            ? "livekit"
            : (this.senderPeers.size > 0 ? "webrtc" : "none");
        const policy = getVoiceBackendPolicySummary().replace(/^voice_policy=/, "");
        return `screen_share status=${this.status} participants=${participantCount} preferred=${preferred} policy=${policy} sender_transport=${senderTransport} local_stream=${this.localStream ? "yes" : "no"} sharer=${this.currentSharerId ?? "-"} remote_shares=${this.activeRemoteSharers.size} rtc_peers=${rtc}`;
    }

    /** Update current room - called when player moves to new room */
    setCurrentRoomId(roomId: string): void {
        if (this.currentRoomId !== roomId) {
            this.handleLocalRoomChanged();
        }
        this.currentRoomId = roomId;
        this.syncUi();
        this.scheduleBackendReconcile();
    }

    private scheduleBackendReconcile(): void {
        if (this.reconcilingBackend) {
            this.needsReconcile = true;
            return;
        }

        this.reconcilingBackend = true;
        void this.reconcileShareBackend().finally(() => {
            this.reconcilingBackend = false;
            if (this.needsReconcile) {
                this.needsReconcile = false;
                this.scheduleBackendReconcile();
            }
        });
    }

    private handleLocalRoomChanged(): void {
        // Leaving a room should immediately stop viewing stale remote shares.
        for (const [, peer] of this.receiverPeers) {
            peer.close();
        }
        this.receiverPeers.clear();
        this.activeRemoteSharers.clear();
        this.currentSharerId = undefined;
        this.currentSharerName = "参加者";
        this.remoteNames.clear();
        this.pendingIce.clear();
        void this.liveKitSession.unpublishLocalStream();

        if (!this.localStream) {
            this.overlay.hide();
            this.setStatus("idle", "共有なし");
        }
    }

    private getLocalShareId(): string {
        return this.options.getLocalPlayerId() ?? "local-self";
    }

    getSignalHandlers(): ScreenShareSignalHandlers {
        return {
            onCurrentPlayers: (players) => {
                // Handle both old format (array) and new format (object with myRoomId)
                let playerList: NetworkPlayer[] = [];
                if (Array.isArray(players)) {
                    playerList = players;
                } else {
                    playerList = (players as any).players || [];
                }
                // Clear remote names and only add OTHER players (not self)
                this.remoteNames.clear();
                const localPlayerId = this.options.getLocalPlayerId();
                for (const player of playerList) {
                    if (player.id !== localPlayerId) {
                        this.remoteNames.set(player.id, player.name);
                    }
                }
                if (!this.roomReady) {
                    this.roomReady = true;
                    if (this.status === "idle") {
                        this.setStatus("idle", "共有なし");
                    } else {
                        this.syncUi();
                    }
                }
                // Always sync UI when players list changes (adds new players or removes players)
                this.syncUi();
                this.scheduleBackendReconcile();
            },
            onPlayerJoined: (player) => {
                this.remoteNames.set(player.id, player.name);
                this.scheduleBackendReconcile();
                // Sync UI: player joined, so button might need to enable
                this.syncUi();
            },
            onPlayerLeft: (playerId) => {
                this.remoteNames.delete(playerId);
                this.closePeer(this.senderPeers, playerId);
                this.closePeer(this.receiverPeers, playerId);
                this.activeRemoteSharers.delete(playerId);
                this.overlay.removeShare(playerId);

                if (this.currentSharerId === playerId) {
                    const fallback = this.activeRemoteSharers.entries().next().value as [string, string] | undefined;
                    this.currentSharerId = fallback?.[0];
                    this.currentSharerName = fallback?.[1] ?? "参加者";
                    this.setStatus(this.localStream ? "sharing" : (this.currentSharerId ? "viewing" : "idle"), this.localStream ? "画面を共有中" : (this.currentSharerId ? `${this.currentSharerName} の画面を視聴中` : "共有なし"));
                } else {
                    // Even if currentSharerId didn't change, sync UI (player left might disable button)
                    this.syncUi();
                }

                // Clear pending request if requester left
                if (this.pendingShareRequest?.fromPlayerId === playerId) {
                    this.pendingShareRequest = undefined;
                }
                this.scheduleBackendReconcile();
            },
            onScreenShareStart: ({ playerId, name }) => {
                // Room boundary check: only accept from players in current room
                if (playerId === this.getLocalShareId()) return;
                if (!this.remoteNames.has(playerId)) return;
                this.activeRemoteSharers.set(playerId, name);
                this.currentSharerId = playerId;
                this.currentSharerName = name;
                this.overlay.showWaiting(playerId, this.currentSharerName);
                this.setStatus(this.localStream ? "sharing" : "viewing", this.localStream ? "画面を共有中" : `${name} の画面を視聴中`);
                this.scheduleBackendReconcile();
            },
            onScreenShareStop: ({ playerId }) => {
                // Room boundary check: only accept from players in current room
                if (!this.remoteNames.has(playerId)) return;
                this.activeRemoteSharers.delete(playerId);
                this.overlay.removeShare(playerId);
                this.closePeer(this.receiverPeers, playerId);
                if (this.currentSharerId === playerId) {
                    const fallback = this.activeRemoteSharers.entries().next().value as [string, string] | undefined;
                    this.currentSharerId = fallback?.[0];
                    this.currentSharerName = fallback?.[1] ?? "参加者";
                }
                this.setStatus(this.localStream ? "sharing" : (this.currentSharerId ? "viewing" : "idle"), this.localStream ? "画面を共有中" : (this.currentSharerId ? `${this.currentSharerName} の画面を視聴中` : "共有なし"));
            },
            onScreenShareRequest: ({ fromPlayerId, fromPlayerName, targetPlayerId }) => {
                // Room boundary check: only accept from players in current room
                if (!this.remoteNames.has(fromPlayerId)) return;
                const localPlayerId = this.options.getLocalPlayerId();
                if (localPlayerId && targetPlayerId !== localPlayerId) return;

                // Defensive fallback: if target receives request but has no active local stream,
                // fail fast so requester is not left waiting forever.
                if (!this.localStream) {
                    this.options.transport.sendScreenShareRequestResponse({
                        requesterId: fromPlayerId,
                        approved: false,
                        decision: "deny"
                    });
                    this.setStatus("idle", "共有中ではないため、交代リクエストを無視しました。");
                    return;
                }

                // Product rule: allow concurrent shares without asking current sharer.
                this.pendingShareRequest = { fromPlayerId, fromPlayerName };
                this.options.transport.sendScreenShareRequestResponse({
                    requesterId: fromPlayerId,
                    approved: true,
                    decision: "parallel"
                });
                this.pendingShareRequest = undefined;
            },
            onScreenShareRequestResponse: ({ requesterId, approved, decision }) => {
                // Notification to requester about decision
                if (approved && decision !== "deny") {
                    this.setStatus("idle", decision === "parallel" ? "同時共有が許可されました。開始します..." : "共有が許可されました。開始します...");
                    setTimeout(() => {
                        void this.startShare(true, decision === "parallel");
                    }, 500);
                } else {
                    this.setStatus("idle", "共有が拒否されました。");
                }
                this.pendingShareRequest = undefined;
            },
            onScreenShareOffer: async ({ fromPlayerId, offer }) => {
                if (this.activeBackend === "livekit") return;
                // Room boundary check: only accept from players in current room
                if (!this.remoteNames.has(fromPlayerId)) return;
                if (this.localStream) return;
                const connection = this.ensureReceiverPeer(fromPlayerId);
                try {
                    await connection.setRemoteDescription(offer);
                    const answer = await connection.createAnswer();
                    await connection.setLocalDescription(answer);
                    this.options.transport.sendScreenShareAnswer({ toPlayerId: fromPlayerId, answer });
                    await this.flushPendingIce(fromPlayerId);
                } catch (err) {
                    devWarn("screen-share-offer", err);
                    this.closePeer(this.receiverPeers, fromPlayerId);
                }
            },
            onScreenShareAnswer: async ({ fromPlayerId, answer }) => {
                if (this.activeBackend === "livekit") return;
                // Room boundary check: only accept from players in current room
                if (!this.remoteNames.has(fromPlayerId)) return;
                const connection = this.senderPeers.get(fromPlayerId);
                if (!connection) return;
                try {
                    await connection.setRemoteDescription(answer);
                    await this.flushPendingIce(fromPlayerId);
                } catch (err) {
                    devWarn("screen-share-answer", err);
                }
            },
            onScreenShareIce: async ({ fromPlayerId, candidate }) => {
                if (this.activeBackend === "livekit") return;
                // Room boundary check: only accept from players in current room
                if (!this.remoteNames.has(fromPlayerId)) return;
                const connection = this.senderPeers.get(fromPlayerId) ?? this.receiverPeers.get(fromPlayerId);
                if (!connection || !connection.remoteDescription) {
                    const queue = this.pendingIce.get(fromPlayerId) ?? [];
                    queue.push(candidate);
                    this.pendingIce.set(fromPlayerId, queue);
                    return;
                }

                try {
                    await connection.addIceCandidate(candidate);
                } catch (err) {
                    devWarn("screen-share-ice", err);
                }
            },
            onScreenShareFrame: ({ fromPlayerId, imageDataUrl }) => {
                if (this.activeBackend === "livekit") return;
                // Room boundary check: only accept from players in current room
                if (!this.remoteNames.has(fromPlayerId)) return;
                const name = this.remoteNames.get(fromPlayerId) ?? this.currentSharerName;
                this.activeRemoteSharers.set(fromPlayerId, name);
                if (!this.currentSharerId) {
                    this.currentSharerId = fromPlayerId;
                }
                this.currentSharerName = name;
                this.overlay.showFrame(fromPlayerId, name, imageDataUrl);
                // Update status so the bottom bar reflects the fallback relay mode.
                this.setStatus(this.localStream ? "sharing" : "viewing", this.localStream ? "画面を共有中" : `${name} の画面を視聴中`);
            },
            onScreenShareStopAll: () => {
                // Stop all screen shares when player changes rooms
                for (const [, peer] of this.senderPeers) {
                    peer.close();
                }
                for (const [, peer] of this.receiverPeers) {
                    peer.close();
                }
                this.senderPeers.clear();
                this.receiverPeers.clear();
                this.pendingIce.clear();
                this.activeRemoteSharers.clear();
                this.currentSharerId = undefined;
                this.currentSharerName = "参加者";
                this.overlay.hide();
                this.setStatus("idle", "共有なし");
            }
        };
    }

    async startShare(forceTakeover = false, keepExistingShares = false): Promise<void> {
        if (this.localStream || this.status === "starting") return;

        if (!this.roomReady) {
            this.setStatus("idle", "ルーム参加を待っています");
            return;
        }

        if (!this.shouldUseLiveKitBackend()) {
            this.setStatus("error", "廊下では画面共有できません。");
            return;
        }

        // Requester confirms before sending takeover request.
        const localShareId = this.getLocalShareId();
        const targetSharerId = this.currentSharerId && this.currentSharerId !== localShareId
            ? this.currentSharerId
            : this.activeRemoteSharers.keys().next().value;

        if (!forceTakeover && targetSharerId) {
            // Product rule: no request dialog when another user is already sharing.
            keepExistingShares = true;
        }

        if (forceTakeover && !keepExistingShares) {
            this.currentSharerId = undefined;
            this.currentSharerName = "参加者";
            this.activeRemoteSharers.clear();
            this.overlay.hide();
        }

        if (!navigator.mediaDevices?.getDisplayMedia) {
            this.setStatus("error", "このブラウザは画面共有に対応していません。");
            return;
        }

        this.setStatus("starting", "画面のキャプチャを要求しています...");

        try {
            this.localStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: { ideal: 15, max: 24 }
                },
                audio: false
            });
        } catch (err) {
            devWarn("screen-capture", err);
            this.localStream = undefined;
            this.setStatus("error", "画面キャプチャがキャンセルされました。");
            return;
        }

        const [track] = this.localStream.getVideoTracks();
        if (track) {
            track.onended = () => this.stopShare();
        }

        // Show a local preview so the sharer can see what they are broadcasting.
        this.overlay.showStream(localShareId, `${this.options.localPlayerName}（あなた）`, this.localStream);

        this.options.transport.sendScreenShareStart();

        const publishedViaLiveKit = await this.liveKitSession.publishLocalStream(this.localStream);
        if (!publishedViaLiveKit) {
            this.abortFailedLiveKitShare(localShareId, "画面共有に失敗しました。サーバーの LIVEKIT_* を確認してください。");
            return;
        }

        this.activeBackend = "livekit";
        this.clearSenderPeers();
        this.setStatus("sharing", "画面を共有中");
    }

    private abortFailedLiveKitShare(localShareId: string, message: string): void {
        if (this.localStream) {
            for (const track of this.localStream.getTracks()) {
                track.stop();
            }
            this.localStream = undefined;
        }
        this.overlay.removeShare(localShareId);
        this.options.transport.sendScreenShareStop();
        this.setStatus("error", message);
    }

    stopShare(): void {
        if (!this.localStream) {
            this.setStatus(this.currentSharerId ? "viewing" : "idle", this.currentSharerId ? `${this.currentSharerName} の画面を視聴中` : "共有なし");
            return;
        }

        void this.liveKitSession.unpublishLocalStream();
        this.clearSenderPeers();

        for (const track of this.localStream.getTracks()) {
            track.stop();
        }

        this.localStream = undefined;
        this.frameRelay.stop();
        this.overlay.removeShare(this.getLocalShareId());
        this.options.transport.sendScreenShareStop();

        const fallback = this.activeRemoteSharers.entries().next().value as [string, string] | undefined;
        this.currentSharerId = fallback?.[0];
        this.currentSharerName = fallback?.[1] ?? "参加者";
        this.setStatus(this.currentSharerId ? "viewing" : "idle", this.currentSharerId ? `${this.currentSharerName} の画面を視聴中` : "共有なし");
    }


    private async showShareRequestDialog(fromPlayerName: string, fromPlayerId: string): Promise<void> {
        const decision = await this.showShareDecisionDialog(fromPlayerName);
        this.options.transport.sendScreenShareRequestResponse({
            requesterId: fromPlayerId,
            approved: decision !== "deny",
            decision
        });

        if (decision === "takeover") {
            this.stopShare();
        } else if (decision === "parallel") {
            this.setStatus("sharing", "同時共有を開始しました");
        } else {
            this.setStatus("sharing", "自分の共有を維持します");
        }
    }

    private showShareDecisionDialog(fromPlayerName: string): Promise<"takeover" | "parallel" | "deny"> {
        return new Promise((resolve) => {
            this.activeDialog?.remove();

            const backdrop = document.createElement("div");
            backdrop.style.cssText = "position:fixed;inset:0;background:rgba(2,6,23,0.55);display:flex;align-items:center;justify-content:center;z-index:1200;";

            const card = document.createElement("div");
            card.style.cssText = "width:min(94vw,460px);background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px;color:#e2e8f0;box-shadow:0 16px 40px rgba(0,0,0,0.45);";

            const text = document.createElement("p");
            text.style.cssText = "margin:0 0 14px;font-size:14px;line-height:1.45;";
            text.textContent = `${fromPlayerName} が画面共有を開始しようとしています。操作を選んでください。`;

            const actions = document.createElement("div");
            actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;";

            const denyBtn = document.createElement("button");
            denyBtn.type = "button";
            denyBtn.textContent = "自分の共有を続ける";
            denyBtn.style.cssText = "border:1px solid #475569;background:#1e293b;color:#cbd5e1;border-radius:8px;padding:8px 12px;cursor:pointer;";

            const parallelBtn = document.createElement("button");
            parallelBtn.type = "button";
            parallelBtn.textContent = "同時に共有";
            parallelBtn.style.cssText = "border:1px solid #0ea5e9;background:#082f49;color:#bae6fd;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;";

            const takeoverBtn = document.createElement("button");
            takeoverBtn.type = "button";
            takeoverBtn.textContent = "停止して許可";
            takeoverBtn.style.cssText = "border:0;background:#0ea5e9;color:#082f49;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;";

            const cleanup = (result: "takeover" | "parallel" | "deny") => {
                backdrop.remove();
                this.activeDialog = undefined;
                resolve(result);
            };

            denyBtn.addEventListener("click", () => cleanup("deny"));
            parallelBtn.addEventListener("click", () => cleanup("parallel"));
            takeoverBtn.addEventListener("click", () => cleanup("takeover"));
            backdrop.addEventListener("click", (ev) => {
                if (ev.target === backdrop) cleanup("deny");
            });

            actions.append(denyBtn, parallelBtn, takeoverBtn);
            card.append(text, actions);
            backdrop.appendChild(card);
            document.body.appendChild(backdrop);
            this.activeDialog = backdrop;
        });
    }

    private showChoiceDialog(message: string, okText: string, cancelText: string): Promise<boolean> {
        return new Promise((resolve) => {
            this.activeDialog?.remove();

            const backdrop = document.createElement("div");
            backdrop.style.cssText = "position:fixed;inset:0;background:rgba(2,6,23,0.55);display:flex;align-items:center;justify-content:center;z-index:1200;";

            const card = document.createElement("div");
            card.style.cssText = "width:min(92vw,420px);background:#0f172a;border:1px solid #334155;border-radius:12px;padding:16px;color:#e2e8f0;box-shadow:0 16px 40px rgba(0,0,0,0.45);";

            const text = document.createElement("p");
            text.style.cssText = "margin:0 0 14px;font-size:14px;line-height:1.45;";
            text.textContent = message;

            const actions = document.createElement("div");
            actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";

            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.textContent = cancelText;
            cancelBtn.style.cssText = "border:1px solid #475569;background:#1e293b;color:#cbd5e1;border-radius:8px;padding:8px 12px;cursor:pointer;";

            const okBtn = document.createElement("button");
            okBtn.type = "button";
            okBtn.textContent = okText;
            okBtn.style.cssText = "border:0;background:#0ea5e9;color:#082f49;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;";

            const cleanup = (result: boolean) => {
                backdrop.remove();
                this.activeDialog = undefined;
                resolve(result);
            };

            cancelBtn.addEventListener("click", () => cleanup(false));
            okBtn.addEventListener("click", () => cleanup(true));
            backdrop.addEventListener("click", (ev) => {
                if (ev.target === backdrop) cleanup(false);
            });

            actions.append(cancelBtn, okBtn);
            card.append(text, actions);
            backdrop.appendChild(card);
            document.body.appendChild(backdrop);
            this.activeDialog = backdrop;
        });
    }

    destroy(): void {
        this.activeDialog?.remove();
        this.activeDialog = undefined;
        this.stopShare();
        void this.liveKitSession.leave();

        for (const [, connection] of this.receiverPeers) {
            connection.close();
        }
        this.receiverPeers.clear();

        this.overlay.destroy();
        this.pendingIce.clear();
    }

    private async ensureSenderPeer(playerId: string): Promise<void> {
        if (!this.localStream || this.senderPeers.has(playerId)) return;

        const connection = createPeerConnection({
            onIceCandidate: (candidate) => {
                this.options.transport.sendScreenShareIce({ toPlayerId: playerId, candidate });
            }
        });

        for (const track of this.localStream.getTracks()) {
            connection.addTrack(track, this.localStream);
        }

        this.senderPeers.set(playerId, connection);

        const offer = await connection.createOffer();
        await connection.setLocalDescription(offer);

        this.options.transport.sendScreenShareOffer({
            toPlayerId: playerId,
            offer
        });
    }

    private shouldUseLiveKitBackend(): boolean {
        return this.currentRoomId !== "corridor";
    }

    private clearSenderPeers(): void {
        for (const [, connection] of this.senderPeers) {
            connection.close();
        }
        this.senderPeers.clear();
    }

    private clearReceiverPeers(): void {
        for (const [, connection] of this.receiverPeers) {
            connection.close();
        }
        this.receiverPeers.clear();
        this.pendingIce.clear();
    }

    private async reconcileShareBackend(): Promise<void> {
        const useLiveKit = this.shouldUseLiveKitBackend();

        if (useLiveKit) {
            const joined = await this.liveKitSession.ensureJoined();
            if (joined) {
                this.activeBackend = "livekit";
                this.clearSenderPeers();
                this.clearReceiverPeers();
                if (this.localStream) {
                    const published = await this.liveKitSession.publishLocalStream(this.localStream);
                    if (!published) {
                        this.abortFailedLiveKitShare(this.getLocalShareId(), "画面共有に失敗しました。サーバーの LIVEKIT_* を確認してください。");
                    }
                }
                return;
            }
            if (this.localStream) {
                this.abortFailedLiveKitShare(this.getLocalShareId(), "画面共有に失敗しました。サーバーの LIVEKIT_* を確認してください。");
            }
            return;
        }

        await this.liveKitSession.unpublishLocalStream();
        await this.liveKitSession.leave();
        this.clearSenderPeers();
        this.clearReceiverPeers();
    }

    private async reconcileSenderTransportForParticipantCount(): Promise<void> {
        if (!this.localStream) return;
        if (this.activeBackend === "livekit") return;

        const audience = new Set(this.options.getAudienceIds());
        for (const [playerId, connection] of this.senderPeers) {
            if (audience.has(playerId)) continue;
            connection.close();
            this.senderPeers.delete(playerId);
        }

        for (const playerId of audience) {
            await this.ensureSenderPeer(playerId);
        }
    }

    private ensureReceiverPeer(playerId: string): RTCPeerConnection {
        const existing = this.receiverPeers.get(playerId);
        if (existing) return existing;

        const connection = createPeerConnection({
            onIceCandidate: (candidate) => {
                this.options.transport.sendScreenShareIce({ toPlayerId: playerId, candidate });
            },
            onTrack: (stream) => {
                const name = this.remoteNames.get(playerId) ?? this.currentSharerName;
                this.activeRemoteSharers.set(playerId, name);
                this.currentSharerId = playerId;
                this.currentSharerName = name;
                this.overlay.showStream(playerId, name, stream);
                this.setStatus(this.localStream ? "sharing" : "viewing", this.localStream ? "画面を共有中" : `${name} の画面を視聴中`);
            }
        });

        this.receiverPeers.set(playerId, connection);
        return connection;
    }

    private async flushPendingIce(playerId: string): Promise<void> {
        const queued = this.pendingIce.get(playerId);
        if (!queued?.length) return;

        const connection = this.senderPeers.get(playerId) ?? this.receiverPeers.get(playerId);
        if (!connection || !connection.remoteDescription) return;

        for (const candidate of queued) {
            try {
                await connection.addIceCandidate(candidate);
            } catch (err) {
                devWarn("screen-share-ice-queue", err);
            }
        }

        this.pendingIce.delete(playerId);
    }

    private closePeer(collection: Map<string, RTCPeerConnection>, playerId: string): void {
        const peer = collection.get(playerId);
        if (!peer) return;
        peer.close();
        collection.delete(playerId);
    }

    private setStatus(nextStatus: ShareStatus, message: string): void {
        this.status = nextStatus;
        if (this.ui.statusText) {
            this.ui.statusText.textContent = message;
        }
        this.syncUi();
    }

    private syncUi(): void {
        // Share button: enabled when room is ready, in a valid room (not corridor), and not currently sharing
        if (this.ui.startButton) {
            const isInCorridor = this.currentRoomId === "corridor";
            const shouldDisable = !this.roomReady || isInCorridor || this.status === "starting" || this.status === "sharing";
            this.ui.startButton.disabled = shouldDisable;
        }
        // Stop button: only enabled while actively sharing
        if (this.ui.stopButton) {
            this.ui.stopButton.disabled = this.status !== "sharing";
        }
    }
}
