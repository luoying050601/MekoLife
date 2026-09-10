import { formatRoomLabelJa } from "../ui/labels";

const MAX_LOG_LINES = 14;

function formatRoomLabel(roomId: string): string {
    return formatRoomLabelJa(roomId);
}

function stamp(): string {
    return new Date().toISOString().slice(11, 23);
}

export type DebugRoomEventSink = {
    enter(roomId: string): void;
    leave(roomId: string): void;
    transition(fromRoom: string, toRoom: string): void;
};

export function bindDebugRoomEvents(
    currentEl: HTMLElement | null,
    logEl: HTMLPreElement | null
): DebugRoomEventSink {
    const appendLog = (line: string): void => {
        if (!logEl) return;
        logEl.textContent += `[${stamp()}] ${line}\n`;
        const lines = logEl.textContent.split("\n").filter((l) => l.length > 0);
        if (lines.length > MAX_LOG_LINES) {
            logEl.textContent = lines.slice(-MAX_LOG_LINES).join("\n") + "\n";
        }
        logEl.scrollTop = logEl.scrollHeight;
    };

    const setCurrent = (roomId: string): void => {
        if (!currentEl) return;
        currentEl.textContent = `現在: ${formatRoomLabel(roomId)}`;
    };

    return {
        enter(roomId: string): void {
            setCurrent(roomId);
            appendLog(`入室: ${formatRoomLabel(roomId)}`);
        },
        leave(roomId: string): void {
            appendLog(`退室: ${formatRoomLabel(roomId)}`);
        },
        transition(fromRoom: string, toRoom: string): void {
            if (fromRoom === toRoom) return;
            appendLog(`退室: ${formatRoomLabel(fromRoom)}`);
            setCurrent(toRoom);
            appendLog(`入室: ${formatRoomLabel(toRoom)}`);
        }
    };
}
