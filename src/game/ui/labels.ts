/** Player-facing room names (Japanese). */
export function formatRoomLabelJa(roomId: string): string {
    if (roomId === "corridor") return "廊下";
    const match = /^room(\d+)$/i.exec(roomId);
    if (match) return `ルーム${match[1]}`;
    return roomId;
}
