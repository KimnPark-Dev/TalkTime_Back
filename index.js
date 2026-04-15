const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── 인메모리 상태 ──────────────────────────────────────────
const rooms = {};          // roomId -> RoomState
const socketToUser = {};   // socketId -> { userId, roomId }
const exchangeDecisions  = {}; // conversationId -> { [userId]: 'accept'|'reject' }
const conversationTypes  = {}; // conversationId -> 'coffee' | 'cigarette'

// instagramId 는 클라이언트에 절대 노출하지 않음
function publicPlayer(p) {
  const { instagramId, socketId, ...pub } = p; // eslint-disable-line no-unused-vars
  return pub;
}

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      id: roomId,
      players: {},
      chatBuffer: [],
      conversations: {},
    };
  }
  return rooms[roomId];
}

function uid() {
  return 'u_' + Math.random().toString(36).slice(2, 10);
}

// ── 허브 정의 ─────────────────────────────────────────────
const HUBS = [
  { id: 'hub-gbd',    name: '강남·테헤란로',     lat: 37.5007, lng: 127.0368, radiusKm: 1.5 },
  { id: 'hub-cbd',    name: '광화문·종로·을지로', lat: 37.5720, lng: 126.9785, radiusKm: 2.0 },
  { id: 'hub-ybd',    name: '여의도·영등포',      lat: 37.5263, lng: 126.9244, radiusKm: 1.5 },
  { id: 'hub-seocho', name: '서초·교대·양재',     lat: 37.4836, lng: 127.0325, radiusKm: 1.5 },
  { id: 'hub-gdi',    name: '구로·가산 디지털단지', lat: 37.4831, lng: 126.8920, radiusKm: 1.5 },
];

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GPS 좌표 → 허브 room ID
// 여러 허브 반경이 겹칠 경우 더 가까운 허브로 배정
function assignHub(location) {
  if (!location || location.lat == null) return 'hub-general';
  let nearest = null;
  let minDist = Infinity;
  for (const hub of HUBS) {
    const dist = haversineKm(location.lat, location.lng, hub.lat, hub.lng);
    if (dist <= hub.radiusKm && dist < minDist) {
      minDist = dist;
      nearest = hub.id;
    }
  }
  return nearest ?? 'hub-general';
}

// 스폰 위치 (2D 월드 중앙 부근)
function spawnPosition() {
  // 좁은 범위 스폰 → 처음부터 서로 가까이 배치 (±60px)
  return {
    x: 1000 + (Math.random() - 0.5) * 120,
    y: 820  + (Math.random() - 0.5) * 120,
  };
}

