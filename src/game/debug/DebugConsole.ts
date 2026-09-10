import {
    API_BASE_SESSION_KEY,
    clearStoredApiBase,
    resolveApiServerBaseUrl
} from "../network/serverOrigin";

export type DebugConsoleOptions = {
    form: HTMLFormElement | null;
    input: HTMLInputElement | null;
    log: HTMLPreElement | null;
    getParticipantCount: () => number;
    getVoiceBackend: () => string;
    /** Human-readable voice line (e.g. "Voice connected (WebRTC mesh, mic muted)"). */
    getVoiceStatusMessage: () => string;
    /** Multi-line voice / WebRTC / LiveKit diagnostics (optional). */
    getVoiceDiagnostics?: () => string;
    getRoomId: () => string;
    getPlayerName: () => string;
    getPlayerPosition: () => { x: number; y: number };
    isSocketConnected: () => boolean;
    getSocketId: () => string | undefined;
    /** e.g. remote_count=… ids=… */
    getRemotePlayersDebug: () => string;
    getScreenShareDebug: () => string;
    getVoiceMicMuted: () => boolean;
    /** One-line voice switch policy summary (thresholds). */
    getVoicePolicySummary?: () => string;
    /** Multi-line voice peer list for `vpeers` (optional). */
    getVoicePeersSnapshot?: () => string;
    getMeshTraceLog?: () => string;
};

/** Shown when user runs `dinfo` or `help` (Japanese). */
const DEBUG_HELP_LINES_JA = [
    "利用可能なコマンド（先頭の / は省略できます）:",
    "  dinfo, help — この一覧を表示",
    "  count — 参加者人数（自分＋他プレイヤー）",
    "  voice, connection — voice_backend、ステータス、部屋の音声接続者一覧",
    "  vstatus — 表示用ステータス文のみ（例: 音声接続済み…）",
    "  vinfo, voiceinfo — 音声の詳細診断（複数行）",
    "  vpeers — 部屋に○○（WebRTC/LiveKit）がいる 形式で表示",
    "  vmesh — WebRTC mesh の直近イベント trace（接続切れ調査用）",
    "  vpolicy — 音声バックエンドポリシー（1行）",
    "  mic — 音声バックエンドとマイクミュート状態",
    "  room — 現在のルームID",
    "  self — 表示名とソケットID",
    "  pos — 自分キャラの座標（x, y）",
    "  remotes — 他プレイヤー人数とソケットID一覧",
    "  net — ソケット接続状態とID",
    "  share — 画面共有の内部状態（1行）",
    "  env — import.meta の MODE / PROD など（session_api_base も表示）",
    "  clearsocket — trycloudflare 用の session に保存した Socket URL を消去（その後ページ再読込）",
    "  clear, cls — このログをクリア"
];

function appendLog(logEl: HTMLPreElement, line: string): void {
    const stamp = new Date().toISOString().slice(11, 23);
    logEl.textContent += `[${stamp}] ${line}\n`;
    logEl.scrollTop = logEl.scrollHeight;
}

function normalizeDebugCmd(raw: string): string {
    let s = raw.trim().toLowerCase();
    if (s.startsWith("/")) s = s.slice(1);
    return s;
}

function appendHelp(log: HTMLPreElement): void {
    for (const line of DEBUG_HELP_LINES_JA) {
        appendLog(log, line);
    }
}

type CmdFn = (options: DebugConsoleOptions, log: HTMLPreElement) => void;

function cmdVoiceSummary(opts: DebugConsoleOptions, log: HTMLPreElement): void {
    appendLog(log, `voice_backend=${opts.getVoiceBackend()}`);
    appendLog(log, opts.getVoiceStatusMessage());
    cmdVoicePeers(opts, log);
}

function cmdVoiceStatusLine(opts: DebugConsoleOptions, log: HTMLPreElement): void {
    appendLog(log, opts.getVoiceStatusMessage());
}

function cmdVoiceInfo(opts: DebugConsoleOptions, log: HTMLPreElement): void {
    const text = opts.getVoiceDiagnostics?.() ?? "(no voice diagnostics hook)";
    for (const line of text.split("\n")) {
        appendLog(log, line.length ? line : " ");
    }
}

function cmdVoicePolicy(opts: DebugConsoleOptions, log: HTMLPreElement): void {
    const line = opts.getVoicePolicySummary?.() ?? "voice_policy=(no policy hook)";
    appendLog(log, line);
}

