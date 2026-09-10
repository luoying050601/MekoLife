import Phaser from "phaser";
import { PlayerEntity } from "../entities/PlayerEntity";
import type { ChatMessage, DirectMessage, GameTransport, NetworkPlayer, PlayerMovePayload } from "../network/types";
import { bindDebugConsole } from "../debug/DebugConsole";
import { bindDebugRoomEvents, type DebugRoomEventSink } from "../debug/DebugRoomEvents";
import { ScreenShareController } from "../screenshare/ScreenShareController";
import { VoiceChatRouter } from "../voice/VoiceChatRouter";
import {
  getVoiceBackendPolicySummary,
  PROXIMITY_VOICE_CONNECT_PX,
  PROXIMITY_VOICE_DROP_PX
} from "../voice/voiceConstants";
import { resolveApiServerBaseUrl } from "../network/serverOrigin";
import { ParticipantVolumeMenu } from "../ui/ParticipantVolumeMenu";
import { formatRoomLabelJa } from "../ui/labels";

type MainSceneData = {
  playerName: string;
  roomId: string;
  transport: GameTransport;
  onChatMessage?: (msg: ChatMessage) => void;
  onDirectMessage?: (msg: DirectMessage) => void;
  onPlayersChanged?: (players: { id: string; name: string }[]) => void;
  onRoomChanged?: (roomId: string) => void;
};

const DEFAULT_WORLD_WIDTH = 1280;
const DEFAULT_WORLD_HEIGHT = 720;
const PLAYER_SPEED = 220;
const PLAYER_HALF = 21;
const CAMERA_ZOOM_LEVELS = [0.5, 0.75, 1, 2] as const;
const DEFAULT_CAMERA_ZOOM_INDEX = 2;
const CAMERA_WHEEL_DELTA_THRESHOLD = 400;
const CAMERA_TRACKPAD_PINCH_DELTA_THRESHOLD = 75;
const CAMERA_PINCH_STEP_RATIO = 0.12;
const CAMERA_ZOOM_STEP_COOLDOWN_MS = 180;
const CAMERA_TRACKPAD_PAN_MAX_DELTA = 80;
const CAMERA_TRACKPAD_PAN_SESSION_MS = 250;
const CAMERA_FOLLOW_LERP = 0.015;
const CAMERA_FOLLOW_RETURN_LOCK_MS = 300;
const MAP_JSON_URL = new URL("../../../map/MekoLifeMapData.json", import.meta.url).toString();
const TILESET_IMAGE_URL = new URL("../../../map/roguelikeSheet_transparent_32.png", import.meta.url).toString();
const TILESET_NAME = "roguelikeSheet_transparent_32";
const TILESET_IMAGE_KEY = "roguelike-sheet";
const WALL_LAYER_NAME = "Wall";
const ROOM_OBJECT_LAYER_NAMES = ["Rooms", "MekoLifeMapData"] as const;

type PixelRect = { x: number; y: number; w: number; h: number };
type RoomRect = { x: number; y: number; w: number; h: number };

function mergeWallRectsVertically(rects: PixelRect[]): PixelRect[] {
  const byKey = new Map<string, PixelRect[]>();
  for (const r of rects) {
    const key = `${r.x}|${r.w}`;
    let g = byKey.get(key);
    if (!g) {
      g = [];
      byKey.set(key, g);
    }
    g.push(r);
  }
  const out: PixelRect[] = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => a.y - b.y);
    let cur = { ...group[0] };
    for (let i = 1; i < group.length; i++) {
      const r = group[i];
      if (Math.abs(cur.y + cur.h - r.y) < 1e-4) {
        cur.h += r.h;
      } else {
        out.push(cur);
        cur = { ...r };
      }
    }
    out.push(cur);
  }
  return out;
}

/** Horizontal spans per row of wall cells → merged vertically where x/w match. */
function buildWallRectsFromLayer(layer: Phaser.Tilemaps.TilemapLayer): PixelRect[] {
  const rows = layer.layer.height;
  const cols = layer.layer.width;
  const cellW = layer.tilemap.tileWidth;
  const cellH = layer.tilemap.tileHeight;
  const rowRects: PixelRect[] = [];

  for (let cy = 0; cy < rows; cy++) {
    let cx = 0;
    while (cx < cols) {
      const tile = layer.getTileAt(cx, cy);
      if (!tile || tile.index === -1) {
        cx++;
        continue;
      }
      const x0 = cx;
      while (cx < cols) {
        const nextTile = layer.getTileAt(cx, cy);
        if (!nextTile || nextTile.index === -1) break;
        cx++;
      }
      rowRects.push({
        x: x0 * cellW,
        y: cy * cellH,
        w: (cx - x0) * cellW,
        h: cellH
      });
    }
  }
  return mergeWallRectsVertically(rowRects);
}

function playerOverlapsWalls(px: number, py: number, half: number, walls: PixelRect[]): boolean {
  const l = px - half;
  const r = px + half;
  const t = py - half;
  const b = py + half;
  for (const w of walls) {
    if (r <= w.x || l >= w.x + w.w || b <= w.y || t >= w.y + w.h) continue;
    return true;
  }
  return false;
}

/** Wait for first `current_players` so voice joins the correct LiveKit room. */
const INITIAL_ROSTER_WAIT_MS = 4000;
const MIC_OFF_TOAST_MIN_MS = 5000;

