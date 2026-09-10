import type { Room } from "livekit-client";
import { devWarn } from "../devWarn";

type TokenResponse = {
    error?: string;
    token?: string;
    url?: string;
};

type LiveKitScreenShareSessionOptions = {
    tokenApiUrl: string;
    getRoomId: () => string;
    getDisplayName: () => string;
    getLocalPlayerId: () => string | undefined;
    onRemoteShareStarted: (playerId: string, name: string, stream: MediaStream) => void;
    onRemoteShareStopped: (playerId: string) => void;
};

function toScreenIdentity(localPlayerId: string): string {
    return `${localPlayerId}__ss`;
}

function toScreenRoomId(roomId: string): string {
    return `screenshare_${roomId}`;
}

function toBasePlayerId(identity: string): string {
    return identity.endsWith("__ss") ? identity.slice(0, -4) : identity;
}

function isConnected(room: Room | undefined): boolean {
    return room?.state === "connected";
}

export class LiveKitScreenShareSession {
    private lk: typeof import("livekit-client") | undefined;
    private room: Room | undefined;
    private joining = false;
    private joinPromise: Promise<boolean> | undefined;
    private connectedRoomId: string | undefined;
    private localPublishedTrack: MediaStreamTrack | undefined;
    private readonly remoteScreenTracks = new Map<string, { sid: string; track: any }>();

    constructor(private readonly options: LiveKitScreenShareSessionOptions) { }

    isConnected(): boolean {
        return isConnected(this.room);
    }

    async ensureJoined(): Promise<boolean> {
        const roomId = this.options.getRoomId();
        if (!roomId || roomId === "corridor") {
            await this.leave();
            return false;
        }

        if (this.joinPromise) {
            return this.joinPromise;
        }

        if (isConnected(this.room) && this.connectedRoomId === roomId) {
            return true;
        }

        this.joinPromise = (async () => {
            await this.leave();

            const localPlayerId = this.options.getLocalPlayerId();
            if (!localPlayerId) {
                return false;
            }

            this.joining = true;
            try {
                const response = await fetch(this.options.tokenApiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        roomId: toScreenRoomId(roomId),
                        identity: toScreenIdentity(localPlayerId),
                        displayName: `${this.options.getDisplayName()} (screen)`
                    })
                });

                const data = (await response.json().catch(() => ({}))) as TokenResponse;
                if (!response.ok || !data.token || !data.url) {
                    return false;
                }

                const lk = await this.loadLiveKit();
                const { Room: LkRoom, RoomEvent, Track } = lk;
                const room = new LkRoom({ adaptiveStream: true, dynacast: true });

                room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
                    if (track.kind !== Track.Kind.Video) return;

                    const playerId = toBasePlayerId(participant.identity);
                    // We use dedicated __ss identities for screenshare; ignore normal tracks.
                    if (playerId === participant.identity) return;

                    const localId = this.options.getLocalPlayerId();
                    if (localId && playerId === localId) return;

                    const streamTrack = track.mediaStreamTrack;
                    if (!streamTrack) return;

                    const stream = new MediaStream([streamTrack]);
                    const sid = publication.trackSid ?? track.sid ?? streamTrack.id;
                    this.remoteScreenTracks.set(playerId, { sid, track });
                    this.options.onRemoteShareStarted(playerId, participant.name || playerId, stream);
                });

                room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
                    if (track.kind !== Track.Kind.Video) return;
                    const playerId = toBasePlayerId(participant.identity);
                    if (playerId === participant.identity) return;
                    this.remoteScreenTracks.delete(playerId);
                    this.options.onRemoteShareStopped(playerId);
                });

                room.on(RoomEvent.Disconnected, () => {
                    if (this.room !== room) return;
                    this.connectedRoomId = undefined;
                    this.room = undefined;
                    this.localPublishedTrack = undefined;
                    const ids = Array.from(this.remoteScreenTracks.keys());
                    this.remoteScreenTracks.clear();
                    for (const id of ids) {
                        this.options.onRemoteShareStopped(id);
                    }
                });

                await room.connect(data.url, data.token);
                this.room = room;
                this.connectedRoomId = roomId;
                return true;
            } catch (error) {
                devWarn("livekit-screenshare-join", error);
                await this.leave();
                return false;
            } finally {
                this.joining = false;
                this.joinPromise = undefined;
            }
        })();

        return this.joinPromise;
    }

    async publishLocalStream(stream: MediaStream): Promise<boolean> {
        const ok = await this.ensureJoined();
        if (!ok) return false;

        const room = this.room;
        if (!room || !isConnected(room)) return false;

        const lk = await this.loadLiveKit();
        const { Track } = lk;

        const track = stream.getVideoTracks()[0];
        if (!track) return false;

        if (this.localPublishedTrack === track) {
            return true;
        }

        await this.unpublishLocalStream();

        try {
            await room.localParticipant.publishTrack(track, {
                name: "screen",
                source: Track.Source.ScreenShare
            });
            this.localPublishedTrack = track;
            return true;
        } catch (error) {
            devWarn("livekit-screenshare-publish", error);
            this.localPublishedTrack = undefined;
            return false;
        }
    }

    async unpublishLocalStream(): Promise<void> {
        const room = this.room;
        const track = this.localPublishedTrack;
        if (!room || !track) {
            this.localPublishedTrack = undefined;
            return;
        }

        try {
            // Keep the capture track alive; ScreenShareController manages stop().
            await (room.localParticipant as any).unpublishTrack(track, false);
        } catch (error) {
            devWarn("livekit-screenshare-unpublish", error);
        } finally {
            this.localPublishedTrack = undefined;
        }
    }

    async leave(): Promise<void> {
        const room = this.room;
        this.room = undefined;
        this.connectedRoomId = undefined;
        this.localPublishedTrack = undefined;

        const ids = Array.from(this.remoteScreenTracks.keys());
        this.remoteScreenTracks.clear();
        for (const id of ids) {
            this.options.onRemoteShareStopped(id);
        }

        if (!room) return;

        try {
            await room.disconnect(true);
        } catch {
            // ignore
        }
    }

    private async loadLiveKit(): Promise<typeof import("livekit-client")> {
        if (!this.lk) {
            this.lk = await import("livekit-client");
        }
        return this.lk;
    }
}