function cmdVoicePeers(opts: DebugConsoleOptions, log: HTMLPreElement): void {
    const text = opts.getVoicePeersSnapshot?.() ?? "(no voice peers hook)";
    for (const line of text.split("\n")) {
        appendLog(log, line.length ? line : " ");
    }
}

function cmdVMesh(opts: DebugConsoleOptions, log: HTMLPreElement): void {
    const text = opts.getMeshTraceLog?.() ?? "(no mesh trace hook)";
    for (const line of text.split("\n")) {
        appendLog(log, line.length ? line : " ");
    }
}

function cmdClear(_opts: DebugConsoleOptions, log: HTMLPreElement): void {
    log.textContent = "";
}

function cmdEnv(_opts: DebugConsoleOptions, log: HTMLPreElement): void {
    appendLog(log, `MODE=${import.meta.env.MODE} PROD=${import.meta.env.PROD}`);
    const base = import.meta.env.BASE_URL;
    if (base) appendLog(log, `BASE_URL=${base}`);
    const socketEnv = import.meta.env.VITE_SOCKET_URL as string | undefined;
    if (socketEnv) appendLog(log, `VITE_SOCKET_URL=${socketEnv}`);
    const server = import.meta.env.VITE_SERVER_URL as string | undefined;
    if (server) appendLog(log, `VITE_SERVER_URL=${server}`);
    try {
        const s = sessionStorage.getItem(API_BASE_SESSION_KEY);
        appendLog(log, s ? `session_api_base=${s}` : "session_api_base=(none)");
    } catch {
        appendLog(log, "session_api_base=(unreadable)");
    }
    appendLog(log, `api_server_base=${resolveApiServerBaseUrl()}`);
}

function cmdClearSocket(_opts: DebugConsoleOptions, log: HTMLPreElement): void {
    clearStoredApiBase();
    appendLog(log, "session_api_base cleared — 再読込してください（F5）");
}

function cmdNet(opts: DebugConsoleOptions, log: HTMLPreElement): void {
    const ok = opts.isSocketConnected();
    const id = opts.getSocketId() ?? "-";
    appendLog(log, `socket_connected=${ok} socket_id=${id}`);
}

const DEBUG_COMMANDS: Record<string, CmdFn> = {
    help: (_o, log) => appendHelp(log),
    dinfo: (_o, log) => appendHelp(log),
    count: (opts, log) => appendLog(log, `participants=${opts.getParticipantCount()}`),
    voice: cmdVoiceSummary,
    connection: cmdVoiceSummary,
    vstatus: cmdVoiceStatusLine,
    vline: cmdVoiceStatusLine,
    vinfo: cmdVoiceInfo,
    voiceinfo: cmdVoiceInfo,
    vpeers: cmdVoicePeers,
    vmesh: cmdVMesh,
    vpolicy: cmdVoicePolicy,
    mic: (opts, log) =>
        appendLog(
            log,
            `voice_backend=${opts.getVoiceBackend()} mic_muted=${opts.getVoiceMicMuted()}`
        ),
    room: (opts, log) => appendLog(log, `room_id=${opts.getRoomId()}`),
    self: (opts, log) => {
        const id = opts.getSocketId() ?? "(no id)";
        appendLog(log, `name=${opts.getPlayerName()} socket_id=${id}`);
    },
    pos: (opts, log) => {
        const p = opts.getPlayerPosition();
        appendLog(log, `x=${p.x.toFixed(1)} y=${p.y.toFixed(1)}`);
    },
    xy: (opts, log) => {
        const p = opts.getPlayerPosition();
        appendLog(log, `x=${p.x.toFixed(1)} y=${p.y.toFixed(1)}`);
    },
    remotes: (opts, log) => appendLog(log, opts.getRemotePlayersDebug()),
    net: cmdNet,
    sock: cmdNet,
    share: (opts, log) => appendLog(log, opts.getScreenShareDebug()),
    env: cmdEnv,
    clearsocket: cmdClearSocket,
    clear: cmdClear,
    cls: cmdClear
};

export function bindDebugConsole(options: DebugConsoleOptions): void {
    const { form, input, log } = options;

    if (!form || !input || !log) {
        return;
    }

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const raw = input.value.trim();
        if (!raw) return;

        const key = normalizeDebugCmd(raw);
        const run = DEBUG_COMMANDS[key];
        if (run) {
            run(options, log);
        } else {
            appendLog(log, `不明なコマンド: ${raw} — /dinfo で一覧を確認してください`);
        }

        input.value = "";
    });
}
