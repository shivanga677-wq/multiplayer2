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
let scores = {};      // { playerId: number }
let roundOver = false; // blocks hits after someone dies until reset

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

const MAPS = ['arena', 'docks'];
let currentMap = 'arena';
let mapVotes = {};    // { playerId: mapId }

// --- TIMER SYSTEM ---
let roundTime = 90;
let timerInterval = null;

function chooseNextMap() {
  const counts = Object.fromEntries(MAPS.map(map => [map, 0]));
  for (const vote of Object.values(mapVotes)) {
    if (counts[vote] !== undefined) counts[vote]++;
  }

  const topVotes = Math.max(...Object.values(counts));
  const tiedMaps = MAPS.filter(map => counts[map] === topVotes);
  currentMap = tiedMaps[Math.floor(Math.random() * tiedMaps.length)];
  mapVotes = {};
  broadcastAll({ type: 'mapVotes', votes: mapVotes, selectedMap: currentMap });
  return currentMap;
}

function currentSpawnPositions() {
  return MAP_SPAWNS[currentMap] || MAP_SPAWNS.arena;
}

function scorePayload() {
  return Object.fromEntries(Object.keys(players).map(pid => [pid, scores[pid] || 0]));
}

function awardPoint(playerId) {
  if (!players[playerId]) return;
  scores[playerId] = (scores[playerId] || 0) + 1;
  broadcastAll({ type: 'score', scores: scorePayload(), scorerId: playerId });
}

function playerListPayload() {
  return Object.keys(players).map(pid => ({
    id: pid,
    name: names[pid] || 'PLAYER',
    hp: hp[pid] || 0,
    score: scores[pid] || 0,
  }));
}

function sendAdminState(ws) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'adminState', players: playerListPayload() }));
  }
}

function broadcastAdminState() {
  for (const ws of Object.values(players)) {
    if (ws.isAdmin) sendAdminState(ws);
  }
}

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

      if (winnerId) awardPoint(winnerId);

      broadcastAll({ type: 'timeUp', winnerId });

      setTimeout(() => {
        pids.forEach(pid => hp[pid] = 100);
        roundOver = false;
        const nextMap = chooseNextMap();
        const spawns = MAP_SPAWNS[nextMap] || MAP_SPAWNS.arena;
        broadcastAll({
          type: 'reset',
          map: nextMap,
          spawns: Object.fromEntries(pids.map((pid, idx) => [pid, spawns[idx]]))
        });
        startTimer();
      }, 3000);
    }
  }, 1000);
}

const MAP_SPAWNS = {
  arena: [
    { x: 0, y: 1, z: -17 },
    { x: 0, y: 1, z: 17 },
    { x: 0, y: 1, z: 0 },
  ],
  docks: [
    { x: -16, y: 1, z: -12 },
    { x: 16, y: 1, z: 12 },
    { x: 0, y: 1, z: 0 },
  ],
};

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
  scores[id] = scores[id] || 0;

  const spawnPositions = currentSpawnPositions();
  const spawn = spawnPositions[spawnIdx];

  ws.send(JSON.stringify({
    type: 'init', id, spawnIdx, spawn, map: currentMap, mapVotes, scores: scorePayload(),
    players: Object.fromEntries(
      Object.keys(players)
        .filter(pid => pid !== id)
        .map((pid, idx) => [pid, { id: pid, hp: hp[pid] || 100, name: names[pid] || 'PLAYER', pos: spawnPositions[idx] || spawnPositions[0] }])
    )
  }));
  
  // Sync current time to new player
  ws.send(JSON.stringify({ type: 'time', time: roundTime }));

  broadcast({ type: 'playerJoined', id, name: names[id], spawn, map: currentMap }, id);
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
        broadcastAdminState();
        break;
      }

      case 'adminLogin': {
        const username = String(msg.username || '');
        const password = String(msg.password || '');
        if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
          ws.isAdmin = true;
          ws.send(JSON.stringify({ type: 'adminLogin', ok: true }));
          sendAdminState(ws);
        } else {
          ws.send(JSON.stringify({ type: 'adminLogin', ok: false, error: 'Bad username or password' }));
        }
        break;
      }

      case 'adminKick': {
        if (!ws.isAdmin) break;
        const targetId = String(msg.targetId || '');
        const targetWs = players[targetId];
        if (!targetWs) break;
        targetWs.send(JSON.stringify({ type: 'adminKicked', reason: 'Kicked by admin' }));
        targetWs.close();
        break;
      }

      case 'adminCoins': {
        if (!ws.isAdmin) break;
        const targetId = String(msg.targetId || '');
        const targetWs = players[targetId];
        if (!targetWs) break;
        const mode = msg.mode === 'set' ? 'set' : 'add';
        const amount = Math.max(0, Math.min(999999, Math.floor(Number(msg.amount) || 0)));
        targetWs.send(JSON.stringify({ type: 'adminCoins', mode, amount }));
        ws.send(JSON.stringify({ type: 'adminNotice', text: `${mode === 'set' ? 'Set' : 'Added'} coins for ${names[targetId] || 'PLAYER'}` }));
        break;
      }

      case 'adminRefresh':
        if (ws.isAdmin) sendAdminState(ws);
        break;

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
          awardPoint(id);
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
              const nextMap = chooseNextMap();
              const spawns = MAP_SPAWNS[nextMap] || MAP_SPAWNS.arena;
              broadcastAll({
                type: 'reset',
                map: nextMap,
                spawns: Object.fromEntries(Object.keys(players).map((pid, idx) => [pid, spawns[idx]]))
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

      case 'voteMap': {
        const map = String(msg.map || '');
        if (!MAPS.includes(map)) break;
        mapVotes[id] = map;
        broadcastAll({ type: 'mapVotes', votes: mapVotes, selectedMap: currentMap });
        break;
      }
    }
  });

  ws.on('close', () => {
    delete players[id];
    delete hp[id];
    delete names[id];
    delete scores[id];
    delete mapVotes[id];
    broadcast({ type: 'playerLeft', id });
    broadcastAll({ type: 'score', scores: scorePayload() });
    broadcastAll({ type: 'mapVotes', votes: mapVotes, selectedMap: currentMap });
    broadcastAdminState();
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