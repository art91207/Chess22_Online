// public/client.js — with capture highlights, check indicator, resign/draw/new game, save/load setup,
// plus: SVG pieces, coordinates, move sound, right-click annotations

const socket = io({
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});

// ---------------- DOM ----------------
const roomCodeEl = document.getElementById("roomCode");
const hostColorEl = document.getElementById("hostColor");
const boardSizeEl = document.getElementById("boardSize");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const roleBadge = document.getElementById("roleBadge");

const statusEl = document.getElementById("status");
const phaseText = document.getElementById("phaseText");
const turnText = document.getElementById("turnText");
const checkText = document.getElementById("checkText");
const resultText = document.getElementById("resultText");

const offerDrawBtn = document.getElementById("offerDrawBtn");
const acceptDrawBtn = document.getElementById("acceptDrawBtn");
const declineDrawBtn = document.getElementById("declineDrawBtn");
const resignBtn = document.getElementById("resignBtn");
const newGameBtn = document.getElementById("newGameBtn");

const setupPanel = document.getElementById("setupPanel");
const clearBtn = document.getElementById("clearBtn");
const startBtn = document.getElementById("startBtn");
const eraserBtn = document.getElementById("eraserBtn");

const setupCodeEl = document.getElementById("setupCode");
const copySetupBtn = document.getElementById("copySetupBtn");
const loadSetupBtn = document.getElementById("loadSetupBtn");

const boardCanvas = document.getElementById("boardCanvas");
const ctx = boardCanvas.getContext("2d");

const promoModal = document.getElementById("promoModal");
const promoCancel = document.getElementById("promoCancel");
const promoBtns = Array.from(document.querySelectorAll(".promoBtn"));
const pieceBtns = Array.from(document.querySelectorAll(".pieceBtn"));

// prevent browser context menu on right-click
boardCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------------- Local storage ----------------
const LS_TOKEN = "chess_token";
const LS_ROOM = "chess_room";

let myRoom = localStorage.getItem(LS_ROOM) || "";
let myToken = localStorage.getItem(LS_TOKEN) || "";
let mySide = "spectator"; // white | black | spectator
let isHost = false;

// ---------------- Connection UX + keepalive ----------------
let keepAliveTimer = null;
let reconnectAttempt = 0;
let connectionState = "connecting"; // connected | reconnecting | disconnected

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    fetch(`/healthz?ts=${Date.now()}`, { cache: "no-store" }).catch(() => {});
  }, 5 * 60 * 1000);
}
function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

function setStatus(msg) {
  statusEl.textContent = msg || "";
}

statusEl.style.cursor = "pointer";
statusEl.title = "Click to reload if reconnect is stuck";
statusEl.addEventListener("click", () => {
  if (connectionState !== "connected") window.location.reload();
});

// ---------------- Game state ----------------
let state = null;               // latest roomState
let prevPhase = null;
let prevTurn = null;

let boardMap = new Map();       // "x,y" -> {color,type}
let selected = null;            // {x,y} world

// legal targets map: key -> {capture:boolean}
let legalTargets = new Map();

let tool = { mode: "piece", piece: { color: "w", type: "p" } };

function keyXY(x, y) { return `${x},${y}`; }

function rebuildBoardMap(pieces) {
  boardMap.clear();
  for (const p of pieces || []) boardMap.set(keyXY(p.x, p.y), { color: p.color, type: p.type });
}

function myColor() {
  if (mySide === "white") return "w";
  if (mySide === "black") return "b";
  return null;
}

function isMyTurn() {
  if (!state || state.phase !== "play") return false;
  const c = myColor();
  return !!c && state.turn === c;
}

function isPlayer() {
  return mySide === "white" || mySide === "black";
}

function canHostSetup() {
  return isHost && state && state.phase === "setup";
}

// ---------------- Board orientation ----------------
function worldToView(x, y) {
  const N = state?.boardSize ?? 22;
  if (mySide === "black") return { vx: (N - 1) - x, vy: (N - 1) - y };
  return { vx: x, vy: y };
}
function viewToWorld(vx, vy) {
  const N = state?.boardSize ?? 22;
  if (mySide === "black") return { x: (N - 1) - vx, y: (N - 1) - vy };
  return { x: vx, y: vy };
}

