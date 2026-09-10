import { io, type Socket } from "socket.io-client";
import { devWarn } from "../devWarn";
import type { GameTransport, PlayerMovePayload, TransportHandlers } from "./types";

export class SocketTransport implements GameTransport {
  private socket: Socket | undefined;
  private handlers: TransportHandlers | undefined;
  private everConnected = false;

  constructor(private readonly serverUrl: string) { }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  connect(): void {
    this.socket = io(this.serverUrl, {
      transports: ["websocket", "polling"],
      withCredentials: false
    });

    this.socket.on("connect_error", (err) => {
      devWarn("socket-connect-error", err);
    });

    this.socket.on("connect", () => {
      if (this.everConnected) {
        this.handlers?.onSocketReconnected?.();
      }
      this.everConnected = true;
    });

    this.socket.on("current_players", (players) => this.handlers?.onCurrentPlayers(players));
    this.socket.on("player_joined", (player) => this.handlers?.onPlayerJoined(player));
    this.socket.on("player_moved", (player) => this.handlers?.onPlayerMoved(player));
    this.socket.on("player_left", ({ playerId }) => this.handlers?.onPlayerLeft(playerId));
    this.socket.on("chat_message", (msg) => this.handlers?.onChatMessage?.(msg));
    this.socket.on("dm_message", (msg) => this.handlers?.onDirectMessage?.(msg));
    this.socket.on("screen_share_start", (payload) => this.handlers?.onScreenShareStart?.(payload));
    this.socket.on("screen_share_stop", (payload) => this.handlers?.onScreenShareStop?.(payload));
    this.socket.on("screen_share_stop_all", () => this.handlers?.onScreenShareStopAll?.());
    this.socket.on("screen_share_offer", (payload) => this.handlers?.onScreenShareOffer?.(payload));
    this.socket.on("screen_share_answer", (payload) => this.handlers?.onScreenShareAnswer?.(payload));
    this.socket.on("screen_share_ice", (payload) => this.handlers?.onScreenShareIce?.(payload));
    this.socket.on("screen_share_frame", (payload) => this.handlers?.onScreenShareFrame?.(payload));
    this.socket.on("screen_share_request", (payload) => this.handlers?.onScreenShareRequest?.(payload));
    this.socket.on("screen_share_request_response", (payload) => this.handlers?.onScreenShareRequestResponse?.(payload));
    this.socket.on("voice_webrtc_offer", (payload) => this.handlers?.onVoiceWebRtcOffer?.(payload));
    this.socket.on("voice_webrtc_answer", (payload) => this.handlers?.onVoiceWebRtcAnswer?.(payload));
    this.socket.on("voice_webrtc_ice", (payload) => this.handlers?.onVoiceWebRtcIce?.(payload));
    this.socket.on("voice_mic_state", (payload) => this.handlers?.onVoiceMicState?.(payload));
    this.socket.on("voice_muted_speaking", (payload) => this.handlers?.onVoiceMutedSpeaking?.(payload));
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  waitForConnected(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = this.socket;
      if (!sock) {
        reject(new Error("Socket not initialized; call connect() first."));
        return;
      }
      if (sock.connected) {
        resolve();
        return;
      }
      sock.once("connect", () => resolve());
      sock.once("connect_error", (err) => reject(err));
    });
  }

  joinRoom(payload: { roomId: string; name: string; x?: number; y?: number }): void {
    this.socket?.emit("join_room", payload);
  }

  sendMove(payload: PlayerMovePayload): void {
    this.socket?.emit("player_move", payload);
  }

  sendChat(text: string): void {
    this.socket?.emit("chat_message", { text });
  }

  sendDirectMessage(toId: string, text: string): void {
    this.socket?.emit("dm_message", { toId, text });
  }

  getSocketId(): string | undefined {
    return this.socket?.id;
  }

  sendScreenShareStart(): void {
    this.socket?.emit("screen_share_start");
  }

  sendScreenShareStop(): void {
    this.socket?.emit("screen_share_stop");
  }

  sendScreenShareOffer(payload: { toPlayerId: string; offer: RTCSessionDescriptionInit }): void {
    this.socket?.emit("screen_share_offer", payload);
  }

  sendScreenShareAnswer(payload: { toPlayerId: string; answer: RTCSessionDescriptionInit }): void {
    this.socket?.emit("screen_share_answer", payload);
  }

  sendScreenShareIce(payload: { toPlayerId: string; candidate: RTCIceCandidateInit }): void {
    this.socket?.emit("screen_share_ice", payload);
  }

  sendScreenShareFrame(payload: { imageDataUrl: string }): void {
    this.socket?.emit("screen_share_frame", payload);
  }

  sendVoiceWebRtcOffer(payload: { toPlayerId: string; offer: RTCSessionDescriptionInit }): void {
    this.socket?.emit("voice_webrtc_offer", payload);
  }

  sendVoiceWebRtcAnswer(payload: { toPlayerId: string; answer: RTCSessionDescriptionInit }): void {
    this.socket?.emit("voice_webrtc_answer", payload);
  }

  sendVoiceWebRtcIce(payload: { toPlayerId: string; candidate: RTCIceCandidateInit }): void {
    this.socket?.emit("voice_webrtc_ice", payload);
  }

  sendVoiceMicState(payload: { micMuted: boolean }): void {
    this.socket?.emit("voice_mic_state", payload);
  }

  sendVoiceMutedSpeaking(payload: { speaking: boolean }): void {
    this.socket?.emit("voice_muted_speaking", payload);
  }

  sendScreenShareRequest(payload: { targetPlayerId: string }): void {
    this.socket?.emit("screen_share_request", payload);
  }

  sendScreenShareRequestResponse(payload: { requesterId: string; approved: boolean; decision?: "deny" | "takeover" | "parallel" }): void {
    this.socket?.emit("screen_share_request_response", payload);
  }

  disconnect(): void {
    this.everConnected = false;
    this.socket?.disconnect();
    this.socket = undefined;
  }

  /** 部屋を離れる */
  leaveRoom(payload: { roomId: string }): void {
    this.socket?.emit("leave_room", payload);
  }
}
