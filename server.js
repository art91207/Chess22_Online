// server.js — Chess Online (8/15/22), host chooses side + board size, host-only setup,
// standard rules (no castling), promotion yes, en passant yes,
// capture highlights, check indicator, resign/draw/new game, load setup code, last move highlight

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 25000, pingTimeout: 20000 });

// no-cache so browsers don't use stale client files
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

app.get("/healthz", (req, res) => res.status(200).send("ok"));

const DISCONNECT_GRACE_MS = 2 * 60 * 1000;
const ALLOWED_SIZES = new Set([8, 15, 22]);

// ----------------- helpers -----------------
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function makeSessionToken() {
  return crypto.randomBytes(16).toString("hex");
}

function inBounds(x, y, N) {
  return x >= 0 && x < N && y >= 0 && y < N;
}

function emptyBoard(N) {
  return Array.from({ length: N }, () => Array.from({ length: N }, () => null));
}

function cloneBoard(board) {
  return board.map((row) => row.map((p) => (p ? { ...p } : null)));
}

function otherColor(c) {
  return c === "w" ? "b" : "w";
}

function pieceAt(board, x, y) {
  return board[y][x];
}

function setAt(board, x, y, piece) {
  board[y][x] = piece ? { ...piece } : null;
}

function keySquare(sq) {
  return sq ? `${sq.x},${sq.y}` : "-";
}

// ----------------- chess rules -----------------
function findKing(board, color, N) {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = board[y][x];
      if (p && p.color === color && p.type === "k") return { x, y };
    }
  }
  return null;
}

function isSquareAttacked(board, x, y, byColor, N) {
  // pawn attacks
  const pawnDir = byColor === "w" ? -1 : 1;
  for (const dx of [-1, 1]) {
    const px = x + dx;
    const py = y - pawnDir;
    if (inBounds(px, py, N)) {
      const p = board[py][px];
      if (p && p.color === byColor && p.type === "p") return true;
    }
  }

  // knight attacks
  const KN = [
    [1, 2], [2, 1], [2, -1], [1, -2],
    [-1, -2], [-2, -1], [-2, 1], [-1, 2],
  ];

  for (const [dx, dy] of KN) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(nx, ny, N)) continue;

    const p = board[ny][nx];
    if (p && p.color === byColor && p.type === "n") return true;
  }

  // king attacks
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;

      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny, N)) continue;

      const p = board[ny][nx];
      if (p && p.color === byColor && p.type === "k") return true;
    }
  }

  // diagonal attacks: bishop / queen
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  for (const [dx, dy] of DIAG) {
    let nx = x + dx;
    let ny = y + dy;

    while (inBounds(nx, ny, N)) {
      const p = board[ny][nx];

      if (p) {
        if (p.color === byColor && (p.type === "b" || p.type === "q")) return true;
        break;
      }

      nx += dx;
      ny += dy;
    }
  }

  // straight attacks: rook / queen
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (const [dx, dy] of ORTH) {
    let nx = x + dx;
    let ny = y + dy;

    while (inBounds(nx, ny, N)) {
      const p = board[ny][nx];

      if (p) {
        if (p.color === byColor && (p.type === "r" || p.type === "q")) return true;
        break;
      }

      nx += dx;
      ny += dy;
    }
  }

  return false;
}

function kingInCheck(board, color, N) {
  const kpos = findKing(board, color, N);
  if (!kpos) return true;
  return isSquareAttacked(board, kpos.x, kpos.y, otherColor(color), N);
}