// ---------------- Colors ----------------
const COL = {
  light: "#F0D9B5",
  dark: "#B58863",
  border: "#6B4F35",

  selected: "rgba(79,124,255,0.32)",
  legal: "rgba(79,124,255,0.20)",
  dot: "rgba(0,0,0,0.22)",

  capture: "rgba(220,60,60,0.22)",
  captureDot: "rgba(180,30,30,0.35)",

  check: "rgba(220,60,60,0.28)",
};

// ---------------- Canvas sizing (bigger, fills screen but not off-screen) ----------------
function fitCanvas() {
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  // Leave a little room for the top controls + bottom text
  const maxByWidth = viewportW - 20;
  const maxByHeight = viewportH - 20;

  // Make the board as large as possible without going off-screen
  const size = Math.max(520, Math.min(maxByWidth, maxByHeight));

  boardCanvas.width = size;
  boardCanvas.height = size;

  // keep CSS size matched to drawing size
  boardCanvas.style.width = `${size}px`;
  boardCanvas.style.height = `${size}px`;
}

window.addEventListener("resize", () => { fitCanvas(); draw(); });

// ---------------- Coordinates ----------------
function fileLabel(i) {
  return String.fromCharCode(65 + i); // 0->A
}

function drawCoordinates(ox, oy, t, N) {
  const pad = Math.max(3, Math.floor(t * 0.10));
  const font = Math.max(10, Math.floor(t * 0.22));
  const coordOnDark = "rgba(240,217,181,0.90)";
  const coordOnLight = "rgba(181,136,99,0.90)";

  ctx.save();
  ctx.font = `800 ${font}px system-ui, Arial`;
  ctx.textAlign = "left";

  for (let vy = 0; vy < N; vy++) {
    const w = viewToWorld(0, vy);
    const rank = String(N - w.y);
    const isDark = ((0 + vy) % 2 === 1);
    ctx.fillStyle = isDark ? coordOnDark : coordOnLight;
    ctx.textBaseline = "top";
    ctx.fillText(rank, ox + pad, oy + vy * t + pad);
  }

  for (let vx = 0; vx < N; vx++) {
    const w = viewToWorld(vx, N - 1);
    const file = fileLabel(w.x);
    const isDark = ((vx + (N - 1)) % 2 === 1);
    ctx.fillStyle = isDark ? coordOnDark : coordOnLight;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(file, ox + vx * t + pad, oy + (N - 1) * t + t - pad);
  }

  ctx.restore();
}

// ---------------- SVG pieces (cburnett) ----------------
const PIECE_SET = "cburnett";
const PIECE_BASE = `pieces/${PIECE_SET}/`;

const typeToLetter = { k: "K", q: "Q", r: "R", b: "B", n: "N", p: "P" };
const pieceImgs = new Map();

function loadPieceImages() {
  const files = [];
  for (const c of ["w", "b"]) for (const L of ["K","Q","R","B","N","P"]) files.push(`${c}${L}.svg`);
  for (const f of files) {
    const img = new Image();
    img.src = PIECE_BASE + f;
    pieceImgs.set(f, img);
  }
}
loadPieceImages();

function drawPieceImage(p, cx, cy, t) {
  const L = typeToLetter[p.type];
  if (!L) return false;
  const file = `${p.color}${L}.svg`;
  const img = pieceImgs.get(file);
  if (!img || !img.complete) return false;

  const pad = Math.floor(t * 0.08);
  const s = t - pad * 2;

  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.filter = "blur(1px)";
  ctx.drawImage(img, cx - s / 2 + 1, cy - s / 2 + 2, s, s);
  ctx.restore();

  ctx.drawImage(img, cx - s / 2, cy - s / 2, s, s);
  return true;
}

// ---------------- Move click sound ----------------
let audioCtx = null;
let audioUnlocked = false;

function ensureAudioUnlocked() {
  if (audioUnlocked) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    audioUnlocked = true;
  } catch {
    audioUnlocked = false;
  }
}
document.addEventListener("pointerdown", () => ensureAudioUnlocked(), { once: true });

function playMoveClick() {
  if (!audioUnlocked || !audioCtx) return;

  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "square";
  osc.frequency.setValueAtTime(900, t0);

  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start(t0);
  osc.stop(t0 + 0.05);
}

// ---------------- Annotations (right-click circles + arrows) ----------------
const annoCircles = new Set(); // "x,y" in WORLD
const annoArrows = [];         // {from,to} in WORLD
let dragAnno = null;

