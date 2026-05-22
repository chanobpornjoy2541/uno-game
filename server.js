const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ========== Game Logic ==========
const COLORS = ['red', 'yellow', 'green', 'blue'];

function createDeck() {
  const deck = [];
  let id = 0;
  COLORS.forEach(color => {
    deck.push({ id: id++, color, value: '0', type: 'number' });
    for (let i = 1; i <= 9; i++) {
      deck.push({ id: id++, color, value: String(i), type: 'number' });
      deck.push({ id: id++, color, value: String(i), type: 'number' });
    }
    for (let i = 0; i < 2; i++) {
      deck.push({ id: id++, color, value: 'skip', type: 'action' });
      deck.push({ id: id++, color, value: 'reverse', type: 'action' });
      deck.push({ id: id++, color, value: '+2', type: 'action' });
    }
  });
  for (let i = 0; i < 4; i++) {
    deck.push({ id: id++, color: 'wild', value: 'wild', type: 'wild' });
    deck.push({ id: id++, color: 'wild', value: '+4', type: 'wild' });
  }
  // Special: Swap Hands card (1 card per deck)
  deck.push({ id: id++, color: 'wild', value: 'swap', type: 'wild' });
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function canPlay(card, top, currentColor) {
  if (card.type === 'wild') return true;
  if (card.color === currentColor) return true;
  if (card.value === top.value) return true;
  return false;
}

// ========== Stats Storage ==========
const STATS_FILE = path.join(__dirname, 'stats.json');
let stats = {};
try {
  if (fs.existsSync(STATS_FILE)) {
    stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
  }
} catch (e) { stats = {}; }

function saveStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats));
  } catch (e) { console.error('Save stats failed:', e); }
}

function recordWin(name) {
  if (!name) return;
  if (!stats[name]) stats[name] = { wins: 0, games: 0 };
  stats[name].wins++;
  saveStats();
}

function recordGame(names) {
  names.forEach(name => {
    if (!name) return;
    if (!stats[name]) stats[name] = { wins: 0, games: 0 };
    stats[name].games++;
  });
  saveStats();
}

function getLeaderboard() {
  return Object.entries(stats)
    .map(([name, s]) => ({ name, wins: s.wins, games: s.games }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 10);
}

// ========== Room Management ==========
const rooms = {};

function genRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function createRoom(hostId, hostName) {
  let code;
  do { code = genRoomCode(); } while (rooms[code]);
  rooms[code] = {
    code,
    hostId,
    players: [{ id: hostId, name: hostName, hand: [], connected: true, calledUno: false }],
    state: 'waiting',
    drawPile: [],
    discardPile: [],
    currentPlayer: 0,
    direction: 1,
    currentColor: null,
    winner: null,
    message: '',
    chat: []
  };
  return rooms[code];
}

function getPublicState(room, forPlayerId) {
  return {
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      handCount: p.hand.length,
      hand: p.id === forPlayerId ? p.hand : undefined,
      connected: p.connected,
      calledUno: p.calledUno
    })),
    topCard: room.discardPile[room.discardPile.length - 1] || null,
    drawPileCount: room.drawPile.length,
    currentPlayer: room.currentPlayer,
    direction: room.direction,
    currentColor: room.currentColor,
    winner: room.winner,
    message: room.message,
    chat: room.chat.slice(-30)
  };
}

function broadcast(room) {
  room.players.forEach(p => {
    io.to(p.id).emit('state', getPublicState(room, p.id));
  });
}

function startGame(room) {
  let deck = shuffle(createDeck());
  room.players.forEach(p => { p.hand = deck.splice(0, 7); p.calledUno = false; });
  let firstCard = deck.shift();
  while (firstCard.type !== 'number') {
    deck.push(firstCard);
    deck = shuffle(deck);
    firstCard = deck.shift();
  }
  room.drawPile = deck;
  room.discardPile = [firstCard];
  room.currentColor = firstCard.color;
  room.currentPlayer = 0;
  room.direction = 1;
  room.winner = null;
  room.state = 'playing';
  room.message = `Game started! ${room.players[0].name}'s turn.`;
  recordGame(room.players.map(p => p.name));
}

function drawCards(room, playerIdx, count) {
  for (let i = 0; i < count; i++) {
    if (room.drawPile.length === 0) {
      const top = room.discardPile.pop();
      room.drawPile = shuffle(room.discardPile);
      room.discardPile = [top];
    }
    if (room.drawPile.length > 0) {
      room.players[playerIdx].hand.push(room.drawPile.shift());
    }
  }
}

function advanceTurn(room, skip = 1) {
  const n = room.players.length;
  let next = room.currentPlayer;
  for (let i = 0; i < skip; i++) {
    next = (next + room.direction + n) % n;
  }
  room.currentPlayer = next;
}

