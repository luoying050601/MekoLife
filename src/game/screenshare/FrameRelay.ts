type FrameRelayOptions = {
    fps?: number;
    width?: number;
    quality?: number;
    maxPayloadLength?: number;
};

export class FrameRelay {
    private intervalId: number | undefined;
    private video: HTMLVideoElement | undefined;
    private canvas: HTMLCanvasElement | undefined;

    constructor(private readonly options: FrameRelayOptions = {}) { }

    async start(stream: MediaStream, onFrame: (imageDataUrl: string) => void): Promise<void> {
        this.stop();

        this.video = document.createElement("video");
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.setAttribute("playsinline", "");
        this.video.srcObject = stream;

        // Attach to document so browsers (especially Chrome/Safari) allow play() on
        // the hidden video element. Position it off-screen to avoid any visual glitch.
        this.video.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(this.video);

        this.canvas = document.createElement("canvas");

        // Wait for the stream metadata to be ready before attempting play.
        await new Promise<void>((resolve) => {
            if (!this.video) { resolve(); return; }
            if (this.video.readyState >= 1) { resolve(); return; }
            this.video.onloadedmetadata = () => resolve();
            // Timeout guard in case loadedmetadata never fires.
            window.setTimeout(resolve, 3000);
        });

        try {
            await this.video.play();
        } catch {
            // play() failed; still attempt frame capture via polling below.
            // Some browsers allow drawImage() even if play() is blocked.
        }

        const fps = this.options.fps ?? 6;
        const width = this.options.width ?? 960;
        const quality = this.options.quality ?? 0.55;
        const maxPayloadLength = this.options.maxPayloadLength ?? 320000;

        this.intervalId = window.setInterval(() => {
            if (!this.video || !this.canvas || this.video.videoWidth === 0 || this.video.videoHeight === 0) {
                return;
            }

            const ratio = this.video.videoHeight / this.video.videoWidth;
            const targetWidth = Math.max(320, Math.min(width, this.video.videoWidth));
            const targetHeight = Math.max(180, Math.floor(targetWidth * ratio));

            this.canvas.width = targetWidth;
            this.canvas.height = targetHeight;

            const context = this.canvas.getContext("2d");
            if (!context) return;

            context.drawImage(this.video, 0, 0, targetWidth, targetHeight);

            // Use JPEG for universal browser support (WebP is not supported in Safari < 14).
            const frame = this.canvas.toDataURL("image/jpeg", quality);
            if (frame.length > maxPayloadLength) return;
            onFrame(frame);
        }, Math.max(80, Math.floor(1000 / fps)));
    }

    stop(): void {
        if (this.intervalId !== undefined) {
            window.clearInterval(this.intervalId);
        }
        this.intervalId = undefined;

        if (this.video) {
            this.video.pause();
            this.video.srcObject = null;
            // Remove the off-screen video element from the DOM.
            if (this.video.parentNode) {
                this.video.parentNode.removeChild(this.video);
            }
        }

        this.video = undefined;
        this.canvas = undefined;
    }
}
