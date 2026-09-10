type ParticipantVolumeMenuOptions = {
    getPeerVolume: (playerId: string) => number;
    onVolumeChange: (playerId: string, volume: number) => void;
};

export class ParticipantVolumeMenu {
    private readonly root: HTMLDivElement;
    private readonly titleEl: HTMLSpanElement;
    private readonly valueEl: HTMLSpanElement;
    private readonly slider: HTMLInputElement;
    private targetPlayerId: string | null = null;
    private ignoreNextPointerDown = false;
    private readonly onDocumentPointerDown: (e: PointerEvent) => void;
    private readonly onDocumentKeyDown: (e: KeyboardEvent) => void;
    private readonly onDocumentScroll: () => void;

    constructor(private readonly options: ParticipantVolumeMenuOptions) {
        this.root = document.createElement("div");
        this.root.className = "participant-volume-menu hidden";
        this.root.setAttribute("role", "dialog");
        this.root.setAttribute("aria-modal", "true");

        this.titleEl = document.createElement("span");
        this.titleEl.className = "participant-volume-menu-title";

        this.valueEl = document.createElement("span");
        this.valueEl.className = "participant-volume-menu-value";

        this.slider = document.createElement("input");
        this.slider.type = "range";
        this.slider.min = "0";
        this.slider.max = "100";
        this.slider.step = "1";
        this.slider.className = "participant-volume-menu-slider";
        this.slider.addEventListener("input", () => {
            if (!this.targetPlayerId) return;
            const vol = Number(this.slider.value) / 100;
            this.valueEl.textContent = `${this.slider.value}%`;
            this.options.onVolumeChange(this.targetPlayerId, vol);
        });
        this.slider.addEventListener("pointerdown", (e) => e.stopPropagation());

        const header = document.createElement("div");
        header.className = "participant-volume-menu-header";
        header.append(this.titleEl, this.valueEl);

        this.root.append(header, this.slider);
        document.body.appendChild(this.root);

        this.onDocumentPointerDown = (e) => {
            if (this.ignoreNextPointerDown) return;
            if (!this.targetPlayerId) return;
            if (e.target instanceof Node && this.root.contains(e.target)) return;
            this.close();
        };
        this.onDocumentKeyDown = (e) => {
            if (e.key === "Escape") this.close();
        };
        this.onDocumentScroll = () => this.close();

        document.addEventListener("pointerdown", this.onDocumentPointerDown);
        document.addEventListener("keydown", this.onDocumentKeyDown);
        document.addEventListener("scroll", this.onDocumentScroll, true);
    }

    bindParticipantItem(li: HTMLLIElement, playerId: string, name: string, isSelf: boolean): void {
        if (isSelf) return;
        li.title = "右クリックで音量調整";
        li.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.open(e.clientX, e.clientY, playerId, name);
        });
    }

    open(clientX: number, clientY: number, playerId: string, name: string): void {
        this.targetPlayerId = playerId;
        this.titleEl.textContent = `${name} の音量`;
        const stored = this.options.getPeerVolume(playerId);
        const pct = Math.round(stored * 100);
        this.slider.value = String(pct);
        this.slider.setAttribute("aria-label", `${name} の音量`);
        this.valueEl.textContent = `${pct}%`;

        this.root.classList.remove("hidden");
        const pad = 8;
        const rect = this.root.getBoundingClientRect();
        let left = clientX;
        let top = clientY;
        if (left + rect.width > window.innerWidth - pad) {
            left = window.innerWidth - rect.width - pad;
        }
        if (top + rect.height > window.innerHeight - pad) {
            top = window.innerHeight - rect.height - pad;
        }
        this.root.style.left = `${Math.max(pad, left)}px`;
        this.root.style.top = `${Math.max(pad, top)}px`;
        this.ignoreNextPointerDown = true;
        window.setTimeout(() => {
            this.ignoreNextPointerDown = false;
        }, 0);
        this.slider.focus();
    }

    close(): void {
        this.targetPlayerId = null;
        this.root.classList.add("hidden");
    }

    dispose(): void {
        this.close();
        document.removeEventListener("pointerdown", this.onDocumentPointerDown);
        document.removeEventListener("keydown", this.onDocumentKeyDown);
        document.removeEventListener("scroll", this.onDocumentScroll, true);
        this.root.remove();
    }
}
