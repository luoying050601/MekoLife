export type PlayerMovePayload = {
  x: number;
  y: number;
  direction: "up" | "down" | "left" | "right" | "idle";
  moving: boolean;
};

export type NetworkPlayer = {
  id: string;
  name: string;
  x: number;
  y: number;
};

export type ScreenShareOfferPayload = {
  fromPlayerId: string;
  offer: RTCSessionDescriptionInit;
};

export type ScreenShareAnswerPayload = {
  fromPlayerId: string;
  answer: RTCSessionDescriptionInit;
};

export type ScreenShareIcePayload = {
  fromPlayerId: string;
  candidate: RTCIceCandidateInit;
};

export type ScreenShareFramePayload = {
  fromPlayerId: string;
  imageDataUrl: string;
};

/** WebRTC mesh voice (P2P audio) — same shape as screen-share signaling. */
export type VoiceWebRtcOfferPayload = ScreenShareOfferPayload;
export type VoiceWebRtcAnswerPayload = ScreenShareAnswerPayload;
export type VoiceWebRtcIcePayload = ScreenShareIcePayload;

export type VoiceMicStatePayload = {
  fromPlayerId: string;
  micMuted: boolean;
};

export type VoiceMutedSpeakingPayload = {
  fromPlayerId: string;
  speaking: boolean;
};

export type ScreenShareStartPayload = {
  playerId: string;
  name: string;
};

export type ScreenShareStopPayload = {
  playerId: string;
};

/** Request to take over screen sharing (Zoom-style negotiation). */
export type ScreenShareRequestPayload = {
  fromPlayerId: string;
  fromPlayerName: string;
  targetPlayerId: string;
};

export type ScreenShareRequestDecision = "deny" | "takeover" | "parallel";

/** Current sharer approves/denies takeover request. */
export type ScreenShareRequestResponsePayload = {
  requesterId: string;
  approved: boolean;
  decision?: ScreenShareRequestDecision;
};

export type ChatMessage = {
  id: string;
  name: string;
  text: string;
};

export type DirectMessage = {
  fromId: string;
  fromName: string;
  fromRoomId: string;
  toId: string;
  text: string;
};

export type TransportHandlers = {
  onCurrentPlayers(data: NetworkPlayer[] | { players: NetworkPlayer[]; myRoomId: string; myPlayer?: NetworkPlayer }): void;
  onPlayerJoined(player: NetworkPlayer): void;
  onPlayerMoved(player: NetworkPlayer): void;
  onPlayerLeft(playerId: string): void;
  onChatMessage?(msg: ChatMessage): void;
  onDirectMessage?(msg: DirectMessage): void;
  onScreenShareStart?(payload: ScreenShareStartPayload): void;
  onScreenShareStop?(payload: ScreenShareStopPayload): void;
  onScreenShareStopAll?(): void;
  onScreenShareOffer?(payload: ScreenShareOfferPayload): void;
  onScreenShareAnswer?(payload: ScreenShareAnswerPayload): void;
  onScreenShareIce?(payload: ScreenShareIcePayload): void;
  onScreenShareFrame?(payload: ScreenShareFramePayload): void;
  onScreenShareRequest?(payload: ScreenShareRequestPayload): void;
  onScreenShareRequestResponse?(payload: ScreenShareRequestResponsePayload): void;
  onVoiceWebRtcOffer?(payload: VoiceWebRtcOfferPayload): void;
  onVoiceWebRtcAnswer?(payload: VoiceWebRtcAnswerPayload): void;
  onVoiceWebRtcIce?(payload: VoiceWebRtcIcePayload): void;
  onVoiceMicState?(payload: VoiceMicStatePayload): void;
  onVoiceMutedSpeaking?(payload: VoiceMutedSpeakingPayload): void;
  /** Socket.IO reconnected after a drop; client should re-join the game room. */
  onSocketReconnected?(): void;
};

export interface GameTransport {
  setHandlers(handlers: TransportHandlers): void;
  connect(): void;
  /** Whether the multiplayer socket is connected (false if disconnected or mock). */
  isConnected(): boolean;
  /** Resolves when the multiplayer socket is connected (no-op for mock). */
  waitForConnected(): Promise<void>;
  joinRoom(payload: { roomId: string; name: string; x?: number; y?: number }): void;
  sendMove(payload: PlayerMovePayload): void;
  sendChat(text: string): void;
  sendDirectMessage(toId: string, text: string): void;
  getSocketId(): string | undefined;
  sendScreenShareStart(): void;
  sendScreenShareStop(): void;
  sendScreenShareOffer(payload: { toPlayerId: string; offer: RTCSessionDescriptionInit }): void;
  sendScreenShareAnswer(payload: { toPlayerId: string; answer: RTCSessionDescriptionInit }): void;
  sendScreenShareIce(payload: { toPlayerId: string; candidate: RTCIceCandidateInit }): void;
  sendScreenShareFrame(payload: { imageDataUrl: string }): void;
  sendScreenShareRequest(payload: { targetPlayerId: string }): void;
  sendScreenShareRequestResponse(payload: { requesterId: string; approved: boolean; decision?: ScreenShareRequestDecision }): void;
  sendVoiceWebRtcOffer(payload: { toPlayerId: string; offer: RTCSessionDescriptionInit }): void;
  sendVoiceWebRtcAnswer(payload: { toPlayerId: string; answer: RTCSessionDescriptionInit }): void;
  sendVoiceWebRtcIce(payload: { toPlayerId: string; candidate: RTCIceCandidateInit }): void;
  sendVoiceMicState(payload: { micMuted: boolean }): void;
  sendVoiceMutedSpeaking(payload: { speaking: boolean }): void;
  disconnect(): void;
  /** 部屋を離れる */
  leaveRoom(payload: { roomId: string }): void;
}
