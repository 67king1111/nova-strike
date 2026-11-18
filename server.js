'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const MAX_ONLINE = 8;
const ROOM_SIZE = 2; // 1v1；全伺服器可同時容納 4 場
const ARENA_LIMIT = 47;
const rooms = new Map();
const waitingQueue = [];
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(',') : true },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000
});

app.get('/health', (_req, res) => res.json({ ok: true, online: io.engine.clientsCount, rooms: rooms.size }));
app.use(express.static(path.join(__dirname)));

function code6() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function cleanInfo(info = {}) {
  return {
    agent: String(info.agent || 'Astra').slice(0, 32),
    role: String(info.role || '').slice(0, 20)
  };
}
function playerView(p) {
  return {
    id: p.id, agent: p.agent, role: p.role,
    x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
    weapon: p.weapon, hp: p.hp, score: p.score, respawn: p.respawn
  };
}
function sendState(room) {
  const payload = { players: [...room.players.values()].map(playerView) };
  for (const id of room.players.keys()) io.to(id).emit('mp:state', payload);
}
function beginIfReady(room) {
  if (room.players.size !== ROOM_SIZE || room.started) return;
  room.started = true;
  const list = [...room.players.values()];
  list.forEach((p, index) => {
    p.x = index === 0 ? 0 : 0;
    p.y = 0;
    p.z = index === 0 ? 8 : -8;
    p.yaw = index === 0 ? 0 : Math.PI;
    p.pitch = 0; p.hp = 100; p.score = 0; p.respawn = false;
    p.lastMove = Date.now(); p.lastShot = 0;
  });
  for (const p of list) {
    io.to(p.id).emit('mp:matchStarted', {
      code: room.code, you: p.id,
      players: list.map(q => ({ ...playerView(q), spawn: { x: q.x, y: q.y, z: q.z }, yaw: q.yaw }))
    });
  }
  sendState(room);
}
function addToRoom(socket, room, info) {
  if (room.players.size >= ROOM_SIZE) return false;
  const meta = cleanInfo(info);
  room.players.set(socket.id, {
    id: socket.id, ...meta, x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    weapon: 1, hp: 100, score: 0, respawn: false,
    lastMove: Date.now(), lastShot: 0
  });
  socket.data.roomCode = room.code;
  socket.join(room.code);
  return true;
}
function leaveRoom(socket, reason = 'player-left') {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.data.roomCode = null;
  socket.leave(code);
  if (!room) return;
  room.players.delete(socket.id);
  for (const id of room.players.keys()) io.to(id).emit('mp:playerLeft', { id: socket.id, reason });
  if (room.players.size === 0) rooms.delete(code);
  else {
    room.started = false;
    for (const p of room.players.values()) io.to(p.id).emit('mp:waiting', { code, message: '對手已離開，等待新玩家加入…' });
  }
}
function error(socket, message) { socket.emit('mp:error', { message }); }

