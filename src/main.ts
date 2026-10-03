/// <reference types="vite/client" />
import "./game/network/applyApiBaseQuery";
import Phaser from "phaser";
import { MainScene } from "./game/scenes/MainScene";
import { SocketTransport } from "./game/network/SocketTransport";
import {
  applyApiBaseQueryParam,
  isMisconfiguredTryCloudflareSocketBase,
  resolveApiServerBaseUrl
} from "./game/network/serverOrigin";
import type { ChatMessage, DirectMessage, GameTransport } from "./game/network/types";

function bindDebugConsoleToggle(): void {
  const root = document.getElementById("debug-console");
  const toggle = document.getElementById("debug-toggle");
  const hint = document.getElementById("debug-toggle-hint");
  if (!root || !toggle) return;

  const sync = (): void => {
    const collapsed = root.classList.contains("is-collapsed");
    if (hint) hint.textContent = collapsed ? "開く" : "閉じる";
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };

  sync();
  toggle.addEventListener("click", () => {
    root.classList.toggle("is-collapsed");
    sync();
  });
}

bindDebugConsoleToggle();

// Log startup info with version and mode
console.log(
  `%c🎮 YmetaLife Client Loaded`,
  `color: #0ea5e9; font-weight: bold; font-size: 14px;`
);
console.log(`Mode: ${import.meta.env.MODE}`);
console.log(`URL: ${new URL(import.meta.env.BASE_URL, window.location.origin).href}`);

// Log startup info with version and mode
console.log(
  `%c🎮 YmetaLife Client Loaded`,
  `color: #0ea5e9; font-weight: bold; font-size: 14px;`
);
console.log(`Mode: ${import.meta.env.MODE}`);
console.log(`URL: ${new URL(import.meta.env.BASE_URL, window.location.origin).href}`);

const overlay = document.getElementById("name-overlay") as HTMLDivElement;
const form = document.getElementById("name-form") as HTMLFormElement;
const nameInput = document.getElementById("player-name") as HTMLInputElement;
const errorEl = document.getElementById("name-error") as HTMLParagraphElement;
const gameRoot = document.getElementById("game-root") as HTMLDivElement;
const gameLayout = document.getElementById("game-layout") as HTMLDivElement;
const topUserLabel = document.getElementById("top-user-label") as HTMLSpanElement;
const chatPanel = document.getElementById("chat-panel") as HTMLDivElement;
const chatMessages = document.getElementById("chat-messages") as HTMLDivElement;
const chatForm = document.getElementById("chat-form") as HTMLFormElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;
const chatToggleBtn = document.getElementById("chat-toggle-btn") as HTMLButtonElement;
const chatCloseBtn = document.getElementById("chat-close-btn") as HTMLButtonElement;

const LAST_NAME_KEY = "mekolife:last-name";
const savedName = localStorage.getItem(LAST_NAME_KEY);
if (savedName) nameInput.value = savedName;

let game: Phaser.Game | undefined;
let activeTransport: GameTransport | undefined;
let currentPlayerName = "";
let currentRoomId = "corridor";
const MAX_CHAT_MESSAGES = 50;
const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g;
const MENTION_REGEX = /@(\S+)/g;

/** name小文字 → socket id のマップ */
const playerNameToId = new Map<string, string>();
/** name小文字 → 元の語尾のマップ（サジェスト表示用） */
const playerOriginalName = new Map<string, string>();

function linkifyText(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const a = document.createElement("a");
    a.href = match[1];
    a.textContent = match[1];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    fragment.appendChild(a);
    lastIndex = URL_REGEX.lastIndex;
  }
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return fragment;
}

