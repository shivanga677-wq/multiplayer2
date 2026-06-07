const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');


const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };
  const contentType = mimeTypes[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

let players = {};
let nextId = 1;
let hp = {};          // { playerId: number }
let names = {};       // { playerId: string }
let roundOver = false; // blocks hits after someone dies until reset

// --- TIMER SYSTEM ---
let roundTime = 90;
let timerInterval = null;

function startTimer() {
  roundTime = 90;
  clearInterval(timerInterval);
  broadcastAll({ type: 'time', time: roundTime });

  timerInterval = setInterval(() => {
    if (roundOver || Object.keys(players).length < 2) return; 
    
    roundTime--;
    broadcastAll({ type: 'time', time: roundTime });

    if (roundTime <= 0) {
      roundOver = true;
      clearInterval(timerInterval);
      
      const pids = Object.keys(players);
      let winnerId = null;
      if (pids.length >= 2) {
        const hps = pids.map(pid => ({ pid, hp: hp[pid] }));
        hps.sort((a, b) => b.hp - a.hp);
        if (hps[0].hp > hps[1].hp) winnerId = hps[0].pid;
      }

      broadcastAll({ type: 'timeUp', winnerId });

      setTimeout(() => {
        pids.forEach(pid => hp[pid] = 100);
        roundOver = false;
        broadcastAll({
          type: 'reset',
          spawns: Object.fromEntries(pids.map((pid, idx) => [pid, SPAWN_POSITIONS[idx]]))
        });
        startTimer();
      }, 3000);
    }
  }, 1000);
}

const SPAWN_POSITIONS = [
  { x: 0, y: 1, z: -17 },
  { x: 0, y: 1, z: 17 },
  { x: 0, y: 1, z: 0 },
];

function broadcast(data, excludeId) {
  const msg = JSON.stringify(data);
  for (const [id, ws] of Object.entries(players)) {
    if (id !== excludeId && ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function broadcastAll(data) {
  const msg = JSON.stringify(data);
  for (const ws of Object.values(players)) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  if (Object.keys(players).length >= 3) {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }

  const id = String(nextId++);
  const spawnIdx = Object.keys(players).length;
  players[id] = ws;
  hp[id] = 100;
  names[id] = 'PLAYER';

  const spawn = SPAWN_POSITIONS[spawnIdx];

  ws.send(JSON.stringify({
    type: 'init', id, spawnIdx, spawn,
    players: Object.fromEntries(
      Object.keys(players)
        .filter(pid => pid !== id)
        .map(pid => [pid, { id: pid, hp: hp[pid] || 100, name: names[pid] || 'PLAYER', pos: SPAWN_POSITIONS[spawnIdx === 0 ? 1 : 0] }])
    )
  }));
  
  // Sync current time to new player
  ws.send(JSON.stringify({ type: 'time', time: roundTime }));

  broadcast({ type: 'playerJoined', id, name: names[id], spawn }, id);
  console.log(`Player ${id} connected (slot ${spawnIdx}). Total: ${Object.keys(players).length}`);

  // Start timer when both players are connected
  if (Object.keys(players).length === 2) {
    startTimer();
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'setName': {
        const safeName = String(msg.name || 'PLAYER').slice(0, 16).replace(/[<>]/g, '');
        names[id] = safeName;
        broadcast({ type: 'playerName', id, name: safeName }, id);
        break;
      }

      case 'move':
        broadcast({ type: 'move', id, pos: msg.pos, rot: msg.rot }, id);
        break;

      case 'shoot':
        broadcast({ type: 'shoot', id, weapon: msg.weapon, origin: msg.origin, dir: msg.dir, didHit: !!msg.didHit }, id);
        break;

      case 'hit': {
        if (roundOver) break;
        const targetId = msg.targetId;
        if (!players[targetId] || hp[targetId] === undefined) break;

        const dmg = Math.max(0, Number(msg.damage) || 0);
        if (dmg === 0) break;

        hp[targetId] = Math.max(0, hp[targetId] - dmg);
        broadcastAll({ type: 'damage', targetId, hp: hp[targetId], shooterId: id, damage: dmg, isHeadshot: !!msg.isHeadshot, isDirectHit: !!msg.isDirectHit, weapon: msg.weapon || '' });

        if (hp[targetId] <= 0) {
          // Broadcast kill immediately
          broadcastAll({ type: 'kill', killerId: id, victimId: targetId });
          
          // Count how many players are still alive
          const playersAlive = Object.keys(players).filter(pid => hp[pid] > 0).length;
          
          // Only end round if 1 or fewer players remain
          if (playersAlive <= 1) {
            roundOver = true;
            clearInterval(timerInterval); // Stop timer on kill
            setTimeout(() => {
              Object.keys(players).forEach(pid => hp[pid] = 100);
              roundOver = false;
              broadcastAll({
                type: 'reset',
                spawns: Object.fromEntries(Object.keys(players).map((pid, idx) => [pid, SPAWN_POSITIONS[idx]]))
              });
              startTimer(); // Restart timer
            }, 3000);
          }
        }
        break;
      }

      case 'reload':
        broadcast({ type: 'reload', id, weapon: msg.weapon }, id);
        break;

      case 'emote':
        broadcast({ type: 'emote', id, audioData: msg.audioData || null }, id);
        break;

      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 120).replace(/[<>]/g, '');
        if (!text) break;
        broadcastAll({ type: 'chat', id, text });
        break;
      }
    }
  });

  ws.on('close', () => {
    delete players[id];
    delete hp[id];
    delete names[id];
    broadcast({ type: 'playerLeft', id });
    console.log(`Player ${id} disconnected. Total: ${Object.keys(players).length}`);
    
    // Stop timer if a player leaves
    if (Object.keys(players).length < 2) {
      clearInterval(timerInterval);
      roundTime = 90;
      broadcastAll({ type: 'time', time: roundTime });
    }
  });
});

// Use the environment variable PORT provided by the host, 
// OR default to 3000 if no variable is found.
const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🎮 FPS Server running on port ${PORT}`);
});