function pseudoMoves(state, fromX, fromY) {
  const { board, enPassant, N } = state;
  const p = pieceAt(board, fromX, fromY);
  if (!p) return [];

  const moves = [];

  const add = (x, y, meta = {}) => {
    if (!inBounds(x, y, N)) return;

    const t = pieceAt(board, x, y);
    if (t && t.color === p.color) return;

    moves.push({ fromX, fromY, toX: x, toY: y, ...meta });
  };

  if (p.type === "n") {
    const KN = [
      [1, 2], [2, 1], [2, -1], [1, -2],
      [-1, -2], [-2, -1], [-2, 1], [-1, 2],
    ];

    for (const [dx, dy] of KN) add(fromX + dx, fromY + dy);
    return moves;
  }

  if (p.type === "k") {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        add(fromX + dx, fromY + dy);
      }
    }

    // no castling
    return moves;
  }

  if (p.type === "b" || p.type === "r" || p.type === "q") {
    const dirs = [];

    if (p.type === "b" || p.type === "q") {
      dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
    }

    if (p.type === "r" || p.type === "q") {
      dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
    }

    for (const [dx, dy] of dirs) {
      let x = fromX + dx;
      let y = fromY + dy;

      while (inBounds(x, y, N)) {
        const t = pieceAt(board, x, y);

        if (!t) {
          add(x, y);
        } else {
          if (t.color !== p.color) add(x, y);
          break;
        }

        x += dx;
        y += dy;
      }
    }

    return moves;
  }

  if (p.type === "p") {
    const dir = p.color === "w" ? -1 : 1;
    const startRank = p.color === "w" ? N - 2 : 1;
    const lastRank = p.color === "w" ? 0 : N - 1;

    // forward 1
    const f1y = fromY + dir;
    if (inBounds(fromX, f1y, N) && !pieceAt(board, fromX, f1y)) {
      add(fromX, f1y, { promotion: f1y === lastRank });

      // forward 2
      const f2y = fromY + 2 * dir;
      if (fromY === startRank && inBounds(fromX, f2y, N) && !pieceAt(board, fromX, f2y)) {
        add(fromX, f2y, { doublePawn: true });
      }
    }

    // captures
    for (const dx of [-1, 1]) {
      const cx = fromX + dx;
      const cy = fromY + dir;

      if (!inBounds(cx, cy, N)) continue;

      const t = pieceAt(board, cx, cy);
      if (t && t.color !== p.color) {
        add(cx, cy, { promotion: cy === lastRank });
      }
    }

    // en passant
    if (enPassant) {
      for (const dx of [-1, 1]) {
        const tx = fromX + dx;
        const ty = fromY + dir;

        if (tx === enPassant.x && ty === enPassant.y) {
          add(tx, ty, { enPassant: true });
        }
      }
    }

    return moves;
  }

  return moves;
}

function applyMove(state, mv) {
  const b2 = cloneBoard(state.board);
  const p = pieceAt(b2, mv.fromX, mv.fromY);
  if (!p) return null;

  let capture = false;

  // en passant capture
  if (mv.enPassant && p.type === "p") {
    const dir = p.color === "w" ? -1 : 1;
    const capY = mv.toY - dir;
    const cap = pieceAt(b2, mv.toX, capY);

    if (cap && cap.type === "p" && cap.color !== p.color) {
      setAt(b2, mv.toX, capY, null);
      capture = true;
    }
  }

  // normal capture
  const target = pieceAt(b2, mv.toX, mv.toY);
  if (target) capture = true;

  setAt(b2, mv.fromX, mv.fromY, null);

  let movedPiece = { ...p };

  if (p.type === "p" && mv.promotion) {
    const promo = mv.promoType || "q";
    movedPiece = { color: p.color, type: promo };
  }

  setAt(b2, mv.toX, mv.toY, movedPiece);

  // en passant target
  let enPassant = null;

  if (p.type === "p" && mv.doublePawn) {
    const dir = p.color === "w" ? -1 : 1;
    enPassant = { x: mv.fromX, y: mv.fromY + dir };
  }

  let halfmove = state.halfmove;

  if (p.type === "p" || capture) halfmove = 0;
  else halfmove += 1;

  let fullmove = state.fullmove;
  if (state.turn === "b") fullmove += 1;

  return {
    ...state,
    board: b2,
    enPassant,
    turn: otherColor(state.turn),
    halfmove,
    fullmove,
  };
}