function appendChatMessage(msg: ChatMessage): void {
  const el = document.createElement("div");
  el.className = "chat-msg";

  const nameSpan = document.createElement("span");
  nameSpan.className = "chat-msg-name";
  const isSelf = activeTransport?.getSocketId() === msg.id;
  if (!isSelf) {
    nameSpan.classList.add("chat-msg-name--other");
  }
  nameSpan.textContent = msg.name;

  const textSpan = document.createElement("span");
  textSpan.className = "chat-msg-text";
  textSpan.appendChild(linkifyText(msg.text));

  el.appendChild(nameSpan);
  el.appendChild(textSpan);
  chatMessages.appendChild(el);

  while (chatMessages.children.length > MAX_CHAT_MESSAGES) {
    chatMessages.removeChild(chatMessages.firstChild!);
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !activeTransport) return;

  // @メンションを解析して DM 送信先を収集
  const mentionedIds = new Set<string>();
  MENTION_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_REGEX.exec(text)) !== null) {
    const id = playerNameToId.get(m[1].toLowerCase());
    if (id) mentionedIds.add(id);
  }

  if (mentionedIds.size > 0) {
    for (const toId of mentionedIds) {
      activeTransport.sendDirectMessage(toId, text);
    }
    // 送信者のチャット欄に1回だけ表示（サーバーエコーは削除済み）
    appendDmMessage({
      fromId: activeTransport.getSocketId() ?? "",
      fromName: currentPlayerName,
      fromRoomId: currentRoomId,
      toId: "",
      text,
    });
  } else {
    activeTransport.sendChat(text);
  }
  chatInput.value = "";
  hideMentionSuggestions();
});

// --- Chat toggle ---
chatToggleBtn.addEventListener("click", () => {
  chatPanel.classList.toggle("hidden");
});

chatCloseBtn.addEventListener("click", () => {
  chatPanel.classList.add("hidden");
});

// マップ(Phaserキャンバス)クリック時にチャット入力モードをキャンセル
gameRoot.addEventListener("pointerdown", () => {
  if (document.activeElement === chatInput) {
    chatInput.blur();
  }
});

// --- @メンションサジェスト ---
const mentionList = document.createElement("ul");
mentionList.className = "mention-list hidden";
chatForm.parentElement!.insertBefore(mentionList, chatForm);

let activeSuggestionIndex = -1;

function hideMentionSuggestions(): void {
  mentionList.classList.add("hidden");
  mentionList.innerHTML = "";
  activeSuggestionIndex = -1;
}

/** カーソル直前の @word を返す。なければ null 。 */
function getActiveMentionQuery(): { query: string; atIndex: number } | null {
  const val = chatInput.value;
  const pos = chatInput.selectionStart ?? val.length;
  const before = val.slice(0, pos);
  const match = /(?:^|\s)@(\S*)$/.exec(before);
  if (!match) return null;
  const atIndex = before.lastIndexOf("@");
  return { query: match[1].toLowerCase(), atIndex };
}

function renderMentionSuggestions(candidates: string[]): void {
  mentionList.innerHTML = "";
  activeSuggestionIndex = -1;
  if (candidates.length === 0) {
    hideMentionSuggestions();
    return;
  }
  for (const name of candidates) {
    const li = document.createElement("li");
    li.className = "mention-item";
    li.textContent = `@${name}`;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault(); // blurを防いで input フォーカスを維持
      applyMentionSuggestion(name);
    });
    mentionList.appendChild(li);
  }
  mentionList.classList.remove("hidden");
}

function applyMentionSuggestion(name: string): void {
  const result = getActiveMentionQuery();
  if (!result) return;
  const { atIndex } = result;
  const val = chatInput.value;
  const pos = chatInput.selectionStart ?? val.length;
  const after = val.slice(pos);
  const newVal = val.slice(0, atIndex) + `@${name} ` + after;
  chatInput.value = newVal;
  const newPos = atIndex + name.length + 2; // "@" + name + " "
  chatInput.setSelectionRange(newPos, newPos);
  hideMentionSuggestions();
  chatInput.focus();
}

chatInput.addEventListener("input", () => {
  const result = getActiveMentionQuery();
  if (!result) {
    hideMentionSuggestions();
    return;
  }
  const { query } = result;
  const candidates = Array.from(playerNameToId.keys())
    .filter((n) => n.startsWith(query))
    .map((n) => {
      // 元のケースで返すため登録時の名前を取得
      // playerNameToIdは小文字キーなので別途元名マップから引く
      return playerOriginalName.get(n) ?? n;
    });
  renderMentionSuggestions(candidates);
});