io.on('connection', socket => {
  if (io.engine.clientsCount > MAX_ONLINE) {
    error(socket, '伺服器目前最多 8 人，請稍後再試。');
    socket.disconnect(true);
    return;
  }

  socket.on('mp:createRoom', info => {
    if (socket.data.roomCode) return error(socket, '你已在房間內，請先離開目前房間。');
    if (io.engine.clientsCount > MAX_ONLINE) return error(socket, '伺服器人數已滿。');
    const code = code6();
    const room = { code, players: new Map(), started: false, createdAt: Date.now() };
    rooms.set(code, room);
    addToRoom(socket, room, info);
    socket.emit('mp:roomCreated', { code });
    socket.emit('mp:waiting', { code, message: '好友房已建立，等待另一位玩家加入…' });
  });

  socket.on('mp:joinRoom', data => {
    if (socket.data.roomCode) return error(socket, '你已在房間內，請先離開目前房間。');
    const code = String(data?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const room = rooms.get(code);
    if (!room) return error(socket, '找不到這個房間，請確認代碼。');
    if (room.players.size >= ROOM_SIZE || room.started) return error(socket, '房間已滿，請建立其他房間。');
    addToRoom(socket, room, data);
    beginIfReady(room);
  });

  socket.on('mp:quickMatch', info => {
    if (socket.data.roomCode) return error(socket, '你已在房間內，請先離開目前房間。');
    let room = [...rooms.values()].find(r => !r.started && r.players.size === 1 && r.quick);
    if (!room) {
      const code = code6();
      room = { code, players: new Map(), started: false, quick: true, createdAt: Date.now() };
      rooms.set(code, room);
      addToRoom(socket, room, info);
      socket.emit('mp:waiting', { code, message: '正在等待對手加入快速配對…' });
    } else {
      addToRoom(socket, room, info);
      beginIfReady(room);
    }
  });

  socket.on('mp:ready', () => {
    const room = rooms.get(socket.data.roomCode);
    if (room) sendState(room);
  });

  socket.on('mp:move', data => {
    const room = rooms.get(socket.data.roomCode);
    const p = room?.players.get(socket.id);
    if (!room?.started || !p || p.respawn || !data) return;
    const now = Date.now();
    const dt = Math.max(0.02, Math.min(0.25, (now - p.lastMove) / 1000));
    p.lastMove = now;
    const nx = Number(data.x), ny = Number(data.y), nz = Number(data.z);
    if (![nx, ny, nz, Number(data.yaw), Number(data.pitch)].every(Number.isFinite)) return;
    // Server-side movement sanity check: clamp arena bounds and reject implausible teleports.
    const dx = nx - p.x, dz = nz - p.z;
    const maxStep = 13 * dt + 1.0;
    const dist = Math.hypot(dx, dz);
    if (dist > maxStep) {
      const scale = maxStep / dist;
      p.x += dx * scale; p.z += dz * scale;
    } else { p.x = nx; p.z = nz; }
    p.x = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, p.x));
    p.z = Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, p.z));
    p.y = Math.max(0, Math.min(5, ny));
    p.yaw = Number(data.yaw); p.pitch = Math.max(-1.35, Math.min(1.35, Number(data.pitch)));
    const weapon = Number(data.weapon);
    if (Number.isInteger(weapon) && weapon >= 0 && weapon <= 13) p.weapon = weapon;
    if (typeof data.agent === 'string') p.agent = data.agent.slice(0, 32);
    socket.to(room.code).emit('mp:move', playerView(p));
  });

  socket.on('mp:weapon', data => {
    const room = rooms.get(socket.data.roomCode), p = room?.players.get(socket.id);
    const weapon = Number(data?.weapon);
    if (!room?.started || !p || !Number.isInteger(weapon) || weapon < 0 || weapon > 13) return;
    p.weapon = weapon;
    socket.to(room.code).emit('mp:weapon', { id: socket.id, weapon });
  });

  socket.on('mp:skill', data => {
    const room = rooms.get(socket.data.roomCode), p = room?.players.get(socket.id);
    const key = String(data?.key || '').toLowerCase();
    if (!room?.started || !p || !['q', 'e', 'r', 't'].includes(key)) return;
    socket.to(room.code).emit('mp:skill', { id: socket.id, key });
  });

  socket.on('mp:shot', data => {
    const room = rooms.get(socket.data.roomCode), shooter = room?.players.get(socket.id);
    if (!room?.started || !shooter || shooter.respawn) return;
    const now = Date.now();
    const weapon = Number(data?.weapon);
    const yaw = Number(data?.yaw), pitch = Number(data?.pitch);
    if (!Number.isInteger(weapon) || weapon < 0 || weapon > 13 || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    const fireDelay = weapon === 4 ? 220 : weapon === 5 ? 750 : weapon === 6 ? 850 : weapon === 7 ? 100 : weapon === 1 ? 180 : 140;
    if (now - shooter.lastShot < fireDelay) return;
    shooter.lastShot = now;
    const origin = { x: shooter.x, y: shooter.y + 1.45, z: shooter.z };
    const cp = Math.cos(pitch);
    const dir = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
    const range = weapon === 6 ? 180 : 100;
    const target = [...room.players.values()].find(p => p.id !== socket.id);
    let end = { x: origin.x + dir.x * range, y: origin.y + dir.y * range, z: origin.z + dir.z * range };
    let hit = false;
    if (target && target.hp > 0) {
      // Approximate server-side hit test against the opponent's capsule.
      const center = { x: target.x, y: target.y + 1.0, z: target.z };
      const vx = center.x - origin.x, vy = center.y - origin.y, vz = center.z - origin.z;
      const t = vx * dir.x + vy * dir.y + vz * dir.z;
      if (t > 0 && t < range) {
        const px = origin.x + dir.x * t, py = origin.y + dir.y * t, pz = origin.z + dir.z * t;
        const miss = Math.hypot(center.x - px, (center.y - py) * 0.8, center.z - pz);
        if (miss < 1.0) {
          hit = true;
          end = { x: px, y: py, z: pz };
          const damage = weapon === 5 ? 48 : weapon === 6 ? 100 : weapon === 4 ? 34 : weapon === 7 ? 12 : weapon === 1 ? 18 : 24;
          target.hp = Math.max(0, target.hp - damage);
          if (target.hp <= 0) {
            shooter.score += 1;
            target.respawn = true;
            sendState(room);
            setTimeout(() => {
              const liveRoom = rooms.get(room.code), liveTarget = liveRoom?.players.get(target.id);
              if (!liveTarget || !liveRoom.started) return;
              liveTarget.hp = 100; liveTarget.respawn = false;
              const seat = [...liveRoom.players.keys()].indexOf(target.id);
              liveTarget.x = 0; liveTarget.y = 0; liveTarget.z = seat === 0 ? 8 : -8;
              liveTarget.yaw = seat === 0 ? 0 : Math.PI;
              sendState(liveRoom);
            }, 2200);
            if (shooter.score >= 10) {
              room.started = false;
              for (const id of room.players.keys()) io.to(id).emit('mp:matchEnded', { winner: shooter.id, reason: '先取得 10 分' });
            }
          }
        }
      }
    }
    io.to(room.code).emit('mp:shotFx', { id: socket.id, from: origin, to: end, weapon });
    sendState(room);
  });

  socket.on('mp:leave', () => leaveRoom(socket, 'leave'));
  socket.on('disconnect', () => {
    waitingQueue.splice(0, waitingQueue.indexOf(socket.id) === -1 ? 0 : 1);
    leaveRoom(socket, 'disconnect');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Star Breakout 3D multiplayer server listening on ${PORT}`);
});