function clearAnnotations() {
  annoCircles.clear();
  annoArrows.length = 0;
  dragAnno = null;
}

function toggleCircleAt(worldSq) {
  const k = keyXY(worldSq.x, worldSq.y);
  if (annoCircles.has(k)) annoCircles.delete(k);
  else annoCircles.add(k);
}

function sameArrow(a, b) {
  return a.from.x === b.from.x && a.from.y === b.from.y && a.to.x === b.to.x && a.to.y === b.to.y;
}

function toggleArrow(from, to) {
  const arrow = { from: { ...from }, to: { ...to } };
  const idx = annoArrows.findIndex((a) => sameArrow(a, arrow));
  if (idx >= 0) annoArrows.splice(idx, 1);
  else annoArrows.push(arrow);
}

function drawArrow(fromW, toW, t, ox, oy, alpha = 0.45) {
  const fromV = worldToView(fromW.x, fromW.y);
  const toV = worldToView(toW.x, toW.y);

  const sx = ox + fromV.vx * t + t / 2;
  const sy = oy + fromV.vy * t + t / 2;
  const ex = ox + toV.vx * t + t / 2;
  const ey = oy + toV.vy * t + t / 2;

  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy);
  if (len < 1) return;

  const ux = dx / len;
  const uy = dy / len;

  const shrink = t * 0.18;
  const ssx = sx + ux * shrink;
  const ssy = sy + uy * shrink;
  const eex = ex - ux * shrink;
  const eey = ey - uy * shrink;

  const lineW = Math.max(3, t * 0.18);
  const headL = Math.max(8, t * 0.42);
  const headW = Math.max(8, t * 0.30);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.strokeStyle = "rgba(0,120,0,1)";
  ctx.lineWidth = lineW;

  ctx.beginPath();
  ctx.moveTo(ssx, ssy);
  ctx.lineTo(eex, eey);
  ctx.stroke();

  const hx = eex, hy = eey;
  const px = -uy, py = ux;

  ctx.fillStyle = "rgba(0,120,0,1)";
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(hx - ux * headL + px * headW * 0.5, hy - uy * headL + py * headW * 0.5);
  ctx.lineTo(hx - ux * headL - px * headW * 0.5, hy - uy * headL - py * headW * 0.5);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function drawCircle(worldSq, t, ox, oy) {
  const v = worldToView(worldSq.x, worldSq.y);
  const cx = ox + v.vx * t + t / 2;
  const cy = oy + v.vy * t + t / 2;
  const r = t * 0.40;
  const lw = Math.max(3, t * 0.09);

  ctx.save();
  ctx.strokeStyle = "rgba(0,120,0,0.65)";
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// ---------------- Setup code (save/load) ----------------
function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(str) {
  let s = String(str || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return decodeURIComponent(escape(atob(s)));
}

function encodeSetupCode(st) {
  const obj = {
    n: st.boardSize,
    p: (st.boardPieces || []).map((q) => [q.x, q.y, q.color, q.type]),
  };
  return b64urlEncode(JSON.stringify(obj));
}

function decodeSetupCode(code) {
  const json = b64urlDecode(code);
  const obj = JSON.parse(json);

  const n = Number(obj?.n);
  const p = Array.isArray(obj?.p) ? obj.p : [];

  const pieces = p.map((it) => ({
    x: Number(it[0]),
    y: Number(it[1]),
    color: it[2] === "b" ? "b" : "w",
    type: String(it[3] || "").toLowerCase(),
  }));

  return { boardSize: n, pieces };
}

// ---------------- Draw ----------------
function drawCheckHighlight(ox, oy, t, N) {
  if (!state || state.phase !== "play") return;
  if (!state.check || !state.kingPos) return;

  const drawOne = (c) => {
    if (!state.check[c]) return;
    const kp = state.kingPos[c];
    if (!kp) return;

    const v = worldToView(kp.x, kp.y);
    ctx.save();
    ctx.fillStyle = COL.check;
    ctx.fillRect(ox + v.vx * t, oy + v.vy * t, t, t);
    ctx.restore();
  };

  drawOne("w");
  drawOne("b");
}

function draw() {
  if (!state) return;

  const N = state.boardSize;
  const size = Math.min(boardCanvas.width, boardCanvas.height);
  const t = Math.floor(size / N);
  const ox = Math.floor((boardCanvas.width - t * N) / 2);
  const oy = Math.floor((boardCanvas.height - t * N) / 2);

  ctx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);

  // border
  ctx.save();
  ctx.strokeStyle = COL.border;
  ctx.lineWidth = Math.max(2, Math.floor(t * 0.12));
  ctx.strokeRect(ox - 1, oy - 1, t * N + 2, t * N + 2);
  ctx.restore();

  // squares
  for (let vy = 0; vy < N; vy++) {
    for (let vx = 0; vx < N; vx++) {
      const x = ox + vx * t;
      const y = oy + vy * t;
      const isDark = (vx + vy) % 2 === 1;
      ctx.fillStyle = isDark ? COL.dark : COL.light;
      ctx.fillRect(x, y, t, t);
    }
  }

  // selected highlight
  if (selected) {
    const v = worldToView(selected.x, selected.y);
    ctx.fillStyle = COL.selected;
    ctx.fillRect(ox + v.vx * t, oy + v.vy * t, t, t);
  }

  // legal targets (blue) + capture targets (red)
  for (const [k, info] of legalTargets.entries()) {
    const [x, y] = k.split(",").map(Number);
    const v = worldToView(x, y);
    const px = ox + v.vx * t;
    const py = oy + v.vy * t;

    ctx.fillStyle = info.capture ? COL.capture : COL.legal;
    ctx.fillRect(px, py, t, t);

    ctx.beginPath();
    ctx.fillStyle = info.capture ? COL.captureDot : COL.dot;
    ctx.arc(px + t / 2, py + t / 2, Math.max(3, t * 0.12), 0, Math.PI * 2);
    ctx.fill();
  }

  // check highlight behind king
  drawCheckHighlight(ox, oy, t, N);

  // coordinates
  drawCoordinates(ox, oy, t, N);

  // arrows under pieces
  for (const a of annoArrows) drawArrow(a.from, a.to, t, ox, oy, 0.35);
  if (dragAnno && dragAnno.cur && dragAnno.moved) drawArrow(dragAnno.start, dragAnno.cur, t, ox, oy, 0.25);

  // pieces
  ctx.imageSmoothingEnabled = true;
  for (const [kxy, p] of boardMap.entries()) {
    const [x, y] = kxy.split(",").map(Number);
    const v = worldToView(x, y);
    const cx = ox + v.vx * t + t / 2;
    const cy = oy + v.vy * t + t / 2;

    const drew = drawPieceImage(p, cx, cy, t);
    if (!drew) {
      ctx.beginPath();
      ctx.fillStyle = p.color === "w" ? "#fff" : "#000";
      ctx.arc(cx, cy, Math.max(4, t * 0.18), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // circles on top
  for (const kk of annoCircles) {
    const [x, y] = kk.split(",").map(Number);
    drawCircle({ x, y }, t, ox, oy);
  }
}

// ---------------- UI update ----------------
function updateActionsUI() {
  const play = state?.phase === "play";
  const me = myColor();

  // default hide accept/decline
  acceptDrawBtn.style.display = "none";
  declineDrawBtn.style.display = "none";

  // offer draw
  offerDrawBtn.disabled = !(play && isPlayer());
  offerDrawBtn.style.display = play ? "inline-block" : "none";

  // resign
  resignBtn.disabled = !(play && isPlayer());
  resignBtn.style.display = play ? "inline-block" : "none";

  // new game host-only
  newGameBtn.disabled = !isHost;
  newGameBtn.style.display = "inline-block";

  // draw offer logic
  const offerFrom = state?.drawOfferFrom || null;
  if (play && offerFrom) {
    if (me && offerFrom !== me) {
      // opponent offered -> show accept/decline
      acceptDrawBtn.style.display = "inline-block";
      declineDrawBtn.style.display = "inline-block";
      acceptDrawBtn.disabled = false;
      declineDrawBtn.disabled = false;
      declineDrawBtn.textContent = "Decline";
      setStatus(`Draw offered by ${offerFrom === "w" ? "White" : "Black"}.`);
    } else if (me && offerFrom === me) {
      // you offered -> show cancel
      declineDrawBtn.style.display = "inline-block";
      declineDrawBtn.disabled = false;
      declineDrawBtn.textContent = "Cancel Draw";
      setStatus("Draw offer sent (waiting).");
    }
    // disable offer button while pending
    offerDrawBtn.disabled = true;
  }
}

function updateUI() {
  if (!state) return;

  phaseText.textContent = `Phase: ${state.phase}`;
  turnText.textContent = state.phase === "play" ? `Turn: ${state.turn === "w" ? "White" : "Black"}` : "Turn: —";
  resultText.textContent = state.phase === "gameover" ? `Result: ${state.result} (${state.reason})` : "";

  // check indicator text
  if (state.phase === "play" && state.check) {
    if (state.check.w) checkText.textContent = "— White in check";
    else if (state.check.b) checkText.textContent = "— Black in check";
    else checkText.textContent = "";
  } else {
    checkText.textContent = "";
  }

  setupPanel.style.display = canHostSetup() ? "flex" : "none";

  const role =
    mySide === "white" ? "You are WHITE" :
    mySide === "black" ? "You are BLACK" :
    "Spectating";
  roleBadge.textContent = isHost ? `${role} (HOST)` : role;

  if (boardSizeEl && state.boardSize) boardSizeEl.value = String(state.boardSize);
  if (boardSizeEl) boardSizeEl.disabled = !(isHost && state.phase === "setup");

  // setup code controls
  const setupVisible = state.phase === "setup";
  if (setupCodeEl) setupCodeEl.disabled = !setupVisible;
  if (copySetupBtn) copySetupBtn.disabled = !setupVisible;
  if (loadSetupBtn) loadSetupBtn.disabled = !(setupVisible && isHost);

  updateActionsUI();
  draw();
}

// ---------------- Promotion modal ----------------
function openPromoModal(onPick) {
  promoModal.classList.remove("hidden");

  const handler = (e) => {
    const t = e.currentTarget.getAttribute("data-p"); // q r b n
    cleanup();
    onPick(t);
  };

  const cleanup = () => {
    promoModal.classList.add("hidden");
    promoBtns.forEach((b) => b.removeEventListener("click", handler));
  };

  promoBtns.forEach((b) => b.addEventListener("click", handler));
  promoCancel.onclick = () => {
    cleanup();
    setStatus("Promotion cancelled.");
  };
}

// ---------------- Pointer -> square ----------------
function squareFromPointer(evt) {
  if (!state) return null;

  const rect = boardCanvas.getBoundingClientRect();
  const scaleX = boardCanvas.width / rect.width;
  const scaleY = boardCanvas.height / rect.height;

  const mx = (evt.clientX - rect.left) * scaleX;
  const my = (evt.clientY - rect.top) * scaleY;

  const N = state.boardSize;
  const size = Math.min(boardCanvas.width, boardCanvas.height);
  const t = Math.floor(size / N);
  const ox = Math.floor((boardCanvas.width - t * N) / 2);
  const oy = Math.floor((boardCanvas.height - t * N) / 2);

  const vx = Math.floor((mx - ox) / t);
  const vy = Math.floor((my - oy) / t);
  if (vx < 0 || vx >= N || vy < 0 || vy >= N) return null;
  return { vx, vy };
}

// ---------------- Right-click annotations ----------------
boardCanvas.addEventListener("pointerdown", (evt) => {
  if (evt.button !== 2) return;
  if (!state) return;

  evt.preventDefault();

  const sq = squareFromPointer(evt);
  if (!sq) return;
  const w = viewToWorld(sq.vx, sq.vy);

  dragAnno = {
    start: { x: w.x, y: w.y },
    cur: null,
    moved: false,
    sx: evt.clientX,
    sy: evt.clientY,
  };
  boardCanvas.setPointerCapture(evt.pointerId);
});

boardCanvas.addEventListener("pointermove", (evt) => {
  if (!dragAnno || !state) return;

  const dist = Math.hypot(evt.clientX - dragAnno.sx, evt.clientY - dragAnno.sy);
  if (dist > 6) dragAnno.moved = true;

  const sq = squareFromPointer(evt);
  if (!sq) { dragAnno.cur = null; draw(); return; }

  const w = viewToWorld(sq.vx, sq.vy);
  dragAnno.cur = { x: w.x, y: w.y };
  draw();
});

function finishRightDrag() {
  if (!dragAnno) return;

  const start = dragAnno.start;
  const end = dragAnno.cur;

  if (end && dragAnno.moved && (end.x !== start.x || end.y !== start.y)) {
    toggleArrow(start, end);
  } else {
    toggleCircleAt(start);
  }

  dragAnno = null;
  draw();
}

boardCanvas.addEventListener("pointerup", (evt) => {
  if (!dragAnno) return;
  evt.preventDefault();
  finishRightDrag();
});
boardCanvas.addEventListener("pointercancel", () => {
  dragAnno = null;
  draw();
});

// ---------------- Left click: clears annotations + normal game click ----------------
boardCanvas.addEventListener("click", (evt) => {
  clearAnnotations(); // requested: left click clears all circles+arrows

  if (!state) return;
  const sq = squareFromPointer(evt);
  if (!sq) return;

  const w = viewToWorld(sq.vx, sq.vy);

  // setup placement
  if (state.phase === "setup") {
    if (!canHostSetup()) return;

    if (tool.mode === "erase") socket.emit("setupPlace", { x: w.x, y: w.y, piece: null });
    else socket.emit("setupPlace", { x: w.x, y: w.y, piece: tool.piece });
    return;
  }

  // play click-to-move
  if (state.phase !== "play") return;
  if (!isMyTurn()) return;

  const c = myColor();
  if (!c) return;

  const clickedPiece = boardMap.get(keyXY(w.x, w.y)) || null;

  if (!selected) {
    if (!clickedPiece || clickedPiece.color !== c) return;
    selected = { x: w.x, y: w.y };
    legalTargets.clear();
    socket.emit("requestMoves", { x: w.x, y: w.y });
    draw();
    return;
  }

  if (selected.x === w.x && selected.y === w.y) {
    selected = null;
    legalTargets.clear();
    draw();
    return;
  }

  if (clickedPiece && clickedPiece.color === c) {
    selected = { x: w.x, y: w.y };
    legalTargets.clear();
    socket.emit("requestMoves", { x: w.x, y: w.y });
    draw();
    return;
  }

  const destKey = keyXY(w.x, w.y);
  if (!legalTargets.has(destKey)) return;

  const from = { ...selected };
  const to = { x: w.x, y: w.y };

  const movingPiece = boardMap.get(keyXY(from.x, from.y));
  const lastRank = movingPiece?.color === "w" ? 0 : ((state.boardSize ?? 22) - 1);
  const needsPromo = movingPiece?.type === "p" && to.y === lastRank;

  if (needsPromo) {
    openPromoModal((choice) => {
      socket.emit("move", { from, to, promoType: choice });
      selected = null;
      legalTargets.clear();
      draw();
    });
    return;
  }

  socket.emit("move", { from, to });
  selected = null;
  legalTargets.clear();
  draw();
});

// ---------------- Setup palette ----------------
pieceBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const code = btn.getAttribute("data-piece");
    const color = code[0] === "b" ? "b" : "w";
    const type = code[1].toLowerCase();
    tool = { mode: "piece", piece: { color, type } };

    pieceBtns.forEach((b) => b.classList.remove("active"));
    eraserBtn.classList.remove("active");
    btn.classList.add("active");
  });
});

