import { VoiceSpeakingMonitor } from "./VoiceSpeakingMonitor";

const LOCAL_MONITOR_ID = "__local_muted_mic__";

/**
 * Detects local speech while the app mic is muted (LiveKit path).
 * WebRTC mesh uses VoiceSpeakingMonitor on the local stream with clones muted.
 */
export class LocalMutedMicMonitor {
    private stream: MediaStream | undefined;
    private monitor: VoiceSpeakingMonitor | undefined;
    private running = false;

    constructor(
        private readonly getMicMuted: () => boolean,
        private readonly onMutedSpeakingChange: (speaking: boolean) => void
    ) {}

    isRunning(): boolean {
        return this.running;
    }

    async start(): Promise<void> {
        if (this.running) return;
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch {
            return;
        }

        this.monitor = new VoiceSpeakingMonitor(0.045, (ids) => {
            const localSpeech = ids.has(LOCAL_MONITOR_ID);
            this.onMutedSpeakingChange(localSpeech && this.getMicMuted());
        });

        this.running = true;
        await this.monitor.attachStream(LOCAL_MONITOR_ID, this.stream);
    }

    stop(): void {
        this.running = false;
        this.monitor?.dispose();
        this.monitor = undefined;
        if (this.stream) {
            for (const t of this.stream.getTracks()) {
                t.stop();
            }
            this.stream = undefined;
        }
        this.onMutedSpeakingChange(false);
    }
}