export class MainScene extends Phaser.Scene {
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private player!: PlayerEntity;
  private playerName = "";
  private roomId = "corridor";  // Will be set by init()
  private transport!: GameTransport;
  private screenShare!: ScreenShareController;
  private voiceRouter?: VoiceChatRouter;
  private participantVolumeMenu?: ParticipantVolumeMenu;
  private debugRoomEvents?: DebugRoomEventSink;
  private readonly speakingPeerIds = new Set<string>();
  private readonly micOffSpeakingPeerIds = new Set<string>();
  private micOffToastEl: HTMLDivElement | null = null;
  private micOffToastShownAt = 0;
  private micOffToastHideTimer = 0;
  private lastMoveSentAt = 0;
  private remotePlayers = new Map<string, PlayerEntity>();
  private remotePlayerNames = new Map<string, string>();
  private allOnlinePlayerNames = new Map<string, string>();
  private playerRoomMap = new Map<string, string>();
  /** Corridor WebRTC: remotes currently in hearing range. */
  private readonly proximityPeerIds = new Set<string>();
  private lastProximityRetryAt = 0;
  private onChatMessage?: (msg: ChatMessage) => void;
  private onDirectMessage?: (msg: DirectMessage) => void;
  private onPlayersChanged?: (players: { id: string; name: string }[]) => void;
  private onRoomChanged?: (roomId: string) => void;
  private initialRosterWait!: Promise<void>;
  private resolveInitialRosterOnce?: () => void;
  /** Cached so `update` does not query the DOM every frame. */
  private chatInputEl: HTMLInputElement | null = null;
  /** Solid walls in world pixels (AABB). Movement uses these, not per-cell checks. */
  private wallRects!: PixelRect[];
  private worldWidth = DEFAULT_WORLD_WIDTH;
  private worldHeight = DEFAULT_WORLD_HEIGHT;
  private activePinchDistance?: number;
  private accumulatedWheelDelta = 0;
  private cameraZoomIndex = DEFAULT_CAMERA_ZOOM_INDEX;
  private cameraDragPointerId?: number;
  private cameraDragLastX = 0;
  private cameraDragLastY = 0;
  private isCameraManuallyPanned = false;
  private lastZoomStepAt = 0;
  private manualPanBlockedUntil = 0;
  private trackpadPanUntil = 0;
  private readonly roomAreas = new Map<string, RoomRect>();
  private readonly roomOrder = ["room1", "room2", "room3", "room4"] as const;

  constructor() {
    super("main-scene");
  }

  private applyLocalRoomChange(nextRoomId: string): void {
    const prev = this.roomId;
    if (prev === nextRoomId) return;
    this.debugRoomEvents?.transition(prev, nextRoomId);
    this.roomId = nextRoomId;

    const topRoomLabel = document.getElementById("top-room-label") as HTMLSpanElement | null;
    if (topRoomLabel) {
      topRoomLabel.textContent = `ルーム: ${formatRoomLabelJa(nextRoomId)}`;
    }

    this.screenShare.setCurrentRoomId(this.roomId);

    this.emitJoinRoom();

    this.refreshProximityVoice();
    this.updateParticipantsPanel();
    this.voiceRouter?.onLocalTileRoomChanged(prev, nextRoomId);
    this.onRoomChanged?.(nextRoomId);
  }

  /** Get room ID (room1-room4) based on player position on map */
  private getRoomIdFromPosition(x: number, y: number): string {
    const BOUNDARY_BUFFER = 20;
    if (this.roomId !== "corridor") {
      const current = this.roomAreas.get(this.roomId);
      if (current && this.pointInRoom(x, y, current, BOUNDARY_BUFFER)) {
        return this.roomId;
      }
    }

    return this.getRoomIdFromPositionRaw(x, y);
  }

  /** Pure position-based room detection without hysteresis — used for remote players */
  private getRoomIdFromPositionRaw(x: number, y: number): string {
    for (const roomId of this.roomOrder) {
      const rect = this.roomAreas.get(roomId);
      if (rect && this.pointInRoom(x, y, rect, 0)) {
        return roomId;
      }
    }
    return "corridor";
  }

  init(data: MainSceneData): void {
    this.playerName = data.playerName;
    this.roomId = data.roomId;
    this.transport = data.transport;
    this.onChatMessage = data.onChatMessage;
    this.onDirectMessage = data.onDirectMessage;
    this.onPlayersChanged = data.onPlayersChanged;
    this.onRoomChanged = data.onRoomChanged;
  }

