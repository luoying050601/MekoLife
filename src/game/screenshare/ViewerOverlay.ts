export class ViewerOverlay {
    private root: HTMLDivElement;
    private title: HTMLParagraphElement;
    private subtitle: HTMLParagraphElement;
    private closeButton: HTMLButtonElement;
    private reopenButton: HTMLButtonElement;
    private mainVideo: HTMLVideoElement;
    private mainFrame: HTMLImageElement;
    private thumbRail: HTMLDivElement;
    private manuallyHidden = false;
    private readonly shares = new Map<string, {
        name: string;
        stream?: MediaStream;
        frame?: string;
        button: HTMLButtonElement;
        video: HTMLVideoElement;
        frameImg: HTMLImageElement;
    }>();
    private selectedShareId: string | undefined;
    private resizeObserver: ResizeObserver | undefined;
    private readonly onWindowResize = () => {
        this.syncLayoutBounds();
    };

    constructor() {
        this.root = document.createElement("div");
        this.root.className = "screen-share-viewer hidden";

        const header = document.createElement("div");
        header.className = "screen-share-header";

        const headerMeta = document.createElement("div");
        headerMeta.className = "screen-share-header-meta";

        this.title = document.createElement("p");
        this.title.className = "screen-share-title";
        this.title.textContent = "画面共有";

        this.subtitle = document.createElement("p");
        this.subtitle.className = "screen-share-subtitle";
        this.subtitle.textContent = "映像を待っています";

        this.closeButton = document.createElement("button");
        this.closeButton.type = "button";
        this.closeButton.className = "screen-share-close";
        this.closeButton.textContent = "×";
        this.closeButton.title = "画面共有ビューを閉じる";
        this.closeButton.addEventListener("click", () => this.minimizeViewer());

        headerMeta.append(this.title, this.subtitle);
        header.append(headerMeta, this.closeButton);

        const mediaContainer = document.createElement("div");
        mediaContainer.className = "screen-share-media";

        this.mainVideo = document.createElement("video");
        this.mainVideo.autoplay = true;
        this.mainVideo.muted = true;
        this.mainVideo.playsInline = true;
        this.mainVideo.className = "screen-share-video hidden";

        this.mainFrame = document.createElement("img");
        this.mainFrame.className = "screen-share-frame hidden";
        this.mainFrame.alt = "画面共有の代替フレーム";

        this.thumbRail = document.createElement("div");
        this.thumbRail.className = "screen-share-thumbs";
        mediaContainer.append(this.mainVideo, this.mainFrame);

        this.reopenButton = document.createElement("button");
        this.reopenButton.type = "button";
        this.reopenButton.className = "screen-share-reopen hidden";
        this.reopenButton.textContent = "共有を再表示";
        this.reopenButton.title = "画面共有を再表示";
        this.reopenButton.addEventListener("click", () => this.reopenViewer());

        // Keep thumbnails outside the media box so they float without shrinking the shared view.
        this.root.append(header, mediaContainer, this.thumbRail);

        // Mount to document.body with position:fixed so it is never clipped or
        // occluded by Phaser's internal stacking context inside #game-root.
        document.body.appendChild(this.root);
        document.body.appendChild(this.reopenButton);

        this.installLayoutTracking();
        this.syncLayoutBounds();
    }

    private installLayoutTracking(): void {
        window.addEventListener("resize", this.onWindowResize);

        if (typeof ResizeObserver === "undefined") {
            return;
        }

        this.resizeObserver = new ResizeObserver(() => {
            this.syncLayoutBounds();
        });

        const mainContent = document.getElementById("main-content");
        const contentRow = document.getElementById("content-row");

        if (mainContent) {
            this.resizeObserver.observe(mainContent);
        }
        if (contentRow) {
            this.resizeObserver.observe(contentRow);
        }
    }

    private syncLayoutBounds(): void {
        const topBar = document.getElementById("top-bar");
        const bottomBar = document.getElementById("bottom-bar");

        // Span the full viewport width so the shared screen isn't shrunk by the
        // side panels (they're position:static and get visually covered by this
        // fixed, higher z-index overlay anyway).
        const left = 0;
        const right = 0;

        const top = topBar
            ? Math.max(0, Math.round(topBar.getBoundingClientRect().bottom))
            : 44;
        const bottom = bottomBar
            ? Math.max(0, Math.round(window.innerHeight - bottomBar.getBoundingClientRect().top))
            : 68;

        this.root.style.setProperty("--share-left", `${left}px`);
        this.root.style.setProperty("--share-right", `${right}px`);
        this.root.style.setProperty("--share-top", `${top}px`);
        this.root.style.setProperty("--share-bottom", `${bottom}px`);

        this.reopenButton.style.right = `${Math.max(16, right + 20)}px`;
        this.reopenButton.style.bottom = `${Math.max(16, bottom + 18)}px`;
    }

    showWaiting(playerId: string, name: string): void {
        const share = this.ensureShareEntry(playerId, name);
        share.name = name;
        share.stream = undefined;
        share.frame = undefined;
        share.video.srcObject = null;
        share.video.classList.add("hidden");
        share.frameImg.removeAttribute("src");
        share.frameImg.classList.add("hidden");
        this.updateThumbTitle(playerId);
        this.show();
        const prevSelected = this.selectedShareId;
        this.ensureSelected();
        if (this.selectedShareId === playerId || prevSelected !== this.selectedShareId) {
            this.renderSelected("接続中...");
        }
    }

    showStream(playerId: string, name: string, stream: MediaStream): void {
        const share = this.ensureShareEntry(playerId, name);
        share.name = name;
        share.stream = stream;
        share.frame = undefined;
        share.video.srcObject = stream;
        share.video.classList.remove("hidden");
        share.frameImg.removeAttribute("src");
        share.frameImg.classList.add("hidden");
        this.updateThumbTitle(playerId);
        void share.video.play().catch(() => undefined);
        this.show();
        const prevSelected = this.selectedShareId;
        this.ensureSelected(playerId);
        if (this.selectedShareId === playerId || prevSelected !== this.selectedShareId) {
            this.renderSelected("ライブ映像");
        }
    }

    showFrame(playerId: string, name: string, imageDataUrl: string): void {
        const share = this.ensureShareEntry(playerId, name);
        share.name = name;
        share.frame = imageDataUrl;
        if (!share.stream) {
            share.video.srcObject = null;
            share.video.classList.add("hidden");
        }
        share.frameImg.src = imageDataUrl;
        share.frameImg.classList.remove("hidden");
        this.updateThumbTitle(playerId);
        this.show();
        const prevSelected = this.selectedShareId;
        this.ensureSelected(playerId);
        if (this.selectedShareId === playerId || prevSelected !== this.selectedShareId) {
            this.renderSelected("低帯域フレーム転送");
        }
    }

    removeShare(playerId: string): void {
        const share = this.shares.get(playerId);
        if (!share) return;
        share.video.srcObject = null;
        share.button.remove();
        this.shares.delete(playerId);

        if (this.selectedShareId === playerId) {
            this.selectedShareId = undefined;
            this.ensureSelected();
        }

        if (this.shares.size === 0) {
            this.hide();
            return;
        }

        this.renderSelected("ライブ映像");
    }

    hasShares(): boolean {
        return this.shares.size > 0;
    }

    hide(): void {
        this.root.classList.add("hidden");
        this.mainVideo.srcObject = null;
        this.mainFrame.removeAttribute("src");
        this.mainVideo.classList.add("hidden");
        this.mainFrame.classList.add("hidden");
        this.manuallyHidden = false;
        this.reopenButton.classList.add("hidden");
    }

    destroy(): void {
        this.hide();
        for (const [playerId] of this.shares) {
            this.removeShare(playerId);
        }
        window.removeEventListener("resize", this.onWindowResize);
        this.resizeObserver?.disconnect();
        this.resizeObserver = undefined;
        this.reopenButton.remove();
        this.root.remove();
    }

    private show(): void {
        if (this.manuallyHidden) {
            this.updateReopenVisibility();
            return;
        }
        this.root.classList.remove("hidden");
        this.reopenButton.classList.add("hidden");
    }

    private ensureShareEntry(playerId: string, name: string) {
        const existing = this.shares.get(playerId);
        if (existing) return existing;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "screen-share-thumb";

        const video = document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.className = "screen-share-thumb-video hidden";

        const frameImg = document.createElement("img");
        frameImg.className = "screen-share-thumb-frame hidden";
        frameImg.alt = "共有プレビュー";

        const label = document.createElement("span");
        label.className = "screen-share-thumb-label";
        label.textContent = name;

        button.append(video, frameImg, label);
        button.addEventListener("click", () => {
            if (this.manuallyHidden) {
                this.reopenViewer();
            }
            this.selectedShareId = playerId;
            this.renderSelected("ライブ映像");
        });

        this.thumbRail.appendChild(button);

        const entry = { name, stream: undefined, frame: undefined, button, video, frameImg };
        this.shares.set(playerId, entry);
        return entry;
    }

    private ensureSelected(preferId?: string): void {
        // Keep current selection stable to avoid main-view flicker while other shares update frames.
        if (this.selectedShareId && this.shares.has(this.selectedShareId)) return;
        if (preferId && this.shares.has(preferId)) {
            this.selectedShareId = preferId;
            return;
        }
        this.selectedShareId = this.shares.keys().next().value;
    }

    private renderSelected(defaultSubtitle: string): void {
        const selectedId = this.selectedShareId;
        if (!selectedId) return;
        const selected = this.shares.get(selectedId);
        if (!selected) return;

        for (const [id, share] of this.shares) {
            share.button.classList.toggle("active", id === selectedId);
        }

        this.title.textContent = `${selected.name} が共有中`;
        this.subtitle.textContent = defaultSubtitle;

        if (selected.stream) {
            if (this.mainVideo.srcObject !== selected.stream) {
                this.mainVideo.srcObject = selected.stream;
            }
            this.mainVideo.classList.remove("hidden");
            this.mainFrame.classList.add("hidden");
            this.mainFrame.removeAttribute("src");
            void this.mainVideo.play().catch(() => undefined);
            this.subtitle.textContent = "ライブ映像";
            return;
        }

        if (selected.frame) {
            this.mainVideo.srcObject = null;
            this.mainVideo.classList.add("hidden");
            this.mainFrame.src = selected.frame;
            this.mainFrame.classList.remove("hidden");
            this.subtitle.textContent = "低帯域フレーム転送";
            return;
        }

        this.mainVideo.srcObject = null;
        this.mainVideo.classList.add("hidden");
        this.mainFrame.classList.add("hidden");
        this.mainFrame.removeAttribute("src");
        this.subtitle.textContent = "接続中...";
    }

    private updateThumbTitle(playerId: string): void {
        const share = this.shares.get(playerId);
        if (!share) return;
        const label = share.button.querySelector(".screen-share-thumb-label");
        if (label) {
            label.textContent = share.name;
        }
    }

    private minimizeViewer(): void {
        if (this.shares.size === 0) return;
        this.manuallyHidden = true;
        this.root.classList.add("minimized");
        this.updateReopenVisibility();
    }

    private reopenViewer(): void {
        if (this.shares.size === 0) return;
        this.manuallyHidden = false;
        this.root.classList.remove("minimized");
        this.ensureSelected();
        this.renderSelected("ライブ映像");
        this.updateReopenVisibility();
    }

    private updateReopenVisibility(): void {
        this.reopenButton.classList.toggle("hidden", !this.manuallyHidden || this.shares.size === 0);
    }
}