chatInput.addEventListener("keydown", (e) => {
  if (mentionList.classList.contains("hidden")) return;
  const items = mentionList.querySelectorAll<HTMLLIElement>(".mention-item");
  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, items.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
  } else if (e.key === "Enter" || e.key === "Tab") {
    if (activeSuggestionIndex >= 0 && items[activeSuggestionIndex]) {
      e.preventDefault();
      const name = items[activeSuggestionIndex].textContent?.slice(1) ?? "";
      applyMentionSuggestion(name);
    }
    return;
  } else if (e.key === "Escape") {
    hideMentionSuggestions();
    return;
  } else {
    return;
  }
  items.forEach((li, i) => li.classList.toggle("mention-item--active", i === activeSuggestionIndex));
});

chatInput.addEventListener("blur", () => {
  // mousedownの preventDefault で違うタイミングになるので少し遅らせる
  setTimeout(hideMentionSuggestions, 150);
});

// --- DM ---
function appendDmMessage(msg: DirectMessage): void {
  const el = document.createElement("div");
  el.className = "chat-msg";

  const nameSpan = document.createElement("span");
  nameSpan.className = "chat-msg-name";
  const isSelf = msg.toId === "";
  if (!isSelf) {
    nameSpan.classList.add("chat-msg-name--other");
  }
  nameSpan.textContent = `${msg.fromName}(DM)`;

  const textSpan = document.createElement("span");
  textSpan.className = "chat-msg-text";
  textSpan.appendChild(linkifyText(msg.text));

  el.appendChild(nameSpan);
  el.appendChild(textSpan);
  chatMessages.appendChild(el);

  while (chatMessages.children.length > MAX_CHAT_MESSAGES) {
    chatMessages.removeChild(chatMessages.firstChild!);
  }

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateDmPlayerList(players: { id: string; name: string }[]): void {
  playerNameToId.clear();
  playerOriginalName.clear();
  for (const p of players) {
    playerNameToId.set(p.name.toLowerCase(), p.id);
    playerOriginalName.set(p.name.toLowerCase(), p.name);
  }
}



form.addEventListener("submit", (event) => {
  event.preventDefault();

  const playerName = nameInput.value.trim();
  if (!playerName) {
    errorEl.textContent = "名前を入力してください。";
    return;
  }

  if (playerName.length > 12) {
    errorEl.textContent = "名前は12文字以内にしてください。";
    return;
  }

  localStorage.setItem(LAST_NAME_KEY, playerName);
  currentPlayerName = playerName;
  currentRoomId = "corridor";
  errorEl.textContent = "";
  overlay.classList.add("hidden");
  gameLayout.classList.remove("hidden");
  topUserLabel.textContent = `あなた: ${playerName}`;

  if (game) {
    game.destroy(true);
  }

  chatPanel.classList.remove("hidden");
  chatMessages.innerHTML = "";
  requestAnimationFrame(() => {
    game = createGame(playerName);
  });
});

function createGame(playerName: string): Phaser.Game {
  applyApiBaseQueryParam();
  const serverUrl = resolveApiServerBaseUrl();
  if (isMisconfiguredTryCloudflareSocketBase()) {
    alert(
      [
        "Cloudflare でフロント／Socket にトンネルを分けていますが、Socket 側の URL が未定義のためバックエンドに接続できません。次のいずれかを行ってください。",
        "",
        "1) 次の形式の URL を一度開く（? 以降をすべてアドレスバーに貼り付けて Enter）：",
        `${window.location.origin}${window.location.pathname}?api=https://（3000側トンネル）.trycloudflare.com`,
        "",
        "2) .env に VITE_SOCKET_URL を設定し、npm run dev を再起動する。"
      ].join("\n")
    );
  }

  const transport = new SocketTransport(serverUrl);
  activeTransport = transport;

  return new Phaser.Game({
    type: Phaser.AUTO,
    parent: gameRoot,
    width: 1280,
    height: 720,
    pixelArt: true,
    roundPixels: true,
    antialias: false,
    backgroundColor: "#000000",
    scene: [],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH
    },
    callbacks: {
      postBoot: (activeGame) => {
        activeGame.scene.add("main-scene", MainScene, true, {
          playerName,
          roomId: "corridor",  // Initial value; player spawns at world center which is in corridor
          transport,
          onChatMessage: appendChatMessage,
          onDirectMessage: appendDmMessage,
          onPlayersChanged: updateDmPlayerList,
          onRoomChanged: (roomId: string) => { currentRoomId = roomId; }
        });
      }
    }
  });
}