function legalMovesFrom(state, fromX, fromY) {
  const p = pieceAt(state.board, fromX, fromY);
  if (!p) return [];

  const pseudo = pseudoMoves(state, fromX, fromY);
  const out = [];

  for (const mv of pseudo) {
    const mvCheck = { ...mv };

    if (mvCheck.promotion && !mvCheck.promoType) {
      mvCheck.promoType = "q";
    }

    const next = applyMove(state, mvCheck);
    if (!next) continue;

    if (kingInCheck(next.board, p.color, state.N)) continue;

    out.push(mv);
  }

  return out;
}

function hasAnyLegalMove(state, color) {
  const N = state.N;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = state.board[y][x];

      if (!p || p.color !== color) continue;
      if (legalMovesFrom(state, x, y).length) return true;
    }
  }

  return false;
}

function positionKey(state) {
  let s = `${state.turn}|ep:${keySquare(state.enPassant)}|N:${state.N}|`;

  for (let y = 0; y < state.N; y++) {
    for (let x = 0; x < state.N; x++) {
      const p = state.board[y][x];
      if (p) s += `${x},${y},${p.color}${p.type};`;
    }
  }

  return s;
}

function serializeBoard(board, N) {
  const pieces = [];

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = board[y][x];

      if (p) {
        pieces.push({ x, y, color: p.color, type: p.type });
      }
    }
  }

  return pieces;
}

// ----------------- rooms + seats -----------------
const rooms = new Map();

function initSeat() {
  return { socketId: null, token: null, timer: null };
}

function cancelTimer(seat) {
  if (seat.timer) clearTimeout(seat.timer);
  seat.timer = null;
}

function attachSeat(room, side, socket, token) {
  const seat = room.seats[side];

  cancelTimer(seat);

  seat.socketId = socket.id;
  seat.token = token;

  socket.data.roomCode = room.code;
  socket.data.side = side;
  socket.data.token = token;

  socket.join(room.code);
}

function assignOrReclaim(room, socket, token) {
  for (const side of ["white", "black"]) {
    if (token && room.seats[side].token === token) {
      attachSeat(room, side, socket, token);
      return side;
    }
  }

  if (!room.seats.white.socketId && !room.seats.white.token) {
    const t = token || makeSessionToken();
    attachSeat(room, "white", socket, t);
    return "white";
  }

  if (!room.seats.black.socketId && !room.seats.black.token) {
    const t = token || makeSessionToken();
    attachSeat(room, "black", socket, t);
    return "black";
  }

  socket.data.roomCode = room.code;
  socket.data.side = "spectator";

  socket.join(room.code);
  return "spectator";
}

function clearSeatSocket(room, side, socketId) {
  const seat = room.seats[side];

  if (seat.socketId !== socketId) return;

  seat.socketId = null;

  cancelTimer(seat);

  seat.timer = setTimeout(() => {
    const r = rooms.get(room.code);
    if (!r) return;

    const s = r.seats[side];
    if (s.socketId) return;

    s.token = null;
    s.timer = null;

    const noActive = !r.seats.white.socketId && !r.seats.black.socketId;
    const noReserved = !r.seats.white.token && !r.seats.black.token;

    if (noActive && noReserved) rooms.delete(r.code);
    else broadcast(r);
  }, DISCONNECT_GRACE_MS);
}

// ----------------- game state -----------------
function makeInitialState(N) {
  return {
    N,
    phase: "setup", // setup | play | gameover
    turn: "w",
    board: emptyBoard(N),
    enPassant: null,
    halfmove: 0,
    fullmove: 1,
    result: null,
    reason: null,
    repetition: new Map(),

    // last move highlight
    lastMove: null, // { from:{x,y}, to:{x,y}, color:"w"|"b", piece:"p"|"n"... }
  };
}

function validateSetup(board, N) {
  const wk = findKing(board, "w", N);
  const bk = findKing(board, "b", N);

  if (!wk || !bk) {
    return { ok: false, msg: "You must place exactly 1 white king and 1 black king." };
  }

  let wkc = 0;
  let bkc = 0;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = board[y][x];

      if (p && p.type === "k") {
        if (p.color === "w") wkc++;
        else bkc++;
      }
    }
  }

  if (wkc !== 1 || bkc !== 1) {
    return { ok: false, msg: "Setup must have exactly 1 king per side." };
  }

  if (kingInCheck(board, "w", N) || kingInCheck(board, "b", N)) {
    return { ok: false, msg: "Illegal setup: a king is in check. Move pieces until both kings are safe." };
  }

  return { ok: true };
}

