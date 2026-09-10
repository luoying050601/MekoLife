import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { AccessToken } from "livekit-server-sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "dist");
const hasDist = fs.existsSync(path.join(distDir, "index.html"));

const PORT = Number(process.env.PORT || 3000);
const WORLD_WIDTH = 1280;
const WORLD_HEIGHT = 720;

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

if (!hasDist) {
  /** Dev-only: root has no game UI when Vite runs on :5173. */
  app.get("/", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html><meta charset="utf-8">
<title>MekoLife server</title>
<body style="font-family:system-ui;max-width:40rem;margin:2rem;line-height:1.5">
<h1>マルチプレイ用サーバー稼働中</h1>
<p>このポートは <strong>Socket.IO / API</strong> 専用です。ゲーム UI は別のポート（Vite）です。</p>
<ul>
<li>ゲーム：<strong><a href="http://localhost:5173">http://localhost:5173</a></strong>（Vite フロント）</li>
<li>ヘルス：<a href="/health">/health</a> は <code>{"ok":true}</code> を返します。</li>
</ul>
</body>`);
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function sanitizeLiveKitSegment(value, maxLen) {
  const s = String(value ?? "")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, maxLen);
  return s || "guest";
}

app.post("/api/livekit-token", async (req, res) => {
  const livekitUrl = process.env.LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!livekitUrl || !apiKey || !apiSecret) {
    return res.status(503).json({ error: "livekit_not_configured" });
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const roomId = sanitizeLiveKitSegment(body.roomId, 48);
  const identity = sanitizeLiveKitSegment(body.identity, 120);
  const displayName = String(body.displayName ?? "")
    .trim()
    .slice(0, 12) || "Guest";

  const livekitRoom = `mekolife_${roomId}`;

  try {
    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      name: displayName,
      ttl: "6h"
    });
    token.addGrant({
      roomJoin: true,
      room: livekitRoom,
      canPublish: true,
      canSubscribe: true
    });
    const jwt = await token.toJwt();
    res.json({ token: jwt, url: livekitUrl, room: livekitRoom });
  } catch (err) {
    console.error("livekit token error", err);
    res.status(500).json({ error: "token_failed" });
  }
});

const httpServer = http.createServer(app);
function allowSocketCors(origin, callback) {
  if (!origin) return callback(null, true);
  if (origin === "http://localhost:5173" || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
    return callback(null, origin);
  if (/\.trycloudflare\.com$/i.test(origin)) return callback(null, origin);
  if (/\.onrender\.com$/i.test(origin)) return callback(null, origin);
  if (/\.fly\.dev$/i.test(origin)) return callback(null, origin);
  if (hasDist) return callback(null, origin);
  return callback(null, false);
}

const io = new Server(httpServer, {
  cors: {
    origin: allowSocketCors,
    methods: ["GET", "POST"],
    credentials: false
  }
});

const MAX_FRAME_DATA_URL_LENGTH = 380000;

/**
 * rooms[roomId][socketId] = { id, name, x, y }
 */
const rooms = new Map();
/** roomShares[roomId] = Map<playerId, { playerId, name }> */
const roomShares = new Map();
/** socket.id → { count: number, resetAt: number } */
const dmRateLimit = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function clampPosition(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function computeSpawnPosition(playerIndex) {
  // Entrance / corridor on the Tiled map (x 544–736). Keep first spawn out of room1–room4.
  const cx = 640;
  const cy = 352;
  const ringRadius = 28;
  const angle = (playerIndex % 8) * (Math.PI / 4);
  return {
    x: clampPosition(cx + Math.cos(angle) * ringRadius, 24, WORLD_WIDTH - 24),
    y: clampPosition(cy + Math.sin(angle) * ringRadius, 24, WORLD_HEIGHT - 24)
  };
}

function getRoomShareMap(roomId) {
  let shareMap = roomShares.get(roomId);
  if (!shareMap) {
    shareMap = new Map();
    roomShares.set(roomId, shareMap);
  }
  return shareMap;
}

function listRoomShares(roomId) {
  const shareMap = roomShares.get(roomId);
  if (!shareMap) return [];
  return Array.from(shareMap.values());
}

function getRoomShare(roomId, playerId) {
  const shareMap = roomShares.get(roomId);
  return shareMap?.get(playerId);
}

function deleteRoomShare(roomId, playerId) {
  const shareMap = roomShares.get(roomId);
  if (!shareMap) return;
  shareMap.delete(playerId);
  if (shareMap.size === 0) {
    roomShares.delete(roomId);
  }
}

function ensureRoomShare(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return undefined;

  const player = room.get(socketId);
  if (!player) return undefined;

  const shareMap = getRoomShareMap(roomId);
  const existing = shareMap.get(socketId);
  if (existing) {
    return existing;
  }

  const payload = {
    playerId: socketId,
    name: player.name
  };
  shareMap.set(socketId, payload);
  io.in(roomId).emit("screen_share_start", payload);
  return payload;
}

/** Track pending screen share requests per room: roomId -> { requesterId, targetPlayerId } */
const pendingShareRequests = new Map();

function getPendingRequest(roomId) {
  return pendingShareRequests.get(roomId);
}

function setPendingRequest(roomId, requesterId, targetPlayerId) {
  pendingShareRequests.set(roomId, { requesterId, targetPlayerId });
}

function clearPendingRequest(roomId) {
  pendingShareRequests.delete(roomId);
}

io.on("connection", (socket) => {
  socket.on("join_room", ({ roomId, name, x, y }) => {
    const normalizedRoomId = sanitizeLiveKitSegment(roomId || "demo-room", 48);
    const normalizedName = String(name || "").trim().slice(0, 12) || "Guest";
    let previousPlayer;

    // Leave old room if already in one (for room changes during gameplay)
    const oldRoomId = socket.data.roomId;
    if (oldRoomId && oldRoomId !== normalizedRoomId) {
      const oldRoom = rooms.get(oldRoomId);
      if (oldRoom && oldRoom.has(socket.id)) {
        previousPlayer = oldRoom.get(socket.id);
        oldRoom.delete(socket.id);
        const activeShare = getRoomShare(oldRoomId, socket.id);
        if (activeShare) {
          deleteRoomShare(oldRoomId, socket.id);
          socket.to(oldRoomId).emit("screen_share_stop", { playerId: socket.id });
        }
      }
      socket.leave(oldRoomId);

      // Stop any screen shares the player was receiving from the old room
      socket.emit("screen_share_stop_all");
    }

    socket.data.roomId = normalizedRoomId;
    socket.join(normalizedRoomId);

    const room = getRoom(normalizedRoomId);
    const hasClientPos = Number.isFinite(Number(x)) && Number.isFinite(Number(y));
    const spawn = hasClientPos
      ? {
          x: clampPosition(Number(x), 24, WORLD_WIDTH - 24),
          y: clampPosition(Number(y), 24, WORLD_HEIGHT - 24)
        }
      : (previousPlayer ?? computeSpawnPosition(room.size));
    room.set(socket.id, {
      id: socket.id,
      name: normalizedName,
      x: spawn.x,
      y: spawn.y
    });

    // Send all other players (from all rooms) for global map view
    const allOtherPlayers = [];
    for (const [, r] of rooms) {
      for (const player of r.values()) {
        if (player.id !== socket.id) {
          allOtherPlayers.push(player);
        }
      }
    }
    // Include local player's room info so client knows which room to filter by
    const localPlayer = room.get(socket.id);
    socket.emit("current_players", {
      players: allOtherPlayers,
      myRoomId: normalizedRoomId,
      myPlayer: localPlayer
    });

    const activeShares = listRoomShares(normalizedRoomId);
    for (const share of activeShares) {
      socket.emit("screen_share_start", share);
    }

    socket.broadcast.emit("player_joined", room.get(socket.id));
  });

  socket.on("player_move", ({ x, y }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.get(socket.id);
    if (!player) return;

    player.x = clampPosition(Number(x) || WORLD_WIDTH / 2, 24, WORLD_WIDTH - 24);
    player.y = clampPosition(Number(y) || WORLD_HEIGHT / 2, 24, WORLD_HEIGHT - 24);

    // Broadcast position to ALL OTHER clients (global map view)
    // Use socket.broadcast.emit() to send to all except the sender
    socket.broadcast.emit("player_moved", player);
  });

  socket.on("chat_message", (payload = {}) => {
    const { text } = (payload && typeof payload === "object") ? payload : {};
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.get(socket.id);
    if (!player) return;

    const sanitized = String(text || "").trim().slice(0, 200);
    if (!sanitized) return;

    io.in(roomId).emit("chat_message", {
      id: socket.id,
      name: player.name,
      text: sanitized
    });
  });

  socket.on("dm_message", (payload = {}) => {
    const { toId, text } = (payload && typeof payload === "object") ? payload : {};
    const roomId = socket.data.roomId;
    if (!roomId || !toId) return;

    // レートリミット: 5秒間に10件まで
    const now = Date.now();
    const rl = dmRateLimit.get(socket.id) ?? { count: 0, resetAt: now + 5000 };
    if (now > rl.resetAt) {
      rl.count = 0;
      rl.resetAt = now + 5000;
    }
    rl.count++;
    dmRateLimit.set(socket.id, rl);
    if (rl.count > 10) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const fromPlayer = room.get(socket.id);
    if (!fromPlayer) return;

    // DM はルームをまたいで送信可能 — 受信者が任意のルームにいるか確認
    let toExists = false;
    for (const [, r] of rooms) {
      if (r.has(toId)) { toExists = true; break; }
    }
    if (!toExists) return;

    const sanitized = String(text || "").trim().slice(0, 200);
    if (!sanitized) return;

    const msg = {
      fromId: socket.id,
      fromName: fromPlayer.name,
      fromRoomId: roomId,
      toId,
      text: sanitized
    };

    io.to(toId).emit("dm_message", msg);
    // 送信者へのエコーはクライアント側で1回だけ表示するため不要
  });

  socket.on("screen_share_start", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.get(socket.id);
    if (!player) return;

    const payload = {
      playerId: socket.id,
      name: player.name
    };

    const shareMap = getRoomShareMap(roomId);
    shareMap.set(socket.id, payload);
    io.in(roomId).emit("screen_share_start", payload);
  });

  socket.on("screen_share_stop", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const activeShare = getRoomShare(roomId, socket.id);
    if (!activeShare) return;

    deleteRoomShare(roomId, socket.id);
    io.in(roomId).emit("screen_share_stop", { playerId: socket.id });
  });

  socket.on("screen_share_offer", ({ toPlayerId, offer }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !toPlayerId) return;

    const room = rooms.get(roomId);
    if (!room || !room.has(toPlayerId)) return;

    const activeShare = ensureRoomShare(roomId, socket.id);
    if (!activeShare) return;

    io.to(toPlayerId).emit("screen_share_offer", {
      fromPlayerId: socket.id,
      offer
    });
  });

  socket.on("screen_share_answer", ({ toPlayerId, answer }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !toPlayerId) return;

    const room = rooms.get(roomId);
    if (!room || !room.has(toPlayerId)) return;

    io.to(toPlayerId).emit("screen_share_answer", {
      fromPlayerId: socket.id,
      answer
    });
  });

  socket.on("screen_share_ice", ({ toPlayerId, candidate }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !toPlayerId) return;

    const room = rooms.get(roomId);
    if (!room || !room.has(toPlayerId)) return;

    io.to(toPlayerId).emit("screen_share_ice", {
      fromPlayerId: socket.id,
      candidate
    });
  });

  socket.on("screen_share_frame", ({ imageDataUrl }) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof imageDataUrl !== "string") return;

    const activeShare = ensureRoomShare(roomId, socket.id);
    if (!activeShare) return;

    if (imageDataUrl.length > MAX_FRAME_DATA_URL_LENGTH) return;

    socket.to(roomId).emit("screen_share_frame", {
      fromPlayerId: socket.id,
      imageDataUrl
    });
  });

  socket.on("screen_share_request", ({ targetPlayerId }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !targetPlayerId) return;

    const room = rooms.get(roomId);
    if (!room || !room.has(socket.id)) return;

    const requester = room.get(socket.id);
    if (!requester) return;

    // Route request to the actual active sharer to avoid stale client target id.
    const shareMap = roomShares.get(roomId);
    if (!shareMap || shareMap.size === 0) {
      io.to(socket.id).emit("screen_share_request_response", {
        requesterId: socket.id,
        approved: false,
        decision: "deny"
      });
      return;
    }

    let actualTargetPlayerId = targetPlayerId;
    if (!shareMap.has(actualTargetPlayerId)) {
      actualTargetPlayerId = Array.from(shareMap.keys())[0];
    }
    if (!actualTargetPlayerId || !room.has(actualTargetPlayerId)) {
      io.to(socket.id).emit("screen_share_request_response", {
        requesterId: socket.id,
        approved: false,
        decision: "deny"
      });
      return;
    }

    // Set pending request and notify target
    setPendingRequest(roomId, socket.id, actualTargetPlayerId);
    io.to(actualTargetPlayerId).emit("screen_share_request", {
      fromPlayerId: socket.id,
      fromPlayerName: requester.name,
      targetPlayerId: actualTargetPlayerId
    });
  });

  socket.on("screen_share_request_response", ({ requesterId, approved, decision }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !requesterId) return;

    const pending = getPendingRequest(roomId);
    if (!pending || pending.requesterId !== requesterId || pending.targetPlayerId !== socket.id) {
      return;
    }

    clearPendingRequest(roomId);

    const normalizedDecision = approved
      ? (decision === "parallel" ? "parallel" : "takeover")
      : "deny";

    if (normalizedDecision === "takeover") {
      // Current sharer (socket) stops, requester will start.
      const activeShare = getRoomShare(roomId, socket.id);
      if (activeShare) {
        deleteRoomShare(roomId, socket.id);
        io.in(roomId).emit("screen_share_stop", { playerId: socket.id });
      }
    }

    // Notify requester of decision
    io.to(requesterId).emit("screen_share_request_response", {
      requesterId: requesterId,
      approved: normalizedDecision !== "deny",
      decision: normalizedDecision
    });
  });

  function relayVoiceWebRtc(roomId, toPlayerId) {
    const room = rooms.get(roomId);
    if (!room || !toPlayerId) return false;
    return room.has(toPlayerId) && room.has(socket.id);
  }

  socket.on("voice_webrtc_offer", ({ toPlayerId, offer }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !relayVoiceWebRtc(roomId, toPlayerId)) return;
    io.to(toPlayerId).emit("voice_webrtc_offer", {
      fromPlayerId: socket.id,
      offer
    });
  });

  socket.on("voice_webrtc_answer", ({ toPlayerId, answer }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !relayVoiceWebRtc(roomId, toPlayerId)) return;
    io.to(toPlayerId).emit("voice_webrtc_answer", {
      fromPlayerId: socket.id,
      answer
    });
  });

  socket.on("voice_webrtc_ice", ({ toPlayerId, candidate }) => {
    const roomId = socket.data.roomId;
    if (!roomId || !relayVoiceWebRtc(roomId, toPlayerId)) return;
    io.to(toPlayerId).emit("voice_webrtc_ice", {
      fromPlayerId: socket.id,
      candidate
    });
  });

  socket.on("voice_mic_state", ({ micMuted }) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof micMuted !== "boolean") return;
    socket.to(roomId).emit("voice_mic_state", {
      fromPlayerId: socket.id,
      micMuted
    });
  });

  socket.on("voice_muted_speaking", ({ speaking }) => {
    const roomId = socket.data.roomId;
    if (!roomId || typeof speaking !== "boolean") return;
    socket.to(roomId).emit("voice_muted_speaking", {
      fromPlayerId: socket.id,
      speaking
    });
  });

  socket.on("disconnect", () => {
    dmRateLimit.delete(socket.id);
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const activeShare = getRoomShare(roomId, socket.id);
    if (activeShare) {
      deleteRoomShare(roomId, socket.id);
      socket.to(roomId).emit("screen_share_stop", { playerId: socket.id });
    }

    room.delete(socket.id);
    socket.broadcast.emit("player_left", { playerId: socket.id });

    if (room.size === 0) {
      rooms.delete(roomId);
      roomShares.delete(roomId);
    }
  });
});

if (hasDist) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/|\/health$|\/socket\.io).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  MekoLife Server Started             ║`);
  console.log(`╚════════════════════════════════════════╝`);
  console.log(`Listening: 0.0.0.0:${PORT}`);
  console.log(`Static UI: ${hasDist ? "dist/ (production)" : "none — use Vite :5173"}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`\nVoice Configuration:`);
  const hasLiveKit = process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET;
  console.log(`  LiveKit configured: ${hasLiveKit ? '✓ YES' : '✗ NO'}`);
  if (hasLiveKit) {
    console.log(`  URL: ${process.env.LIVEKIT_URL}`);
  }
  console.log(`  Policy: LiveKit only (LIVEKIT_* required)`);
  console.log(`\nReady to accept connections.\n`);
});
