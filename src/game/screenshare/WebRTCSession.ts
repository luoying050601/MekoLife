export function createPeerConnection(options: {
    onIceCandidate: (candidate: RTCIceCandidateInit) => void;
    onTrack?: (stream: MediaStream) => void;
}): RTCPeerConnection {
    const connection = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    connection.onicecandidate = (event) => {
        if (!event.candidate) return;
        options.onIceCandidate(event.candidate.toJSON());
    };

    if (options.onTrack) {
        connection.ontrack = (event) => {
            const stream =
                event.streams[0] ??
                (event.track ? new MediaStream([event.track]) : undefined);
            if (stream) {
                options.onTrack?.(stream);
            }
        };
    }

    return connection;
}