// ========== Socket.IO ==========
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.emit('leaderboard', getLeaderboard());

  socket.on('getLeaderboard', () => {
    socket.emit('leaderboard', getLeaderboard());
  });

  socket.on('createRoom', ({ name }) => {
    const room = createRoom(socket.id, name || 'Player');
    socket.join(room.code);
    socket.emit('roomCreated', { code: room.code });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error', { message: 'Room not found' });
    if (room.state !== 'waiting') return socket.emit('error', { message: 'Game already started' });
    if (room.players.length >= 10) return socket.emit('error', { message: 'Room is full' });
    
    room.players.push({ id: socket.id, name: name || 'Player', hand: [], connected: true, calledUno: false });
    socket.join(room.code);
    socket.emit('roomJoined', { code: room.code });
    broadcast(room);
  });

  socket.on('startGame', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return socket.emit('error', { message: 'Need at least 2 players' });
    startGame(room);
    broadcast(room);
  });

  socket.on('playCard', ({ code, cardId, chosenColor, targetId }) => {
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;
    
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== room.currentPlayer) return;
    
    const player = room.players[playerIdx];
    const cardIdx = player.hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) return;
    
    const card = player.hand[cardIdx];
    const top = room.discardPile[room.discardPile.length - 1];
    
    if (!canPlay(card, top, room.currentColor)) {
      return socket.emit('error', { message: "Can't play that card" });
    }
    
    if (card.type === 'wild' && !chosenColor) {
      return socket.emit('error', { message: 'Choose a color' });
    }
    
    // Swap card requires a target
    if (card.value === 'swap' && !targetId) {
      return socket.emit('error', { message: 'Choose a player to swap with' });
    }
    
    player.hand.splice(cardIdx, 1);
    room.discardPile.push(card);
    room.currentColor = card.type === 'wild' ? chosenColor : card.color;
    
    // Handle swap effect
    let swapMessage = '';
    if (card.value === 'swap') {
      const targetIdx = room.players.findIndex(p => p.id === targetId);
      if (targetIdx !== -1 && targetIdx !== playerIdx) {
        const target = room.players[targetIdx];
        const tempHand = player.hand;
        player.hand = target.hand;
        target.hand = tempHand;
        // Reset UNO flags after swap (hand sizes changed)
        player.calledUno = false;
        target.calledUno = false;
        swapMessage = ` and swapped hands with ${target.name}!`;
      }
    }
    
    // UNO penalty: if player went down to 1 card but didn't call UNO before playing
    if (player.hand.length === 1 && !player.calledUno) {
      drawCards(room, playerIdx, 2);
      room.message = `${player.name} forgot to call UNO! Draws 2 cards. 😅`;
      broadcast(room);
    } else if (player.hand.length !== 1) {
      // Reset UNO call when no longer at 1 card
      player.calledUno = false;
    }
    
    let skip = 1;
    let penalty = 0;
    
    if (card.value === 'reverse') {
      room.direction = -room.direction;
      if (room.players.length === 2) skip = 2;
    } else if (card.value === 'skip') {
      skip = 2;
    } else if (card.value === '+2') {
      penalty = 2; skip = 2;
    } else if (card.value === '+4') {
      penalty = 4; skip = 2;
    }
    
    if (player.hand.length === 0) {
      room.winner = player.name;
      room.state = 'finished';
      room.message = `${player.name} wins! 🎉`;
      recordWin(player.name);
      broadcast(room);
      return;
    }
    
    room.message = `${player.name} played ${card.value === 'wild' ? 'wild' : card.value === 'swap' ? 'SWAP' : card.value}${card.type === 'wild' && card.value !== 'swap' ? ' → ' + chosenColor : ''}${card.value === 'swap' ? ' → ' + chosenColor + swapMessage : ''}`;
    
    advanceTurn(room, 1);
    if (penalty > 0) {
      drawCards(room, room.currentPlayer, penalty);
      room.message += ` · ${room.players[room.currentPlayer].name} draws ${penalty}!`;
      advanceTurn(room, 1);
    } else if (skip === 2) {
      advanceTurn(room, 1);
    }
    
    broadcast(room);
  });

  socket.on('drawCard', ({ code }) => {
    const room = rooms[code];
    if (!room || room.state !== 'playing') return;
    const playerIdx = room.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== room.currentPlayer) return;
    
    drawCards(room, playerIdx, 1);
    room.message = `${room.players[playerIdx].name} drew a card.`;
    advanceTurn(room, 1);
    broadcast(room);
  });

  socket.on('sendChat', ({ code, text }) => {
    const room = rooms[code];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const msg = String(text || '').trim().slice(0, 200);
    if (!msg) return;
    room.chat.push({ from: player.name, text: msg, time: Date.now() });
    broadcast(room);
  });

  socket.on('restartGame', ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    startGame(room);
    broadcast(room);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    for (const code in rooms) {
      const room = rooms[code];
      const player = room.players.find(p => p.id === socket.id);
      if (!player) continue;
      
      if (room.state === 'waiting') {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          delete rooms[code];
        } else {
          if (room.hostId === socket.id) room.hostId = room.players[0].id;
          broadcast(room);
        }
      } else {
        player.connected = false;
        room.message = `${player.name} disconnected.`;
        broadcast(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`UNO server running on port ${PORT}`);
});