  create(): void {
    this.cameras.main.setBackgroundColor("#000000");
    this.cameras.main.roundPixels = true;
    this.buildTilemap();

    const initialSpawn = this.getInitialSpawnPosition();
    this.player = new PlayerEntity(this, initialSpawn.x, initialSpawn.y, this.playerName, 0x38bdf8, 0x0ea5e9);
    this.cameras.main.setBounds(0, 0, this.worldWidth, this.worldHeight);
    this.startCameraFollow();
    this.bindMapCameraControls();

    // Assign room based on player starting position, then update UI
    const playerPos = this.player.getPosition();
    this.roomId = this.getRoomIdFromPosition(playerPos.x, playerPos.y);
    const topRoomLabel = document.getElementById("top-room-label") as HTMLSpanElement;
    if (topRoomLabel) {
      topRoomLabel.textContent = `ルーム: ${formatRoomLabelJa(this.roomId)}`;
    }

    const keyboard = this.input.keyboard;
    if (!keyboard) {
      throw new Error("Keyboard input is unavailable in this scene.");
    }
    this.cursors = keyboard.createCursorKeys();
    // スペースキーが Phaser にキャプチャされると DOM 入力欄で空白が打てなくなるため解除
    keyboard.removeCapture(Phaser.Input.Keyboard.KeyCodes.SPACE);
    this.chatInputEl = document.getElementById("chat-input") as HTMLInputElement | null;
    const apiBase = resolveApiServerBaseUrl().replace(/\/$/, "");

    this.screenShare = new ScreenShareController({
      localPlayerName: this.playerName,
      getLocalPlayerId: () => this.transport.getSocketId(),
      getAudienceIds: () =>
        this.roomId === "corridor" ? [] : Array.from(this.remotePlayerNames.keys()),
      getParticipantCount: () => this.remotePlayerNames.size + 1,
      tokenApiUrl: `${apiBase}/api/livekit-token`,
      getRoomId: () => this.roomId,
      getDisplayName: () => this.playerName,
      transport: this.transport
    });

    this.screenShare.bindUi({
      startButton: document.getElementById("share-start") as HTMLButtonElement | null,
      stopButton: document.getElementById("share-stop") as HTMLButtonElement | null,
      statusText: document.getElementById("share-status") as HTMLParagraphElement | null
    });

    // Set initial room for screen share controller
    this.screenShare.setCurrentRoomId(this.roomId);

    const screenHandlers = this.screenShare.getSignalHandlers();

    this.voiceRouter = new VoiceChatRouter({
      transport: this.transport,
      tokenApiUrl: `${apiBase}/api/livekit-token`,
      getRoomId: () => this.roomId,
      getDisplayName: () => this.playerName,
      getParticipantCount: () => this.remotePlayerNames.size + 1,
      getRemotePlayerIds: () =>
        this.roomId === "corridor"
          ? [...this.proximityPeerIds]
          : Array.from(this.remotePlayerNames.keys()),
      getPlayerNameForId: (id) =>
        this.remotePlayerNames.get(id) ??
        this.allOnlinePlayerNames.get(id) ??
        id.slice(0, 8),
      onSpeakingPeersChanged: (ids) => {
        this.speakingPeerIds.clear();
        for (const id of ids) {
          this.speakingPeerIds.add(id);
        }
        this.updateParticipantSpeakingStates();
      },
      onMicOffSpeakingChanged: (ids) => {
        this.micOffSpeakingPeerIds.clear();
        for (const id of ids) {
          this.micOffSpeakingPeerIds.add(id);
        }
        this.updateParticipantSpeakingStates();
        this.updateMicOffToast();
      }
    });
    this.voiceRouter.bindUi({
      muteButton: document.getElementById("voice-mute") as HTMLButtonElement | null
    });
    this.ensureMicOffToast();
    this.participantVolumeMenu = new ParticipantVolumeMenu({
      getPeerVolume: (playerId) => this.voiceRouter?.getPeerVolume(playerId) ?? 1,
      onVolumeChange: (playerId, volume) => this.voiceRouter?.setPeerVolume(playerId, volume)
    });
    const voiceMeshHandlers = this.voiceRouter.getMeshSignalHandlers();

    this.initialRosterWait = new Promise<void>((resolve) => {
      this.resolveInitialRosterOnce = () => {
        if (!this.resolveInitialRosterOnce) return;
        this.resolveInitialRosterOnce = undefined;
        resolve();
      };
    });

    this.transport.setHandlers({
      onCurrentPlayers: (data) => {
        // Handle both old format (array) and new format (object with myRoomId)
        let players: NetworkPlayer[] = [];
        let myRoomId: string | undefined;

        if (Array.isArray(data)) {
          players = data;
        } else {
          players = data.players || [];
          myRoomId = data.myRoomId;
        }

        if (myRoomId) {
          console.log(`[onCurrentPlayers] Server socket room=${myRoomId}, local tile room=${this.roomId}`);
        }

        this.pruneRosterToSnapshot(new Set(players.map((player) => player.id)), screenHandlers);

        // Add all players to remote map (god's eye view) and to allOnlinePlayerNames
        for (const player of players) {
          this.allOnlinePlayerNames.set(player.id, player.name);
          const playerRoom = this.getRoomIdFromPositionRaw(player.x, player.y);
          this.playerRoomMap.set(player.id, playerRoom);

          const isRoomMate = this.roomId !== "corridor" && playerRoom === this.roomId;
          if (isRoomMate) {
            this.remotePlayerNames.set(player.id, player.name);
          }
          console.log(`[onCurrentPlayers] ${player.name} at (${player.x}, ${player.y}) -> room=${playerRoom}, isMate=${isRoomMate}`);

          this.upsertRemotePlayer(player, isRoomMate);
        }
        this.refreshProximityVoice();
        this.updateParticipantsPanel();
        screenHandlers.onCurrentPlayers(players);
        this.resolveInitialRosterOnce?.();
        this.voiceRouter?.onRoomRosterChanged();
      },
      onPlayerJoined: (player) => {
        this.allOnlinePlayerNames.set(player.id, player.name);
        const playerRoom = this.getRoomIdFromPositionRaw(player.x, player.y);
        this.playerRoomMap.set(player.id, playerRoom);
        const sameTileRoom = this.roomId !== "corridor" && playerRoom === this.roomId;
        if (sameTileRoom) {
          this.remotePlayerNames.set(player.id, player.name);
        }
        this.upsertRemotePlayer(player, sameTileRoom);
        this.refreshProximityVoice();
        this.updateParticipantsPanel();
        if (sameTileRoom) {
          screenHandlers.onPlayerJoined(player);
          this.voiceRouter?.onRemotePlayerJoined(player.id, playerRoom);
        }
        this.voiceRouter?.onRoomRosterChanged();
        this.voiceRouter?.rebroadcastMicState();
      },
      onPlayerMoved: (player) => {
        this.allOnlinePlayerNames.set(player.id, player.name);

        // Update position for all players (map view)
        this.upsertRemotePlayer(player, false);

        // Check if player moved to a different room and update room membership
        const newRoom = this.getRoomIdFromPositionRaw(player.x, player.y);
        const oldRoom = this.playerRoomMap.get(player.id);

        // If we haven't tracked this player yet, initialize their room
        if (oldRoom === undefined) {
          this.playerRoomMap.set(player.id, newRoom);
          if (this.roomId !== "corridor" && newRoom === this.roomId) {
            this.remotePlayerNames.set(player.id, player.name);
            this.voiceRouter?.onRemotePlayerJoined(player.id, newRoom);
          }
          this.refreshProximityVoice();
          this.updateParticipantsPanel();
          return;
        }

        if (oldRoom !== newRoom) {
          this.playerRoomMap.set(player.id, newRoom);

          if (oldRoom === this.roomId && newRoom !== this.roomId) {
            this.remotePlayerNames.delete(player.id);
            this.voiceRouter?.onRemotePlayerLeft(player.id);
          } else if (
            this.roomId !== "corridor" &&
            oldRoom !== this.roomId &&
            newRoom === this.roomId
          ) {
            this.remotePlayerNames.set(player.id, player.name);
            this.voiceRouter?.onRemotePlayerJoined(player.id, newRoom);
          }

          this.refreshProximityVoice();
          this.updateParticipantsPanel();
          return;
        }

        if (this.refreshProximityVoice()) {
          this.updateParticipantsPanel();
        }
      },
      onPlayerLeft: (playerId) => {
        this.allOnlinePlayerNames.delete(playerId);
        this.proximityPeerIds.delete(playerId);
        this.voiceRouter?.onRemotePlayerLeft(playerId);
        this.removeRemotePlayer(playerId);
        this.refreshProximityVoice();
        this.updateParticipantsPanel();
        screenHandlers.onPlayerLeft(playerId);
        this.voiceRouter?.onRoomRosterChanged();
      },
      onChatMessage: (msg) => this.onChatMessage?.(msg),
      onDirectMessage: (msg) => this.onDirectMessage?.(msg),
      onScreenShareStart: (payload) => screenHandlers.onScreenShareStart(payload),
      onScreenShareStop: (payload) => screenHandlers.onScreenShareStop(payload),
      onScreenShareStopAll: () => screenHandlers.onScreenShareStopAll(),
      onScreenShareOffer: (payload) => screenHandlers.onScreenShareOffer(payload),
      onScreenShareAnswer: (payload) => screenHandlers.onScreenShareAnswer(payload),
      onScreenShareIce: (payload) => screenHandlers.onScreenShareIce(payload),
      onScreenShareFrame: (payload) => screenHandlers.onScreenShareFrame(payload),
      onScreenShareRequest: (payload) => screenHandlers.onScreenShareRequest(payload),
      onScreenShareRequestResponse: (payload) => screenHandlers.onScreenShareRequestResponse(payload),
      onVoiceWebRtcOffer: (payload) => voiceMeshHandlers.onVoiceWebRtcOffer?.(payload),
      onVoiceWebRtcAnswer: (payload) => voiceMeshHandlers.onVoiceWebRtcAnswer?.(payload),
      onVoiceWebRtcIce: (payload) => voiceMeshHandlers.onVoiceWebRtcIce?.(payload),
      onVoiceMicState: (payload) =>
        this.voiceRouter?.handleRemoteMicState(payload.fromPlayerId, payload.micMuted),
      onVoiceMutedSpeaking: (payload) =>
        this.voiceRouter?.handleRemoteMutedSpeaking(payload.fromPlayerId, payload.speaking),
      onSocketReconnected: () => {
        this.emitJoinRoom();
        this.voiceRouter?.reconnectMedia();
      }
    });

    this.debugRoomEvents = bindDebugRoomEvents(
      document.getElementById("debug-room-current"),
      document.getElementById("debug-room-log") as HTMLPreElement | null
    );
    this.debugRoomEvents.enter(this.roomId);

    this.bindDebugConsoleEarly();

    console.log(`%cGame Scene Ready: ${this.playerName} joining "${this.roomId}"`, `color: #10b981;`);
    console.log(
      `Debug commands available: /vpolicy, /count, /voice, /vinfo, /env — type /dinfo for full list`
    );

    this.transport.connect();
    void this.connectSocketAndJoinRoom();

    this.updateParticipantsPanel();

    void this.bootVoiceAndDebug();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.shutdown());
  }

  update(_time: number, deltaMs: number): void {
    this.updatePinchZoom();

    const current = this.player.getPosition();
    const chatFocused = this.isChatFocused();
    let dx = 0;
    let dy = 0;

    if (!chatFocused) {
      const delta = deltaMs / 1000;
      const speed = PLAYER_SPEED * delta;

      if (this.cursors.left.isDown) dx -= 1;
      if (this.cursors.right.isDown) dx += 1;
      if (this.cursors.up.isDown) dy -= 1;
      if (this.cursors.down.isDown) dy += 1;

      if (dx !== 0 || dy !== 0) {
        this.manualPanBlockedUntil = this.time.now + CAMERA_FOLLOW_RETURN_LOCK_MS;
        this.resumeCameraFollow();
        this.voiceRouter?.noteMicActivity();
      }

      if (dx !== 0 && dy !== 0) {
        const normalization = Math.sqrt(2);
        dx /= normalization;
        dy /= normalization;
      }

      const half = PLAYER_HALF;
      const rawX = current.x + dx * speed;
      const rawY = current.y + dy * speed;
      const cx = Phaser.Math.Clamp(rawX, half, this.worldWidth - half);
      const cy = Phaser.Math.Clamp(rawY, half, this.worldHeight - half);

      const walls = this.wallRects;
      let nextX = current.x;
      let nextY = current.y;
      if (!playerOverlapsWalls(cx, cy, half, walls)) {
        nextX = cx;
        nextY = cy;
      } else if (!playerOverlapsWalls(cx, current.y, half, walls)) {
        nextX = cx;
      } else if (!playerOverlapsWalls(current.x, cy, half, walls)) {
        nextY = cy;
      }
      this.player.setPosition(nextX, nextY);

      // Check if room has changed based on new position
      const newRoomId = this.getRoomIdFromPosition(nextX, nextY);
      if (newRoomId !== this.roomId) {
        console.log(`%cMoved to ${newRoomId}`, `color: #f59e0b;`);
        this.applyLocalRoomChange(newRoomId);
      }
    }

    this.publishMove(this.player.getPosition().x, this.player.getPosition().y, dx, dy);

    if (this.refreshProximityVoice()) {
      this.updateParticipantsPanel();
    } else if (this.roomId === "corridor") {
      const now = this.time.now;
      if (now - this.lastProximityRetryAt >= 1000) {
        this.lastProximityRetryAt = now;
        this.voiceRouter?.syncVoicePeersToRoom();
      }
    }

    const selfId = this.transport.getSocketId();
    if (selfId) {
      this.player.setSpeakingHighlight(this.speakingPeerIds.has(selfId));
    }
    for (const [id, remote] of this.remotePlayers) {
      remote.setSpeakingHighlight(this.speakingPeerIds.has(id));
    }
  }

  preload(): void {
    this.load.tilemapTiledJSON("mekolife-map", MAP_JSON_URL);
    this.load.image(TILESET_IMAGE_KEY, TILESET_IMAGE_URL);
  }

  private buildTilemap(): void {
    const map = this.make.tilemap({ key: "mekolife-map" });
    const tileset = map.addTilesetImage(TILESET_NAME, TILESET_IMAGE_KEY);
    if (!tileset) {
      throw new Error(`Tileset '${TILESET_NAME}' could not be loaded from Tiled data.`);
    }

    this.wallRects = [];
    let tileLayerDepth = -50;
    for (const layerData of map.layers) {
      const layer = map.createLayer(layerData.name, tileset, 0, 0);
      if (!layer) continue;
      layer.setDepth(tileLayerDepth++);
      layer.setVisible(layerData.visible);

      if (layerData.name === WALL_LAYER_NAME) {
        this.wallRects = buildWallRectsFromLayer(layer);
      }
    }

    this.worldWidth = map.widthInPixels;
    this.worldHeight = map.heightInPixels;
    this.loadRoomAreasFromMap(map);
    this.addRoomLabelsFromAreas();
  }

  private getInitialSpawnPosition(): { x: number; y: number } {
    return {
      x: this.worldWidth / 4,
      y: this.worldHeight / 4
    };
  }

  private bindMapCameraControls(): void {
    this.input.addPointer(2);

    this.input.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      if (pointer.wasTouch || !pointer.leftButtonDown()) return;
      this.cameraDragPointerId = pointer.id;
      this.cameraDragLastX = pointer.x;
      this.cameraDragLastY = pointer.y;
    });

    this.input.on(Phaser.Input.Events.POINTER_MOVE, (pointer: Phaser.Input.Pointer) => {
      if (pointer.id !== this.cameraDragPointerId || pointer.wasTouch || !pointer.isDown) return;

      const deltaX = this.cameraDragLastX - pointer.x;
      const deltaY = this.cameraDragLastY - pointer.y;
      this.cameraDragLastX = pointer.x;
      this.cameraDragLastY = pointer.y;
      if (deltaX === 0 && deltaY === 0) return;

      this.panCameraByScreenDelta(deltaX, deltaY);
    });

    this.input.on(
      Phaser.Input.Events.POINTER_WHEEL,
      (
        pointer: Phaser.Input.Pointer,
        _over: Phaser.GameObjects.GameObject[],
        deltaX: number,
        deltaY: number
      ) => {
        if (this.isChatFocused()) return;
        if (this.isTrackpadPan(pointer, deltaX, deltaY)) {
          this.accumulatedWheelDelta = 0;
          this.panCameraByScreenDelta(deltaX, deltaY);
          return;
        }

        this.accumulatedWheelDelta += deltaY;
        const zoomDeltaThreshold = this.isTrackpadPinch(pointer)
          ? CAMERA_TRACKPAD_PINCH_DELTA_THRESHOLD
          : CAMERA_WHEEL_DELTA_THRESHOLD;
        if (Math.abs(this.accumulatedWheelDelta) < zoomDeltaThreshold) return;

        const zoomDirection = this.accumulatedWheelDelta > 0 ? -1 : 1;
        if (this.stepMapZoom(zoomDirection)) {
          this.accumulatedWheelDelta = 0;
        } else {
          this.accumulatedWheelDelta = Math.sign(this.accumulatedWheelDelta) * zoomDeltaThreshold;
        }
      }
    );

    this.input.on(Phaser.Input.Events.POINTER_UP, (pointer: Phaser.Input.Pointer) => {
      if (pointer.id === this.cameraDragPointerId) {
        this.cameraDragPointerId = undefined;
      }
      this.activePinchDistance = undefined;
      this.accumulatedWheelDelta = 0;
    });
    this.input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, (pointer: Phaser.Input.Pointer) => {
      if (pointer.id === this.cameraDragPointerId) {
        this.cameraDragPointerId = undefined;
      }
      this.activePinchDistance = undefined;
      this.accumulatedWheelDelta = 0;
    });
  }

  private isTrackpadPan(pointer: Phaser.Input.Pointer, deltaX: number, deltaY: number): boolean {
    const event = pointer.event;
    if (!(event instanceof WheelEvent) || event.ctrlKey) return false;

    const looksLikeTrackpadPan =
      Math.abs(deltaX) > 0 ||
      (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && Math.abs(deltaY) < CAMERA_TRACKPAD_PAN_MAX_DELTA);
    if (looksLikeTrackpadPan) {
      this.trackpadPanUntil = this.time.now + CAMERA_TRACKPAD_PAN_SESSION_MS;
    }

    return looksLikeTrackpadPan || this.time.now < this.trackpadPanUntil;
  }

  private isTrackpadPinch(pointer: Phaser.Input.Pointer): boolean {
    return pointer.event instanceof WheelEvent && pointer.event.ctrlKey;
  }

  private panCameraByScreenDelta(deltaX: number, deltaY: number): void {
    if (this.time.now < this.manualPanBlockedUntil) return;

    const camera = this.cameras.main;
    this.pauseCameraFollow();
    camera.setScroll(
      camera.clampX(camera.scrollX + deltaX / camera.zoom),
      camera.clampY(camera.scrollY + deltaY / camera.zoom)
    );
  }

  private pauseCameraFollow(): void {
    if (this.isCameraManuallyPanned) return;
    this.cameras.main.stopFollow();
    this.isCameraManuallyPanned = true;
  }

  private resumeCameraFollow(): void {
    if (!this.isCameraManuallyPanned) return;
    this.startCameraFollow();
  }

  private startCameraFollow(): void {
    this.cameras.main.startFollow(this.player.getBody(), true, CAMERA_FOLLOW_LERP, CAMERA_FOLLOW_LERP);
    this.isCameraManuallyPanned = false;
  }

  private stepMapZoom(direction: -1 | 1): boolean {
    const now = this.time.now;
    if (now - this.lastZoomStepAt < CAMERA_ZOOM_STEP_COOLDOWN_MS) return false;

    const nextZoomIndex = Phaser.Math.Clamp(
      this.cameraZoomIndex + direction,
      0,
      CAMERA_ZOOM_LEVELS.length - 1
    );
    if (nextZoomIndex === this.cameraZoomIndex) return false;

    this.cameraZoomIndex = nextZoomIndex;
    this.lastZoomStepAt = now;
    this.cameras.main.setZoom(CAMERA_ZOOM_LEVELS[this.cameraZoomIndex]);
    return true;
  }

  private updatePinchZoom(): void {
    if (this.isChatFocused()) return;

    const touchPointers = this.input.manager.pointers.filter((pointer) => pointer.isDown && pointer.wasTouch);
    if (touchPointers.length < 2) {
      this.activePinchDistance = undefined;
      return;
    }

    const [first, second] = touchPointers;
    const distance = Phaser.Math.Distance.Between(first.x, first.y, second.x, second.y);
    if (!Number.isFinite(distance) || distance <= 0) return;

    if (this.activePinchDistance === undefined) {
      this.activePinchDistance = distance;
      return;
    }

    const ratio = distance / this.activePinchDistance;
    if (ratio < 1 + CAMERA_PINCH_STEP_RATIO && ratio > 1 - CAMERA_PINCH_STEP_RATIO) return;

    if (this.stepMapZoom(ratio > 1 ? 1 : -1)) {
      this.activePinchDistance = distance;
    }
  }

  private loadRoomAreasFromMap(map: Phaser.Tilemaps.Tilemap): void {
    const objectLayer = ROOM_OBJECT_LAYER_NAMES.map((layerName) => map.getObjectLayer(layerName)).find(
      (layer) => layer !== null
    );
    if (!objectLayer) return;

    for (const obj of objectLayer.objects) {
      if (!obj.name) continue;
      const normalized = obj.name.trim().toLowerCase();
      if (!this.roomOrder.includes(normalized as (typeof this.roomOrder)[number])) {
        continue;
      }
      const width = obj.width ?? 0;
      const height = obj.height ?? 0;
      this.roomAreas.set(normalized, {
        x: obj.x ?? 0,
        y: obj.y ?? 0,
        w: width,
        h: height
      });
    }
  }

  private addRoomLabelsFromAreas(): void {
    const roomColors = new Map<string, number>([
      ["room1", 0xff4444],
      ["room2", 0xffff44],
      ["room3", 0x44ff44],
      ["room4", 0xffffff]
    ]);

    for (const roomId of this.roomOrder) {
      const rect = this.roomAreas.get(roomId);
      if (!rect) continue;
      const centerX = rect.x + rect.w / 2;
      const centerY = rect.y + rect.h / 2;
      const color = roomColors.get(roomId) ?? 0xffffff;
      this.addRoomLabel(formatRoomLabelJa(roomId), centerX, centerY, color);
    }
  }

  private pointInRoom(x: number, y: number, rect: RoomRect, buffer: number): boolean {
    return (
      x >= rect.x - buffer &&
      x <= rect.x + rect.w + buffer &&
      y >= rect.y - buffer &&
      y <= rect.y + rect.h + buffer
    );
  }

  private addRoomLabel(text: string, x: number, y: number, color: number): void {
    const accent = `#${color.toString(16).padStart(6, "0")}`;
    this.add.text(x, y, text, {
      fontSize: "24px",
      fontFamily: "Arial",
      fontStyle: "bold",
      color: "#ffffff",
      padding: { x: 10, y: 6 },
      align: "center"
    })
      .setOrigin(0.5)
      .setDepth(-40)
      .setStroke("#000000", 5)
      .setShadow(0, 2, accent, 4, true, true);
  }

  private isChatFocused(): boolean {
    return this.chatInputEl !== null && document.activeElement === this.chatInputEl;
  }

  shutdown(): void {
    this.speakingPeerIds.clear();
    this.micOffSpeakingPeerIds.clear();
    this.micOffToastEl?.remove();
    this.micOffToastEl = null;
    window.clearTimeout(this.micOffToastHideTimer);
    this.micOffToastHideTimer = 0;
    this.participantVolumeMenu?.dispose();
    this.participantVolumeMenu = undefined;
    this.voiceRouter?.dispose();
    this.screenShare?.destroy();
    for (const [, remote] of this.remotePlayers) {
      remote.destroy();
    }
    this.remotePlayers.clear();
    this.remotePlayerNames.clear();
    this.allOnlinePlayerNames.clear();
    this.playerRoomMap.clear();
    this.proximityPeerIds.clear();
    this.transport.disconnect();
  }

  private syncRoomMembersFromTrackedRooms(): void {
    this.remotePlayerNames.clear();

    if (this.roomId === "corridor") {
      return;
    }

    for (const [playerId, playerRoom] of this.playerRoomMap) {
      if (playerRoom !== this.roomId) {
        continue;
      }

      const playerName = this.allOnlinePlayerNames.get(playerId);
      if (playerName) {
        this.remotePlayerNames.set(playerId, playerName);
      }
    }
  }

  private publishMove(x: number, y: number, dx: number, dy: number): void {
    const now = Date.now();
    if (now - this.lastMoveSentAt < 100) return;
    this.lastMoveSentAt = now;

    const payload: PlayerMovePayload = {
      x,
      y,
      direction: this.resolveDirection(dx, dy),
      moving: dx !== 0 || dy !== 0
    };
    this.transport.sendMove(payload);
  }

  private resolveDirection(dx: number, dy: number): PlayerMovePayload["direction"] {
    if (dx === 0 && dy === 0) return "idle";
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
    return dy > 0 ? "down" : "up";
  }

  private pruneRosterToSnapshot(
    snapshotIds: Set<string>,
    screenHandlers: { onPlayerLeft(playerId: string): void }
  ): void {
    const selfId = this.transport.getSocketId();
    const staleIds = new Set<string>();
    for (const id of this.allOnlinePlayerNames.keys()) {
      if (!snapshotIds.has(id) && id !== selfId) staleIds.add(id);
    }
    for (const id of this.remotePlayers.keys()) {
      if (!snapshotIds.has(id) && id !== selfId) staleIds.add(id);
    }
    for (const id of staleIds) {
      this.allOnlinePlayerNames.delete(id);
      this.voiceRouter?.onRemotePlayerLeft(id);
      this.removeRemotePlayer(id);
      screenHandlers.onPlayerLeft(id);
    }
  }

  private upsertRemotePlayer(player: NetworkPlayer, isRoomMember: boolean = true): void {
    const h = PLAYER_HALF;
    const clampedX = Phaser.Math.Clamp(player.x, h, this.worldWidth - h);
    const clampedY = Phaser.Math.Clamp(player.y, h, this.worldHeight - h);
    const existing = this.remotePlayers.get(player.id);
    if (existing) {
      existing.setPosition(clampedX, clampedY);
      if (isRoomMember) {
        this.remotePlayerNames.set(player.id, player.name);
      }
      return;
    }

    // Only add to remotePlayerNames if they're a room member
    if (isRoomMember) {
      this.remotePlayerNames.set(player.id, player.name);
    }

    const remote = new PlayerEntity(this, clampedX, clampedY, player.name, 0xf97316, 0xea580c);
    this.remotePlayers.set(player.id, remote);
  }

  private removeRemotePlayer(playerId: string): void {
    const remote = this.remotePlayers.get(playerId);
    if (remote) {
      remote.destroy();
      this.remotePlayers.delete(playerId);
    }
    this.remotePlayerNames.delete(playerId);
    this.playerRoomMap.delete(playerId);
  }

  /** Runs before Socket connects so `env`/`net` work even when the server is misconfigured. */
  private bindDebugConsoleEarly(): void {
    const router = this.voiceRouter;
    if (!router) return;

    bindDebugConsole({
      form: document.getElementById("debug-form") as HTMLFormElement | null,
      input: document.getElementById("debug-input") as HTMLInputElement | null,
      log: document.getElementById("debug-log") as HTMLPreElement | null,
      getParticipantCount: () => this.remotePlayerNames.size + 1,
      getVoiceBackend: () => router.getVoiceBackend(),
      getVoiceStatusMessage: () => router.getVoiceStatusMessage(),
      getVoiceDiagnostics: () => router.getVoiceDebugReport(),
      getVoicePeersSnapshot: () => router.getVoicePeersSnapshot(),
      getMeshTraceLog: () => router.getMeshTraceLog(),
      getRoomId: () => this.roomId,
      getPlayerName: () => this.playerName,
      getPlayerPosition: () => this.player.getPosition(),
      isSocketConnected: () => this.transport.isConnected(),
      getSocketId: () => this.transport.getSocketId(),
      getRemotePlayersDebug: () => {
        const ids = [...this.remotePlayers.keys()];
        return `remote_count=${ids.length} ids=${ids.length ? ids.join(",") : "(none)"}`;
      },
      getScreenShareDebug: () => this.screenShare.getDebugSnapshot(),
      getVoiceMicMuted: () => router.getMicMuted(),
      getVoicePolicySummary: () => getVoiceBackendPolicySummary()
    });
  }

  private emitJoinRoom(): void {
    const pos = this.player.getPosition();
    this.transport.joinRoom({
      roomId: this.roomId,
      name: this.playerName,
      x: pos.x,
      y: pos.y
    });
  }

  private async connectSocketAndJoinRoom(): Promise<void> {
    const statusEl = document.getElementById("share-status") as HTMLParagraphElement | null;
    try {
      await this.transport.waitForConnected();
      this.emitJoinRoom();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (statusEl) statusEl.textContent = `接続に失敗しました: ${msg}`;
    }
  }

  private async bootVoiceAndDebug(): Promise<void> {
    try {
      await this.transport.waitForConnected();
    } catch {
      return;
    }

    const router = this.voiceRouter;
    if (!router) return;

    await Promise.race([
      this.initialRosterWait,
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, INITIAL_ROSTER_WAIT_MS);
      })
    ]);

    this.refreshProximityVoice();
    await router.autoJoinVoiceMuted();
  }

  private isVoiceLinkedRemote(playerId: string): boolean {
    if (this.roomId === "corridor") {
      return this.proximityPeerIds.has(playerId);
    }
    return this.playerRoomMap.get(playerId) === this.roomId;
  }

  /** @returns true if the corridor hearing set changed. */
  private refreshProximityVoice(): boolean {
    const next = new Set<string>();
    if (this.roomId === "corridor") {
      const self = this.player.getPosition();
      for (const [id, remote] of this.remotePlayers) {
        const pos = remote.getPosition();
        const theirRoom =
          this.playerRoomMap.get(id) ?? this.getRoomIdFromPositionRaw(pos.x, pos.y);
        if (theirRoom !== "corridor") continue;
        const dist = Math.hypot(pos.x - self.x, pos.y - self.y);
        const limit = this.proximityPeerIds.has(id)
          ? PROXIMITY_VOICE_DROP_PX
          : PROXIMITY_VOICE_CONNECT_PX;
        if (dist <= limit) next.add(id);
      }
    }

    let changed = next.size !== this.proximityPeerIds.size;
    if (!changed) {
      for (const id of next) {
        if (!this.proximityPeerIds.has(id)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return false;

    this.proximityPeerIds.clear();
    for (const id of next) this.proximityPeerIds.add(id);
    this.voiceRouter?.syncVoicePeersToRoom();
    return true;
  }

  private updateParticipantsPanel(): void {
    this.syncRoomMembersFromTrackedRooms();

    // Update global panel (all online players)
    const globalList = document.getElementById("global-list");
    if (globalList) {
      globalList.innerHTML = "";
      const selfId = this.transport.getSocketId() ?? "";
      globalList.appendChild(this.createParticipantItem(selfId, this.playerName, true, true));
      for (const [id, name] of this.allOnlinePlayerNames.entries()) {
        globalList.appendChild(
          this.createParticipantItem(id, name, false, this.isVoiceLinkedRemote(id))
        );
      }
      this.updateParticipantSpeakingStates();
    }

    // Room members panel is intentionally disabled by product decision.
    const roomPanel = document.getElementById("room-panel");
    if (roomPanel) {
      roomPanel.classList.add("hidden");
    }

    // Update top status count (room members)
    const countEl = document.getElementById("top-count");
    if (countEl) {
      const total = this.allOnlinePlayerNames.size + 1;
      countEl.textContent = `${total}人オンライン`;
    }

    // corridor では全オンラインプレイヤーを DM 候補にする
    const dmSource = this.roomId === "corridor" ? this.allOnlinePlayerNames : this.remotePlayerNames;
    const dmCandidates = Array.from(dmSource.entries()).map(([id, name]) => ({ id, name }));
    this.onPlayersChanged?.(dmCandidates);
    this.voiceRouter?.syncVoicePeersToRoom();
  }

  private updateParticipantSpeakingStates(): void {
    const globalList = document.getElementById("global-list");
    if (!globalList) return;
    for (const li of globalList.querySelectorAll<HTMLLIElement>(".participant-item")) {
      const id = li.dataset.playerId;
      if (!id) continue;
      li.classList.toggle("speaking", this.speakingPeerIds.has(id));
      li.classList.toggle("mic-off-speaking", this.micOffSpeakingPeerIds.has(id));
    }
  }

  private ensureMicOffToast(): void {
    if (this.micOffToastEl) return;
    const el = document.createElement("div");
    el.id = "voice-mic-off-toast";
    el.className = "voice-mic-off-toast hidden";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.textContent = "マイクがオフのままです。下のボタンでマイクをオンにしてください。";
    document.getElementById("game-layout")?.appendChild(el);
    this.micOffToastEl = el;
  }

  private updateMicOffToast(): void {
    const selfId = this.transport.getSocketId();
    const shouldShow = selfId !== undefined && this.micOffSpeakingPeerIds.has(selfId);
    const toast = this.micOffToastEl;
    if (!toast) return;

    if (shouldShow) {
      window.clearTimeout(this.micOffToastHideTimer);
      this.micOffToastHideTimer = 0;
      if (toast.classList.contains("hidden")) {
        this.micOffToastShownAt = Date.now();
      }
      toast.classList.remove("hidden");
      return;
    }

    if (toast.classList.contains("hidden")) return;

    const remaining = MIC_OFF_TOAST_MIN_MS - (Date.now() - this.micOffToastShownAt);
    if (remaining <= 0) {
      toast.classList.add("hidden");
      return;
    }

    if (this.micOffToastHideTimer !== 0) return;
    this.micOffToastHideTimer = window.setTimeout(() => {
      this.micOffToastHideTimer = 0;
      this.updateMicOffToast();
    }, remaining);
  }

  private createParticipantItem(
    playerId: string,
    name: string,
    isSelf: boolean,
    isSameRoom = false
  ): HTMLLIElement {
    const li = document.createElement("li");
    li.className = `participant-item${isSelf ? " self" : ""}${isSameRoom ? " same-room" : ""}`;
    li.dataset.playerId = playerId;

    const avatar = document.createElement("span");
    avatar.className = "participant-avatar";
    avatar.textContent = name.charAt(0).toUpperCase();
    if (isSameRoom && !isSelf) {
      avatar.setAttribute("aria-label", `${name}（同じルーム）`);
      avatar.classList.add("same-room-indicator");
    }

    const speakingDot = document.createElement("span");
    speakingDot.className = "participant-speaking-dot";
    speakingDot.setAttribute("aria-label", "発話中");
    speakingDot.title = "發話中";

    const nameEl = document.createElement("span");
    nameEl.className = "participant-name";
    nameEl.textContent = name;
    nameEl.title = name;
    if (isSelf) {
      li.setAttribute("aria-label", `${name}（自分）`);
    }

    li.append(avatar, speakingDot, nameEl);

    this.participantVolumeMenu?.bindParticipantItem(li, playerId, name, isSelf);

    return li;
  }
}