// ── 소켓 이벤트 ───────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // ── join_room ──
  socket.on('join_room', ({ roomId, profile, gpsLocation }) => {
    const resolvedRoomId = roomId || assignHub(gpsLocation);
    const room = getOrCreateRoom(resolvedRoomId);
    const userId = uid();
    const pos = spawnPosition();

    const player = {
      userId,
      socketId:    socket.id,
      gender:      profile.gender,
      instagramId: profile.instagramId,           // 서버에만 보관
      displayName: profile.nickname || profile.instagramId, // 공개 닉네임
      x: pos.x, y: pos.y, direction: 'down',
      gpsLocation: gpsLocation || null,
    };

    room.players[userId] = player;
    socketToUser[socket.id] = { userId, roomId: resolvedRoomId };
    socket.join(resolvedRoomId);

    // 본인에게 스냅샷 (instagramId 제외)
    const hubMeta = HUBS.find(h => h.id === resolvedRoomId) ?? { name: '서울 공통' };
    socket.emit('room_snapshot', {
      roomId:    resolvedRoomId,
      hubName:   hubMeta.name,
      myUserId:  userId,
      players:   Object.values(room.players).map(publicPlayer),
      chatBuffer: room.chatBuffer.slice(-50),
    });

    // 나머지에게 입장 알림 (instagramId 제외)
    socket.to(resolvedRoomId).emit('user_joined', { player: publicPlayer(player) });

    console.log(`[join] ${userId} (닉네임: ${player.displayName}) → room ${resolvedRoomId}`);
  });

  // ── move ──
  socket.on('move', ({ x, y, direction }) => {
    const meta = socketToUser[socket.id];
    if (!meta) return;
    const room = rooms[meta.roomId];
    if (!room) return;
    const player = room.players[meta.userId];
    if (!player) return;

    // 순간이동 방지 (프레임당 최대 25px 이동)
    const dx = Math.abs(x - player.x);
    const dy = Math.abs(y - player.y);
    if (dx > 25 || dy > 25) {
      socket.emit('state_correction', { x: player.x, y: player.y });
      return;
    }

    player.x = x;
    player.y = y;
    player.direction = direction;

    socket.to(meta.roomId).emit('user_moved', {
      userId: meta.userId,
      x, y, direction,
    });
  });

  // ── chat ──
  socket.on('chat', ({ message }) => {
    const meta = socketToUser[socket.id];
    if (!meta) return;
    const room = rooms[meta.roomId];
    if (!room) return;
    const player = room.players[meta.userId];
    if (!player) return;

    const msg = {
      id: `${Date.now()}-${Math.random()}`,
      userId: meta.userId,
      displayName: player.displayName,
      message: String(message).slice(0, 200),
      timestamp: Date.now(),
    };

    room.chatBuffer.push(msg);
    if (room.chatBuffer.length > 100) room.chatBuffer.shift();

    io.to(meta.roomId).emit('chat_message', msg);
  });

  // ── conversation_request ──
  socket.on('conversation_request', ({ targetUserId, type }) => {
    const meta = socketToUser[socket.id];
    if (!meta) return;
    const room = rooms[meta.roomId];
    if (!room) return;

    const initiator = room.players[meta.userId];
    const target = room.players[targetUserId];
    if (!initiator || !target) return;

    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (!targetSocket) return;

    const conversationId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    // 타입 저장 (conversation_started 때 양측에 전달)
    conversationTypes[conversationId] = type;
    setTimeout(() => delete conversationTypes[conversationId], 120000); // 2분 후 정리

    targetSocket.emit('conversation_incoming', {
      conversationId,
      initiatorId: meta.userId,
      initiatorName: initiator.displayName,
      type,
    });

    console.log(`[conv_req] ${initiator.displayName} → ${target.displayName} (${type})`);
  });

  // ── conversation_response ──
  socket.on('conversation_response', ({ conversationId, initiatorId, accepted }) => {
    const meta = socketToUser[socket.id];
    if (!meta) return;
    const room = rooms[meta.roomId];
    if (!room) return;

    const initiator = room.players[initiatorId];
    const responder = room.players[meta.userId];
    if (!initiator || !responder) return;

    const initiatorSocket = io.sockets.sockets.get(initiator.socketId);

    if (!accepted) {
      if (initiatorSocket) {
        initiatorSocket.emit('conversation_rejected', {
          conversationId,
          targetName: responder.displayName,
        });
      }
      return;
    }

    // 대화 시작
    const startTime = Date.now();
    room.conversations[conversationId] = {
      conversationId,
      initiatorId,
      targetId: meta.userId,
      startTime,
    };

    const convType = conversationTypes[conversationId] || 'coffee';
    const baseData = { conversationId, duration: 30, startTime, convType };

    // partnerInstagram 은 절대 포함하지 않음 — 교환 수락 후 채팅으로만 공개
    if (initiatorSocket) {
      initiatorSocket.emit('conversation_started', {
        ...baseData,
        partnerId:   meta.userId,
        partnerName: responder.displayName,
      });
    }

    socket.emit('conversation_started', {
      ...baseData,
      partnerId:   initiatorId,
      partnerName: initiator.displayName,
    });

    console.log(`[conv_start] ${initiator.displayName} ↔ ${responder.displayName}`);

    // 30초 후 자동 종료
    setTimeout(() => {
      const conv = room.conversations[conversationId];
      if (!conv) return;

      const p1 = room.players[conv.initiatorId];
      const p2 = room.players[conv.targetId];

      [p1, p2].forEach(p => {
        if (p) {
          const s = io.sockets.sockets.get(p.socketId);
          if (s) s.emit('conversation_ended', { conversationId });
        }
      });

      delete room.conversations[conversationId];
      console.log(`[conv_end] ${conversationId}`);
    }, 30000);
  });

  // ── private_message ──
  socket.on('private_message', ({ recipientId, message }) => {
    const meta = socketToUser[socket.id];
    if (!meta) return;
    const room = rooms[meta.roomId];
    if (!room) return;
    const sender    = room.players[meta.userId];
    const recipient = room.players[recipientId];
    if (!sender || !recipient) return;

    const msg = {
      id: `pm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      senderId:   meta.userId,
      senderName: sender.displayName,
      message:    String(message).slice(0, 200),
      timestamp:  Date.now(),
    };

    // 본인 echo + 상대 전달
    socket.emit('private_message', msg);
    const recipientSocket = io.sockets.sockets.get(recipient.socketId);
    if (recipientSocket) recipientSocket.emit('private_message', msg);
  });

  // ── instagram_exchange_decision ──
  socket.on('instagram_exchange_decision', ({ conversationId, partnerId, decision }) => {
    const meta = socketToUser[socket.id];
    if (!meta) return;
    const room = rooms[meta.roomId];
    if (!room) return;

    if (!exchangeDecisions[conversationId]) {
      exchangeDecisions[conversationId] = {};
      // 30초 후 정리
      setTimeout(() => { delete exchangeDecisions[conversationId]; }, 30000);
    }

    exchangeDecisions[conversationId][meta.userId] = decision;

    const partnerDecision = exchangeDecisions[conversationId][partnerId];

    if (partnerDecision !== undefined) {
      // 양측 모두 결정
      if (decision === 'accept' && partnerDecision === 'accept') {
        const me = room.players[meta.userId];
        const partner = room.players[partnerId];
        if (me && partner) {
          const partnerSocket = io.sockets.sockets.get(partner.socketId);
          const ts = Date.now();

          socket.emit('chat_message', {
            id: `sys_${ts}_1`,
            userId: 'system',
            displayName: '💌 매칭',
            message: `${partner.displayName}님의 인스타그램: @${partner.instagramId}`,
            isSystem: true,
            timestamp: ts,
          });

          if (partnerSocket) {
            partnerSocket.emit('chat_message', {
              id: `sys_${ts}_2`,
              userId: 'system',
              displayName: '💌 매칭',
              message: `${me.displayName}님의 인스타그램: @${me.instagramId}`,
              isSystem: true,
              timestamp: ts,
            });
          }
          console.log(`[instagram_exchange] ${me.displayName} ↔ ${partner.displayName}`);
        }
      }
      delete exchangeDecisions[conversationId];
    }
  });

  // ── disconnect ──
  socket.on('disconnect', () => {
    const meta = socketToUser[socket.id];
    if (!meta) return;

    const room = rooms[meta.roomId];
    if (room) {
      delete room.players[meta.userId];
      io.to(meta.roomId).emit('user_left', { userId: meta.userId });

      if (Object.keys(room.players).length === 0) {
        delete rooms[meta.roomId];
      }
    }

    delete socketToUser[socket.id];
    console.log(`[disconnect] ${socket.id}`);
  });
});

// ── 헬스체크 ──────────────────────────────────────────────
app.get('/health', (_, res) => {
  const roomCount = Object.keys(rooms).length;
  const playerCount = Object.values(rooms).reduce(
    (sum, r) => sum + Object.keys(r.players).length, 0
  );
  res.json({ status: 'ok', rooms: roomCount, players: playerCount });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`TalkTime server listening on http://localhost:${PORT}`);
});
