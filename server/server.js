// Discord Annotate - WebSocket relay / sync server.
//
// The server is intentionally dumb: it holds per-room state (the sharer's
// canvas dimensions + the list of committed shapes) so late joiners can be
// caught up, and it fans out draw events to everyone else in the room.
//
// EVERY coordinate that crosses the wire is normalized to 0..1 relative to the
// shared region, so the sharer and each viewer can render into wildly different
// on-screen rectangles and still stay perfectly consistent.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4321;
// Optional shared secret. If set, clients must connect with ?token=<JOIN_TOKEN>.
// Keeps random people off your server without needing user accounts.
const JOIN_TOKEN = process.env.JOIN_TOKEN || null;

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Screenshare Annotate sync server is running.\n');
});
// 1 MB cap per message - big enough for long pen strokes, small enough to reject abuse.
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

/** roomName -> { canvas:{width,height}|null, shapes:[], calibration:bool, clients:Set } */
const rooms = new Map();

function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, { canvas: null, shapes: [], calibration: false, clients: new Set() });
  }
  return rooms.get(name);
}

function broadcast(room, data, except) {
  const msg = JSON.stringify(data);
  for (const c of room.clients) {
    if (c !== except && c.readyState === 1) c.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  if (JOIN_TOKEN) {
    let token = null;
    try { token = new URL(req.url, 'http://x').searchParams.get('token'); } catch {}
    if (token !== JOIN_TOKEN) { ws.close(1008, 'bad token'); return; }
  }
  ws.userId = Math.random().toString(36).slice(2, 10);
  ws.room = null;
  ws.roomName = null;

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }

    if (m.type === 'join') {
      const room = getRoom(m.room);
      ws.room = room;
      ws.roomName = m.room;
      ws.role = m.role;
      ws.name = m.name || 'anon';
      room.clients.add(ws);
      // Catch the newcomer up on everything that already exists.
      ws.send(JSON.stringify({
        type: 'welcome',
        userId: ws.userId,
        canvas: room.canvas,
        shapes: room.shapes,
        calibration: room.calibration,
      }));
      broadcast(room, { type: 'peer-join', name: ws.name, role: ws.role }, ws);
      console.log(`[${m.room}] ${ws.name} joined as ${ws.role} (${room.clients.size} online)`);
      return;
    }

    const room = ws.room;
    if (!room) return;

    switch (m.type) {
      case 'canvas-info':
        room.canvas = { width: m.width, height: m.height };
        broadcast(room, { type: 'canvas-info', width: m.width, height: m.height }, ws);
        break;

      case 'draw':
        room.shapes.push(m.shape);
        broadcast(room, { type: 'draw', shape: m.shape }, ws);
        break;

      case 'draw-update': // live, in-progress stroke - not persisted
        broadcast(room, { type: 'draw-update', shape: m.shape }, ws);
        break;

      case 'delete':
        room.shapes = room.shapes.filter((s) => !m.ids.includes(s.id));
        broadcast(room, { type: 'delete', ids: m.ids }, ws);
        break;

      case 'undo-last': {
        for (let i = room.shapes.length - 1; i >= 0; i--) {
          if (room.shapes[i].userId === m.userId) {
            const id = room.shapes[i].id;
            room.shapes.splice(i, 1);
            broadcast(room, { type: 'delete', ids: [id] }); // to all, incl. sender
            break;
          }
        }
        break;
      }

      case 'clear':
        room.shapes = [];
        broadcast(room, { type: 'clear' }); // to all, incl. sender
        break;

      case 'calibration':
        room.calibration = m.on;
        broadcast(room, { type: 'calibration', on: m.on }, ws);
        break;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.clients.delete(ws);
    broadcast(room, { type: 'peer-leave', name: ws.name });
    console.log(`[${ws.roomName}] ${ws.name} left (${room.clients.size} online)`);
    if (room.clients.size === 0) rooms.delete(ws.roomName);
  });
});

server.listen(PORT, () => console.log(`Discord Annotate sync server listening on :${PORT}`));
