/**
 * RMS-style level from remote/local MediaStreams (WebRTC mesh only).
 * LiveKit uses RoomEvent.ActiveSpeakersChanged instead.
 */
export class VoiceSpeakingMonitor {
    private ctx: AudioContext | null = null;
    private readonly chains = new Map<
        string,
        { analyser: AnalyserNode; freq: Uint8Array; src: MediaStreamAudioSourceNode }
    >();
    private rafId = 0;
    private lastSerialized = "";

    constructor(
        private readonly energyThreshold: number,
        private readonly onChange: (speaking: ReadonlySet<string>) => void
    ) {}

    getDiagnostics(): string {
        const ctx = this.ctx;
        return `speaking-monitor: streams=${this.chains.size} audioctx=${ctx ? ctx.state : "none"}`;
    }

    async attachStream(peerId: string, stream: MediaStream): Promise<void> {
        this.detach(peerId);
        const track = stream.getAudioTracks()[0];
        if (!track || track.readyState === "ended") return;

        const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;

        if (!this.ctx) {
            this.ctx = new Ctor();
        }
        const ctx = this.ctx;
        if (ctx.state === "suspended") {
            await ctx.resume().catch(() => undefined);
        }

        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.45;
        src.connect(analyser);
        const freq = new Uint8Array(analyser.frequencyBinCount);
        this.chains.set(peerId, { analyser, freq, src });
        this.startLoop();
    }

    detach(peerId: string): void {
        const n = this.chains.get(peerId);
        if (!n) return;
        try {
            n.src.disconnect();
        } catch {
            /* ignore */
        }
        try {
            n.analyser.disconnect();
        } catch {
            /* ignore */
        }
        this.chains.delete(peerId);
        if (this.chains.size === 0) {
            this.stopLoop();
            this.emitIfChanged(new Set());
        }
    }

    clear(): void {
        for (const id of [...this.chains.keys()]) {
            this.detach(id);
        }
        this.emitIfChanged(new Set());
    }

    dispose(): void {
        this.stopLoop();
        this.clear();
        void this.ctx?.close().catch(() => undefined);
        this.ctx = null;
    }

    private startLoop(): void {
        if (this.rafId !== 0) return;
        const tick = (): void => {
            this.sample();
            this.rafId = requestAnimationFrame(tick);
        };
        this.rafId = requestAnimationFrame(tick);
    }

    private stopLoop(): void {
        if (this.rafId !== 0) {
            cancelAnimationFrame(this.rafId);
            this.rafId = 0;
        }
    }

    private sample(): void {
        const speaking = new Set<string>();
        for (const [id, { analyser, freq }] of this.chains) {
            // DOM typings expect Uint8Array<ArrayBuffer>; constructor infers ArrayBufferLike.
            analyser.getByteFrequencyData(freq as Uint8Array<ArrayBuffer>);
            let energy = 0;
            for (let i = 0; i < freq.length; i++) {
                energy += freq[i] ?? 0;
            }
            const norm = energy / (freq.length * 255);
            if (norm >= this.energyThreshold) {
                speaking.add(id);
            }
        }
        this.emitIfChanged(speaking);
    }

    private emitIfChanged(speaking: ReadonlySet<string>): void {
        const serialized = [...speaking].sort().join(",");
        if (serialized === this.lastSerialized) return;
        this.lastSerialized = serialized;
        this.onChange(speaking);
    }
}