eraserBtn.addEventListener("click", () => {
  tool = { mode: "erase" };
  pieceBtns.forEach((b) => b.classList.remove("active"));
  eraserBtn.classList.add("active");
});

clearBtn.addEventListener("click", () => {
  if (!canHostSetup()) return;
  socket.emit("setupClear");
});

startBtn.addEventListener("click", () => {
  if (!canHostSetup()) return;
  socket.emit("startGame");
});

// board size change in setup
boardSizeEl.addEventListener("change", () => {
  if (!isHost) return;
  if (!state || state.phase !== "setup") return;
  const N = Number(boardSizeEl.value) || 22;
  socket.emit("setBoardSize", { boardSize: N });
});

// save/load setup code
copySetupBtn.addEventListener("click", async () => {
  if (!state || state.phase !== "setup") return;
  const code = encodeSetupCode(state);
  setupCodeEl.value = code;
  try { await navigator.clipboard.writeText(code); setStatus("Setup code copied."); }
  catch { setStatus("Setup code ready (copy manually)."); }
});

loadSetupBtn.addEventListener("click", () => {
  if (!state || state.phase !== "setup") return;
  if (!isHost) return setStatus("Only host can load setup.");
  const code = (setupCodeEl.value || "").trim();
  if (!code) return setStatus("Paste a setup code first.");

  try {
    const decoded = decodeSetupCode(code);
    socket.emit("loadSetup", decoded);
    setStatus("Loading setup…");
  } catch (e) {
    setStatus("Invalid setup code.");
  }
});

