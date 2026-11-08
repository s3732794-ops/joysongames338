const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const registeredUsers = {}; // email -> { email, username, customCharacters: [] }
let globalPlayerCounter = 1;
const reservedEmojis = new Set(['👷', '🦈', '👨', '🔫', '🏹']);
const activeServers = {};
let serverAutoIndex = 1;

io.on('connection', (socket) => {
  const playerNum = String(globalPlayerCounter++).padStart(4, '0');
  socket.username = `Игрок ${playerNum}`;
  socket.userEmail = null;
  socket.currentRoom = null;
  socket.customCharacters = [];

  socket.emit('init_player', {
    username: socket.username,
    reservedEmojis: Array.from(reservedEmojis)
  });

  // Регистрация / вход по почте с сохранением аккаунта
  socket.on('auth_login', (email) => {
    if (!email || !email.trim().toLowerCase().endsWith('@gmail.com')) {
      return socket.emit('auth_error', 'Ошибка! Введите настоящую почту с окончанием @gmail.com');
    }
    const cleanEmail = email.trim().toLowerCase();
    const defaultUname = cleanEmail.split('@')[0];

    if (!registeredUsers[cleanEmail]) {
      registeredUsers[cleanEmail] = {
        email: cleanEmail,
        username: defaultUname,
        customCharacters: []
      };
    }

    socket.userEmail = cleanEmail;
    socket.username = registeredUsers[cleanEmail].username;
    socket.customCharacters = registeredUsers[cleanEmail].customCharacters;

    socket.emit('auth_success', {
      username: socket.username,
      email: cleanEmail,
      customCharacters: socket.customCharacters
    });
  });

  // Смена ника (сохраняется в аккаунт, если пользователь зарегистрирован)
  socket.on('change_username', (newName) => {
    if (newName && newName.trim().length > 0) {
      socket.username = newName.trim().slice(0, 20);
      if (socket.userEmail && registeredUsers[socket.userEmail]) {
        registeredUsers[socket.userEmail].username = socket.username;
      }
      socket.emit('username_updated', socket.username);
    }
  });

  // Создание персонажа (сохраняется в аккаунт только после регистрации)
  socket.on('create_character', (charData) => {
    if (reservedEmojis.has(charData.emoji)) {
      return socket.emit('char_error', 'Этот эмодзи уже занят стандартным персонажем!');
    }
    reservedEmojis.add(charData.emoji);

    if (socket.userEmail && registeredUsers[socket.userEmail]) {
      registeredUsers[socket.userEmail].customCharacters.push(charData);
    } else {
      socket.customCharacters.push(charData);
    }

    socket.emit('my_character_created', charData);
    socket.broadcast.emit('register_reserved_emoji', charData.emoji);
  });

  socket.on('get_servers', () => sendServerList(socket));

  socket.on('create_room', ({ name, maxPlayers }) => {
    if (Object.keys(activeServers).length >= 12) {
      return socket.emit('error_msg', 'Ошибка: Все 12 серверов уже созданы!');
    }
    const roomId = 'room_' + Date.now();
    const roomName = name.trim() || `server ${String(serverAutoIndex++).padStart(4, '0')}`;
    const limit = Math.min(Math.max(parseInt(maxPlayers) || 10, 2), 50);

    activeServers[roomId] = { id: roomId, name: roomName, maxPlayers: limit, players: {}, blocks: [] };
    joinRoom(socket, roomId);
  });

  socket.on('quick_search', () => {
    let foundRoomId = Object.keys(activeServers).find(id => {
      const room = activeServers[id];
      return Object.keys(room.players).length < room.maxPlayers;
    });

    if (!foundRoomId) {
      if (Object.keys(activeServers).length >= 12) {
        return socket.emit('error_msg', 'Все сервера сейчас заняты!');
      }
      foundRoomId = 'room_' + Date.now();
      const roomName = `server ${String(serverAutoIndex++).padStart(4, '0')}`;
      activeServers[foundRoomId] = { id: foundRoomId, name: roomName, maxPlayers: 50, players: {}, blocks: [] };
    }
    joinRoom(socket, foundRoomId);
  });

  socket.on('join_room', (roomId) => {
    if (activeServers[roomId]) joinRoom(socket, roomId);
    else socket.emit('error_msg', 'Сервер не найден');
  });

  socket.on('player_update', (data) => {
    const room = activeServers[socket.currentRoom];
    if (room && room.players[socket.id]) {
      Object.assign(room.players[socket.id], data);
      socket.to(socket.currentRoom).emit('player_moved', { id: socket.id, ...data });
    }
  });

  // Нанесение PvP урона и обработка смерти (респавн на 0,0)
  socket.on('deal_player_damage', ({ targetId, damage }) => {
    const room = activeServers[socket.currentRoom];
    if (room && room.players[targetId]) {
      const target = room.players[targetId];
      if (target.pvp) {
        target.hp = Math.max(0, target.hp - damage);
        if (target.hp <= 0) {
          target.hp = target.maxHp;
          target.x = 0; // Точка респавна по X
          target.y = 0; // Точка респавна по Y
          io.to(socket.currentRoom).emit('player_respawned', { id: targetId, hp: target.hp, x: target.x, y: target.y });
        } else {
          io.to(socket.currentRoom).emit('player_hp_sync', { id: targetId, hp: target.hp });
        }
      }
    }
  });

  socket.on('spawn_block', (block) => {
    const room = activeServers[socket.currentRoom];
    if (room) {
      room.blocks.push(block);
      io.to(socket.currentRoom).emit('block_spawned', block);
    }
  });

  socket.on('block_damage', ({ blockIndex, damage }) => {
    const room = activeServers[socket.currentRoom];
    if (room && room.blocks[blockIndex]) {
      room.blocks[blockIndex].hp -= damage;
      if (room.blocks[blockIndex].hp <= 0) room.blocks.splice(blockIndex, 1);
      io.to(socket.currentRoom).emit('sync_blocks', room.blocks);
    }
  });

  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

function joinRoom(socket, roomId) {
  leaveCurrentRoom(socket);
  const room = activeServers[roomId];
  if (!room) return;
  if (Object.keys(room.players).length >= room.maxPlayers) return socket.emit('error_msg', 'Сервер полон!');

  socket.join(roomId);
  socket.currentRoom = roomId;
  room.players[socket.id] = {
    id: socket.id,
    username: socket.username,
    x: 0,
    y: 0,
    hp: 1000,
    maxHp: 1000,
    pvp: true,
    char: null
  };

  socket.emit('joined_room_success', { roomId: room.id, roomName: room.name, blocks: room.blocks, players: room.players });
  socket.to(roomId).emit('player_joined', room.players[socket.id]);
  io.emit('server_list_updated');
}

function leaveCurrentRoom(socket) {
  if (socket.currentRoom && activeServers[socket.currentRoom]) {
    const room = activeServers[socket.currentRoom];
    delete room.players[socket.id];
    socket.to(socket.currentRoom).emit('player_left', socket.id);
    if (Object.keys(room.players).length === 0) delete activeServers[socket.currentRoom];
    socket.leave(socket.currentRoom);
    socket.currentRoom = null;
    io.emit('server_list_updated');
  }
}

function sendServerList(socket) {
  const list = Object.values(activeServers).map(r => ({
    id: r.id, name: r.name, currentPlayers: Object.keys(r.players).length, maxPlayers: r.maxPlayers
  })).slice(0, 12);
  socket.emit('server_list', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));