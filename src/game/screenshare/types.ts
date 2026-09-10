import type {
    NetworkPlayer,
    ScreenShareAnswerPayload,
    ScreenShareFramePayload,
    ScreenShareIcePayload,
    ScreenShareOfferPayload,
    ScreenShareRequestPayload,
    ScreenShareRequestResponsePayload,
    ScreenShareStartPayload,
    ScreenShareStopPayload
} from "../network/types";

export type ShareStatus = "idle" | "starting" | "sharing" | "viewing" | "error";

export type ScreenShareUiElements = {
    startButton: HTMLButtonElement | null;
    stopButton: HTMLButtonElement | null;
    statusText: HTMLParagraphElement | null;
};

export type ScreenShareControllerOptions = {
    localPlayerName: string;
    getLocalPlayerId: () => string | undefined;
    getAudienceIds: () => string[];
    getParticipantCount: () => number;
    tokenApiUrl: string;
    getRoomId: () => string;
    getDisplayName: () => string;
    transport: {
        sendScreenShareStart(): void;
        sendScreenShareStop(): void;
        sendScreenShareOffer(payload: { toPlayerId: string; offer: RTCSessionDescriptionInit }): void;
        sendScreenShareAnswer(payload: { toPlayerId: string; answer: RTCSessionDescriptionInit }): void;
        sendScreenShareIce(payload: { toPlayerId: string; candidate: RTCIceCandidateInit }): void;
        sendScreenShareFrame(payload: { imageDataUrl: string }): void;
        sendScreenShareRequest(payload: { targetPlayerId: string }): void;
        sendScreenShareRequestResponse(payload: { requesterId: string; approved: boolean; decision?: "deny" | "takeover" | "parallel" }): void;
    };
};

export type ScreenShareSignalHandlers = {
    onCurrentPlayers(players: NetworkPlayer[]): void;
    onPlayerJoined(player: NetworkPlayer): void;
    onPlayerLeft(playerId: string): void;
    onScreenShareStart(payload: ScreenShareStartPayload): void;
    onScreenShareStop(payload: ScreenShareStopPayload): void;
    onScreenShareStopAll(): void;
    onScreenShareRequest(payload: ScreenShareRequestPayload): void;
    onScreenShareRequestResponse(payload: ScreenShareRequestResponsePayload): void;
    onScreenShareOffer(payload: ScreenShareOfferPayload): Promise<void>;
    onScreenShareAnswer(payload: ScreenShareAnswerPayload): Promise<void>;
    onScreenShareIce(payload: ScreenShareIcePayload): Promise<void>;
    onScreenShareFrame(payload: ScreenShareFramePayload): void;
};