// ---------------- Game action buttons ----------------
offerDrawBtn.onclick = () => {
  if (!state || state.phase !== "play" || !isPlayer()) return;
  socket.emit("offerDraw");
};
acceptDrawBtn.onclick = () => {
  if (!state || state.phase !== "play" || !isPlayer()) return;
  socket.emit("acceptDraw");
};
declineDrawBtn.onclick = () => {
  if (!state || state.phase !== "play" || !isPlayer()) return;
  socket.emit("declineDraw");
};
resignBtn.onclick = () => {
  if (!state || state.phase !== "play" || !isPlayer()) return;
  if (!confirm("Resign this game?")) return;
  socket.emit("resign");
};
newGameBtn.onclick = () => {
  if (!isHost) return setStatus("Only host can start a new game.");
  socket.emit("newGame");
};

// ---------------- Socket events ----------------
socket.on("joinError", ({ message }) => setStatus(message || "Join failed."));
socket.on("actionError", ({ message }) => setStatus(message || "Action failed."));

socket.on("joinedRoom", ({ roomCode, side, isHost: hostFlag, sessionToken }) => {
  myRoom = roomCode;
  localStorage.setItem(LS_ROOM, roomCode);
  roomCodeEl.value = roomCode;

  mySide = side || "spectator";
  isHost = !!hostFlag;

  if (sessionToken) {
    myToken = sessionToken;
    localStorage.setItem(LS_TOKEN, sessionToken);
  }

  setStatus(`Joined room ${roomCode}.`);
});