function endIfNeeded(room) {
  const st = room.state;

  // 50-move rule
  if (st.phase === "play" && st.halfmove >= 100) {
    st.phase = "gameover";
    st.result = "1/2-1/2";
    st.reason = "50-move";
    return;
  }

  // threefold repetition
  if (st.phase === "play") {
    const key = positionKey(st);
    const prev = st.repetition.get(key) || 0;

    st.repetition.set(key, prev + 1);

    if (prev + 1 >= 3) {
      st.phase = "gameover";
      st.result = "1/2-1/2";
      st.reason = "3fold";
      return;
    }
  }

  if (st.phase !== "play") return;

  const sideToMove = st.turn;
  const hasMove = hasAnyLegalMove(st, sideToMove);

  if (hasMove) return;

  const inCheck = kingInCheck(st.board, sideToMove, st.N);

  st.phase = "gameover";

  if (inCheck) {
    st.reason = "checkmate";
    st.result = sideToMove === "w" ? "0-1" : "1-0";
  } else {
    st.reason = "stalemate";
    st.result = "1/2-1/2";
  }
}

function computeCheckInfo(st) {
  const wK = findKing(st.board, "w", st.N);
  const bK = findKing(st.board, "b", st.N);

  const checkW = st.phase === "play" ? kingInCheck(st.board, "w", st.N) : false;
  const checkB = st.phase === "play" ? kingInCheck(st.board, "b", st.N) : false;

  return {
    kingPos: { w: wK, b: bK },
    check: { w: !!checkW, b: !!checkB },
  };
}

function broadcast(room) {
  const st = room.state;
  const chk = computeCheckInfo(st);

  io.to(room.code).emit("roomState", {
    roomCode: room.code,
    boardSize: st.N,
    phase: st.phase,
    turn: st.turn,
    result: st.result,
    reason: st.reason,
    hostSide: room.hostSide,

    players: {
      white: !!room.seats.white.socketId,
      black: !!room.seats.black.socketId,
    },

    boardPieces: serializeBoard(st.board, st.N),
    enPassant: st.enPassant,

    drawOfferFrom: room.drawOfferFrom,
    check: chk.check,
    kingPos: chk.kingPos,

    // last move highlight
    lastMove: st.lastMove || null,
  });
}

