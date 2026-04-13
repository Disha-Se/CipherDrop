const path = require("path");
const crypto = require("crypto");
const os = require("os");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function getLocalAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.internal) {
        continue;
      }

      if (entry.family === "IPv4") {
        addresses.push(entry.address);
      }
    }
  }

  return addresses;
}

app.get("/api/network-info", (_req, res) => {
  const addresses = getLocalAddresses();
  res.json({
    addresses,
    preferredHost: addresses[0] || "localhost",
    port: Number(process.env.PORT || 3000),
  });
});

function hashPassword(password) {
  return crypto.scryptSync(password, "p2p-share-room-salt", 32);
}

function comparePasswords(password, expectedHash) {
  const actualHash = hashPassword(password);
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function getOrCreateRoom(roomId, password) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      passwordHash: hashPassword(password),
      members: new Set(),
    });
  }

  return rooms.get(roomId);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  if (room.members.size === 0) {
    rooms.delete(roomId);
  }
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, password, displayName }, callback = () => {}) => {
    const normalizedRoomId = String(roomId || "").trim();
    const normalizedPassword = String(password || "");
    const normalizedName = String(displayName || "Anonymous").trim().slice(0, 32) || "Anonymous";

    if (!normalizedRoomId || !normalizedPassword) {
      callback({ ok: false, message: "Room ID and password are required." });
      return;
    }

    const existingRoom = getRoom(normalizedRoomId);
    if (existingRoom && !comparePasswords(normalizedPassword, existingRoom.passwordHash)) {
      callback({ ok: false, message: "Incorrect room password." });
      return;
    }

    const room = getOrCreateRoom(normalizedRoomId, normalizedPassword);
    const existingPeers = Array.from(room.members)
      .filter((memberId) => memberId !== socket.id)
      .map((memberId) => {
        const peerSocket = io.sockets.sockets.get(memberId);
        return {
          id: memberId,
          name: peerSocket?.data?.displayName || "Peer",
        };
      });

    socket.join(normalizedRoomId);
    socket.data.roomId = normalizedRoomId;
    socket.data.displayName = normalizedName;
    room.members.add(socket.id);

    callback({
      ok: true,
      selfId: socket.id,
      peers: existingPeers,
    });

    socket.to(normalizedRoomId).emit("peer-joined", {
      id: socket.id,
      name: normalizedName,
    });
  });

  socket.on("signal", ({ target, payload }) => {
    if (!target || !payload) {
      return;
    }

    io.to(target).emit("signal", {
      from: socket.id,
      payload,
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId) {
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      return;
    }

    room.members.delete(socket.id);
    socket.to(roomId).emit("peer-left", {
      id: socket.id,
      name: socket.data.displayName || "Peer",
    });
    cleanupRoom(roomId);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Secure P2P share app running on http://localhost:${PORT}`);
  const addresses = getLocalAddresses();
  if (addresses.length) {
    console.log(`LAN access: ${addresses.map((address) => `http://${address}:${PORT}`).join(", ")}`);
  }
});