socket.on("roomState", (st) => {
  const moveHappened =
    prevPhase === "play" &&
    prevTurn &&
    st.phase === "play" &&
    st.turn &&
    prevTurn !== st.turn;

  state = st;

  selected = null;
  legalTargets.clear();

  rebuildBoardMap(st.boardPieces);
  updateUI();

  if (moveHappened) playMoveClick();

  prevPhase = st.phase;
  prevTurn = st.turn;
});

socket.on("legalMoves", ({ from, moves }) => {
  if (!selected || selected.x !== from.x || selected.y !== from.y) return;

  legalTargets.clear();
  for (const m of moves || []) {
    legalTargets.set(keyXY(m.x, m.y), { capture: !!m.capture });
  }
  draw();
});

// reconnect + keepalive
socket.on("connect", () => {
  connectionState = "connected";
  reconnectAttempt = 0;
  startKeepAlive();
  if (myRoom && myToken) socket.emit("rejoinRoom", { roomCode: myRoom, sessionToken: myToken });
});

socket.on("disconnect", () => {
  connectionState = "reconnecting";
  stopKeepAlive();
  setStatus(`⚠️ Connection lost. Reconnecting… (attempt ${reconnectAttempt || 1}) — click status to reload`);
});

socket.io.on("reconnect_attempt", (attempt) => {
  reconnectAttempt = attempt;
  connectionState = "reconnecting";
  setStatus(`⚠️ Reconnecting… (attempt ${reconnectAttempt}) — click status to reload`);
});