// ----------------- sockets -----------------
io.on("connection", (socket) => {
  socket.on("createRoom", ({ sessionToken, hostColor, boardSize } = {}) => {
    let code;

    for (let i = 0; i < 1000; i++) {
      const c = makeCode();

      if (!rooms.has(c)) {
        code = c;
        break;
      }
    }

    if (!code) return;

    const token = sessionToken || makeSessionToken();
    const hostSide = hostColor === "black" ? "black" : "white";
    const N = ALLOWED_SIZES.has(Number(boardSize)) ? Number(boardSize) : 22;

    const room = {
      code,
      hostToken: token,
      hostSide,
      seats: { white: initSeat(), black: initSeat() },
      state: makeInitialState(N),
      drawOfferFrom: null,
    };

    rooms.set(code, room);

    attachSeat(room, hostSide, socket, token);

    socket.emit("joinedRoom", {
      roomCode: code,
      side: hostSide,
      isHost: true,
      sessionToken: token,
    });

    broadcast(room);
  });

  socket.on("joinRoom", ({ roomCode, sessionToken } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit("joinError", { message: "Room not found." });
      return;
    }

    const side = assignOrReclaim(room, socket, sessionToken || null);

    socket.emit("joinedRoom", {
      roomCode: code,
      side,
      isHost: !!socket.data.token && socket.data.token === room.hostToken,
      sessionToken: socket.data.token || null,
    });

    broadcast(room);
  });

  socket.on("rejoinRoom", ({ roomCode, sessionToken } = {}) => {
    const code = String(roomCode || "").trim().toUpperCase();
    const token = String(sessionToken || "").trim();
    const room = rooms.get(code);

    if (!room || !token) {
      socket.emit("joinError", { message: "Could not rejoin room." });
      return;
    }

    const side = assignOrReclaim(room, socket, token);

    socket.emit("joinedRoom", {
      roomCode: code,
      side,
      isHost: token === room.hostToken,
      sessionToken: token,
    });

    broadcast(room);
  });

  // host-only: change board size during setup
  socket.on("setBoardSize", ({ boardSize } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    if (!socket.data.token || socket.data.token !== room.hostToken) return;
    if (room.state.phase !== "setup") return;

    const N = ALLOWED_SIZES.has(Number(boardSize)) ? Number(boardSize) : 22;

    room.state = makeInitialState(N);
    room.drawOfferFrom = null;

    broadcast(room);
  });

  // host-only: load setup code
  socket.on("loadSetup", ({ boardSize, pieces } = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    if (!socket.data.token || socket.data.token !== room.hostToken) return;
    if (room.state.phase !== "setup") return;

    const N = ALLOWED_SIZES.has(Number(boardSize)) ? Number(boardSize) : room.state.N;

    room.state = makeInitialState(N);
    room.drawOfferFrom = null;

    if (Array.isArray(pieces)) {
      for (const it of pieces) {
        const x = Number(it?.x);
        const y = Number(it?.y);
        const color = it?.color === "b" ? "b" : it?.color === "w" ? "w" : null;
        const type = String(it?.type || "").toLowerCase();

        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (!inBounds(x, y, N)) continue;
        if (!color) continue;
        if (!["k", "q", "r", "b", "n", "p"].includes(type)) continue;

        setAt(room.state.board, x, y, { color, type });
      }
    }

    broadcast(room);
  });

  // host-only setup placement
  socket.on("setupPlace", ({ x, y, piece }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    if (!socket.data.token || socket.data.token !== room.hostToken) return;
    if (room.state.phase !== "setup") return;

    const N = room.state.N;

    x = Number(x);
    y = Number(y);

    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!inBounds(x, y, N)) return;

    if (piece === null) {
      setAt(room.state.board, x, y, null);
    } else {
      const color = piece.color === "b" ? "b" : "w";
      const type = String(piece.type || "").toLowerCase();

      if (!["k", "q", "r", "b", "n", "p"].includes(type)) return;

      setAt(room.state.board, x, y, { color, type });
    }

    room.state.lastMove = null;
    broadcast(room);
  });

  socket.on("setupClear", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    if (!socket.data.token || socket.data.token !== room.hostToken) return;
    if (room.state.phase !== "setup") return;

    room.state.board = emptyBoard(room.state.N);
    room.state.lastMove = null;
    room.drawOfferFrom = null;

    broadcast(room);
  });

  socket.on("startGame", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    if (!socket.data.token || socket.data.token !== room.hostToken) return;
    if (room.state.phase !== "setup") return;

    const v = validateSetup(room.state.board, room.state.N);

    if (!v.ok) {
      socket.emit("actionError", { message: v.msg });
      return;
    }

    room.state.phase = "play";
    room.state.turn = "w";
    room.state.enPassant = null;
    room.state.halfmove = 0;
    room.state.fullmove = 1;
    room.state.result = null;
    room.state.reason = null;
    room.state.repetition = new Map();
    room.state.lastMove = null;
    room.drawOfferFrom = null;

    endIfNeeded(room);
    broadcast(room);
  });

  socket.on("resign", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const st = room.state;
    if (st.phase !== "play") return;

    const side = socket.data.side;
    const myC = side === "white" ? "w" : side === "black" ? "b" : null;
    if (!myC) return;

    st.phase = "gameover";
    st.reason = "resign";
    st.result = myC === "w" ? "0-1" : "1-0";
    room.drawOfferFrom = null;

    broadcast(room);
  });

  socket.on("offerDraw", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const st = room.state;
    if (st.phase !== "play") return;

    const side = socket.data.side;
    const myC = side === "white" ? "w" : side === "black" ? "b" : null;
    if (!myC) return;

    room.drawOfferFrom = myC;
    broadcast(room);
  });

  socket.on("acceptDraw", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const st = room.state;

    if (st.phase !== "play") return;
    if (!room.drawOfferFrom) return;

    const side = socket.data.side;
    const myC = side === "white" ? "w" : side === "black" ? "b" : null;
    if (!myC) return;

    if (room.drawOfferFrom === myC) return;

    st.phase = "gameover";
    st.reason = "draw agreed";
    st.result = "1/2-1/2";
    room.drawOfferFrom = null;

    broadcast(room);
  });

  socket.on("declineDraw", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const st = room.state;

    if (st.phase !== "play") return;
    if (!room.drawOfferFrom) return;

    const side = socket.data.side;
    const myC = side === "white" ? "w" : side === "black" ? "b" : null;
    if (!myC) return;

    room.drawOfferFrom = null;
    broadcast(room);
  });

  // host-only: new game, same board size
  socket.on("newGame", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    if (!socket.data.token || socket.data.token !== room.hostToken) return;

    const N = room.state.N;

    room.state = makeInitialState(N);
    room.drawOfferFrom = null;

    broadcast(room);
  });

  socket.on("requestMoves", ({ x, y }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const st = room.state;

    x = Number(x);
    y = Number(y);

    if (st.phase !== "play") {
      socket.emit("legalMoves", { from: { x, y }, moves: [] });
      return;
    }

    const side = socket.data.side;
    const myC = side === "white" ? "w" : side === "black" ? "b" : null;

    if (!myC || myC !== st.turn) {
      socket.emit("legalMoves", { from: { x, y }, moves: [] });
      return;
    }

    if (!Number.isFinite(x) || !Number.isFinite(y) || !inBounds(x, y, st.N)) {
      socket.emit("legalMoves", { from: { x, y }, moves: [] });
      return;
    }

    const p = pieceAt(st.board, x, y);

    if (!p || p.color !== myC) {
      socket.emit("legalMoves", { from: { x, y }, moves: [] });
      return;
    }

    const legal = legalMovesFrom(st, x, y);

    const moves = legal.map((m) => {
      const target = pieceAt(st.board, m.toX, m.toY);
      const capture = !!m.enPassant || (!!target && target.color !== myC);

      return {
        x: m.toX,
        y: m.toY,
        promotion: !!m.promotion,
        capture,
      };
    });

    socket.emit("legalMoves", { from: { x, y }, moves });
  });

  socket.on("move", ({ from, to, promoType }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    const st = room.state;

    if (st.phase !== "play") return;

    const side = socket.data.side;
    const myC = side === "white" ? "w" : side === "black" ? "b" : null;

    if (!myC || myC !== st.turn) return;

    const fx = Number(from?.x);
    const fy = Number(from?.y);
    const tx = Number(to?.x);
    const ty = Number(to?.y);

    if (![fx, fy, tx, ty].every(Number.isFinite)) return;
    if (!inBounds(fx, fy, st.N) || !inBounds(tx, ty, st.N)) return;

    const p = pieceAt(st.board, fx, fy);

    if (!p || p.color !== myC) return;

    const legal = legalMovesFrom(st, fx, fy);
    const found = legal.find((m) => m.toX === tx && m.toY === ty);

    if (!found) {
      socket.emit("actionError", { message: "Illegal move." });
      return;
    }

    const mv = {
      ...found,
      promoType: found.promotion ? promoType || "q" : undefined,
    };

    const next = applyMove(st, mv);
    if (!next) return;

    // last move highlight
    next.lastMove = {
      from: { x: fx, y: fy },
      to: { x: tx, y: ty },
      color: myC,
      piece: p.type,
    };

    room.state = next;
    room.drawOfferFrom = null;

    endIfNeeded(room);
    broadcast(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;

    if (socket.data.side === "white") clearSeatSocket(room, "white", socket.id);
    if (socket.data.side === "black") clearSeatSocket(room, "black", socket.id);

    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Chess server running at http://localhost:${PORT}`);
});