socket.io.on("reconnect", () => {
  connectionState = "connected";
  reconnectAttempt = 0;
  startKeepAlive();
  setStatus("Reconnected. Restoring room…");
  if (myRoom && myToken) socket.emit("rejoinRoom", { roomCode: myRoom, sessionToken: myToken });
});

socket.io.on("reconnect_failed", () => {
  connectionState = "disconnected";
  stopKeepAlive();
  setStatus("❌ Disconnected. Click status to reload.");
});

// ---------------- Buttons ----------------
createBtn.onclick = () => {
  const hostColor = hostColorEl?.value === "black" ? "black" : "white";
  const boardSize = Number(boardSizeEl?.value) || 22;
  socket.emit("createRoom", { sessionToken: myToken || undefined, hostColor, boardSize });
};

joinBtn.onclick = () => {
  const code = (roomCodeEl.value || "").trim().toUpperCase();
  if (!code) return setStatus("Enter a room code.");
  socket.emit("joinRoom", { roomCode: code, sessionToken: myToken || undefined });
};

// ---------------- Init ----------------
fitCanvas();
roomCodeEl.value = myRoom;

// default active tool: white pawn
const defaultBtn = document.querySelector('.pieceBtn[data-piece="wP"]');
if (defaultBtn) defaultBtn.click();
else setStatus("Create a room to start.");