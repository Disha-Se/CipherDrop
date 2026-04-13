const socket = window.io ? io({ transports: ["websocket", "polling"] }) : null;

const CHUNK_SIZE = 32 * 1024;
const HISTORY_KEY = "cipherdrop-history-v1";
const STUN_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const textEncoder = new TextEncoder();
const webCrypto = window.crypto || window.msCrypto || null;

const elements = {
  roomId: document.getElementById("roomId"),
  password: document.getElementById("password"),
  displayName: document.getElementById("displayName"),
  joinBtn: document.getElementById("joinBtn"),
  copyInviteBtn: document.getElementById("copyInviteBtn"),
  sendBtn: document.getElementById("sendBtn"),
  fileInput: document.getElementById("fileInput"),
  sessionStatus: document.getElementById("sessionStatus"),
  cryptoStatus: document.getElementById("cryptoStatus"),
  qrWrapper: document.getElementById("qrWrapper"),
  inviteLink: document.getElementById("inviteLink"),
  peerList: document.getElementById("peerList"),
  peerCount: document.getElementById("peerCount"),
  recipientList: document.getElementById("recipientList"),
  recipientSummary: document.getElementById("recipientSummary"),
  previewGrid: document.getElementById("previewGrid"),
  transferList: document.getElementById("transferList"),
  transferSummary: document.getElementById("transferSummary"),
  receivedList: document.getElementById("receivedList"),
  historyList: document.getElementById("historyList"),
  clearHistoryBtn: document.getElementById("clearHistoryBtn"),
};

const state = {
  roomId: "",
  password: "",
  displayName: "",
  roomKey: null,
  inviteUrl: "",
  networkInfo: null,
  selectedFiles: [],
  selectedPeerIds: new Set(),
  peers: new Map(),
  transferCards: new Map(),
  transferCleanupTimers: new Map(),
  outgoingTransfers: new Map(),
  incomingTransfers: new Map(),
  history: loadHistory(),
};

hydrateFieldsFromUrl();
renderHistory();
renderPreviewQueue();
renderPeers();
renderRecipientList();
renderTransferSummary();
initializeSocketState();
loadNetworkInfo();

elements.joinBtn.addEventListener("click", joinRoom);
elements.copyInviteBtn.addEventListener("click", copyInviteLink);
elements.fileInput.addEventListener("change", handleFileSelection);
elements.sendBtn.addEventListener("click", sendSelectedFiles);
elements.clearHistoryBtn.addEventListener("click", clearHistory);

if (socket) {
  socket.on("peer-joined", async (peer) => {
    await ensurePeerConnection(peer.id, peer.name, true);
    renderPeers();
  });

  socket.on("peer-left", ({ id }) => {
    teardownPeer(id);
    renderPeers();
  });

  socket.on("signal", async ({ from, payload }) => {
    const peer = await ensurePeerConnection(from, null, false);

    if (payload.type === "offer") {
      await peer.pc.setRemoteDescription(payload);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit("signal", { target: from, payload: peer.pc.localDescription });
      return;
    }

    if (payload.type === "answer") {
      await peer.pc.setRemoteDescription(payload);
      return;
    }

    if (payload.type === "candidate" && payload.candidate) {
      try {
        await peer.pc.addIceCandidate(payload.candidate);
      } catch (error) {
        console.error("ICE candidate error", error);
      }
    }
  });
}

function initializeSocketState() {
  if (!socket) {
    setSessionStatus("Open the app from http://localhost:3000, not as a local file.", "error");
    elements.cryptoStatus.textContent = "Socket.IO client not loaded";
    return;
  }

  if (socket.connected) {
    setSessionStatus("Signaling server ready", "idle");
  } else {
    setSessionStatus("Connecting to signaling server...", "idle");
  }

  socket.on("connect", () => {
    setSessionStatus("Signaling server ready", "idle");
    elements.cryptoStatus.textContent = "Waiting for room key";
    loadNetworkInfo();
  });

  socket.on("disconnect", () => {
    setSessionStatus("Disconnected from signaling server", "error");
    elements.cryptoStatus.textContent = "Reconnect the local server to continue";
    updateActionState();
  });

  socket.on("connect_error", () => {
    setSessionStatus("Server offline. Run node server.js and open localhost:3000.", "error");
    elements.cryptoStatus.textContent = "Signaling server unavailable";
  });
}

function hasNativeCryptoSuite() {
  return Boolean(webCrypto?.subtle && webCrypto?.getRandomValues);
}

async function joinRoom() {
  if (!socket) {
    setSessionStatus("Socket.IO is missing. Open the app via http://localhost:3000.", "error");
    return;
  }

  if (!socket.connected) {
    setSessionStatus("Server offline. Run node server.js and refresh localhost:3000.", "error");
    return;
  }

  const roomId = elements.roomId.value.trim();
  const password = elements.password.value;
  const displayName = elements.displayName.value.trim() || "Analyst";

  if (!roomId || !password) {
    setSessionStatus("Room ID and password are required.", "error");
    return;
  }

  try {
    state.roomId = roomId;
    state.password = password;
    state.displayName = displayName;
    state.roomKey = await deriveRoomKey(password, roomId);
    elements.cryptoStatus.textContent = hasNativeCryptoSuite()
      ? "Room key derived with Web Crypto PBKDF2"
      : "Room key derived with Forge PBKDF2 fallback";

    setSessionStatus("Joining secure session...", "idle");

    socket.timeout(5000).emit("join-room", { roomId, password, displayName }, async (error, response) => {
      if (error) {
        setSessionStatus("Join request timed out. Check that node server.js is running.", "error");
        return;
      }

      if (!response?.ok) {
        setSessionStatus(response?.message || "Unable to join room.", "error");
        return;
      }

      setSessionStatus(`Connected to ${roomId}`, "live");
      buildInviteUrl();
      renderQrCode();
      elements.copyInviteBtn.disabled = false;
      updateUrlParams();

      for (const peer of response.peers) {
        await ensurePeerConnection(peer.id, peer.name, false);
      }

      renderPeers();
      updateActionState();
    });
  } catch (error) {
    console.error(error);
    setSessionStatus("Unable to derive session key.", "error");
  }
}

function setSessionStatus(message, tone) {
  elements.sessionStatus.textContent = message;
  elements.sessionStatus.className = `status-pill ${tone === "error" ? "status-error" : tone === "live" ? "status-live" : "status-idle"}`;
}

function updateActionState() {
  const connectedPeers = getConnectedPeerIds();
  const activeTargets = getSelectedPeerIds();
  elements.sendBtn.disabled = !(state.roomKey && state.selectedFiles.length && connectedPeers.length && activeTargets.length);
  elements.recipientSummary.textContent = activeTargets.length
    ? `${activeTargets.length} peer${activeTargets.length === 1 ? "" : "s"} selected`
    : "No peer selected";
}

function buildInviteUrl() {
  const preferredHost = state.networkInfo?.preferredHost;
  const port = state.networkInfo?.port || window.location.port || "3000";
  const origin = preferredHost
    ? `${window.location.protocol}//${preferredHost}:${port}`
    : window.location.origin;
  const url = new URL(origin);
  url.searchParams.set("room", state.roomId);
  url.searchParams.set("password", state.password);
  url.searchParams.set("name", state.displayName);
  state.inviteUrl = url.toString();
  elements.inviteLink.textContent = state.inviteUrl;
}

function updateUrlParams() {
  const url = new URL(window.location.href);
  url.searchParams.set("room", state.roomId);
  url.searchParams.set("password", state.password);
  url.searchParams.set("name", state.displayName);
  window.history.replaceState({}, "", url);
}

async function loadNetworkInfo() {
  if (!socket) {
    return;
  }

  try {
    const response = await fetch("/api/network-info");
    if (!response.ok) {
      return;
    }

    state.networkInfo = await response.json();
  } catch (error) {
    console.error("Unable to load network info", error);
  }
}

function hydrateFieldsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  elements.roomId.value = params.get("room") || `cyber-${Math.random().toString(36).slice(2, 8)}`;
  elements.password.value = params.get("password") || "";
  elements.displayName.value = params.get("name") || `Peer-${Math.floor(Math.random() * 90 + 10)}`;
}

function renderQrCode() {
  if (!state.inviteUrl || !window.QRCode) {
    return;
  }

  elements.qrWrapper.classList.remove("empty");
  elements.qrWrapper.innerHTML = "";
  QRCode.toCanvas(state.inviteUrl, { width: 180, margin: 1 }, (error, canvas) => {
    if (error) {
      elements.qrWrapper.classList.add("empty");
      elements.qrWrapper.textContent = "QR generation failed.";
      return;
    }

    elements.qrWrapper.appendChild(canvas);
  });
}

async function copyInviteLink() {
  if (!state.inviteUrl) {
    return;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(state.inviteUrl);
    } else {
      copyTextFallback(state.inviteUrl);
    }

    elements.copyInviteBtn.textContent = "Copied";
    setSessionStatus("Invite link copied.", "idle");
  } catch (error) {
    try {
      copyTextFallback(state.inviteUrl);
      elements.copyInviteBtn.textContent = "Copied";
      setSessionStatus("Invite link copied.", "idle");
    } catch (fallbackError) {
      console.error("Copy invite failed", error, fallbackError);
      elements.copyInviteBtn.textContent = "Copy Failed";
      setSessionStatus("Copy failed. Use the visible invite link manually.", "error");
    }
  }

  setTimeout(() => {
    elements.copyInviteBtn.textContent = "Copy Invite";
  }, 1200);
}

async function ensurePeerConnection(peerId, name, shouldOffer) {
  if (state.peers.has(peerId)) {
    const existing = state.peers.get(peerId);
    if (name && name !== "Peer") {
      existing.name = name;
    }
    return existing;
  }

  const pc = new RTCPeerConnection(STUN_CONFIG);
  const peer = {
    id: peerId,
    name: name && name !== "Peer" ? name : "Peer",
    pc,
    channel: null,
    connected: false,
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("signal", {
        target: peerId,
        payload: { type: "candidate", candidate: event.candidate },
      });
    }
  };

  pc.onconnectionstatechange = () => {
    peer.connected = ["connected", "completed"].includes(pc.connectionState);
    renderPeers();
    renderRecipientList();
    updateActionState();

    if (peer.connected && peer.channel?.readyState === "open") {
      syncPendingTransfers(peer.id);
    }
  };

  pc.ondatachannel = (event) => {
    setupDataChannel(peer, event.channel);
  };

  state.peers.set(peerId, peer);

  if (shouldOffer) {
    const channel = pc.createDataChannel("secure-files");
    setupDataChannel(peer, channel);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("signal", { target: peerId, payload: pc.localDescription });
  }

  return peer;
}

function setupDataChannel(peer, channel) {
  peer.channel = channel;

  channel.onopen = () => {
    peer.connected = true;
    renderPeers();
    renderRecipientList();
    updateActionState();
    syncPendingTransfers(peer.id);
  };

  channel.onclose = () => {
    peer.connected = false;
    renderPeers();
    renderRecipientList();
    updateActionState();
  };

  channel.onerror = (error) => {
    console.error("Data channel error", error);
  };

  channel.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      await handlePeerMessage(peer.id, message);
    } catch (error) {
      console.error("Message handling failed", error);
    }
  };
}

async function handlePeerMessage(peerId, message) {
  switch (message.type) {
    case "sync-outgoing":
      for (const meta of message.transfers) {
        registerIncomingTransfer(peerId, meta);
        const incoming = state.incomingTransfers.get(meta.transferId);
        sendPeerMessage(peerId, {
          type: "resume-request",
          transferId: meta.transferId,
          nextChunk: incoming.receivedIndexes.size,
        });
      }
      break;
    case "transfer-meta":
      registerIncomingTransfer(peerId, message.meta);
      sendPeerMessage(peerId, {
        type: "resume-request",
        transferId: message.meta.transferId,
        nextChunk: state.incomingTransfers.get(message.meta.transferId).receivedIndexes.size,
      });
      break;
    case "resume-request":
      await resumeOutgoingTransfer(peerId, message.transferId, message.nextChunk);
      break;
    case "transfer-chunk":
      await receiveChunk(peerId, message);
      break;
    case "ack":
      updateOutgoingProgress(message.transferId, message.index + 1);
      break;
    case "transfer-complete":
      {
        const transfer = state.incomingTransfers.get(message.transferId);
        if (transfer) {
          transfer.senderFinished = true;
        }
        await finalizeIncomingTransfer(message.transferId);
      }
      break;
    default:
      break;
  }
}

function sendPeerMessage(peerId, payload) {
  const peer = state.peers.get(peerId);
  if (!peer?.channel || peer.channel.readyState !== "open") {
    return false;
  }

  peer.channel.send(JSON.stringify(payload));
  return true;
}

function handleFileSelection(event) {
  state.selectedFiles = Array.from(event.target.files || []);
  renderPreviewQueue();
  updateActionState();
}

function renderPreviewQueue() {
  if (!state.selectedFiles.length) {
    elements.previewGrid.innerHTML = '<p class="placeholder">Choose one or more files to preview them here.</p>';
    return;
  }

  elements.previewGrid.innerHTML = "";
  for (const file of state.selectedFiles) {
    const card = document.createElement("article");
    card.className = "preview-card";

    const mediaNode = createPreviewMedia(file);
    card.appendChild(mediaNode);

    const meta = document.createElement("div");
    meta.className = "preview-meta";
    meta.innerHTML = `<strong>${escapeHtml(file.name)}</strong><span>${formatBytes(file.size)} - ${file.type || "Unknown type"}</span>`;
    card.appendChild(meta);

    elements.previewGrid.appendChild(card);
  }
}

function createPreviewMedia(file) {
  const url = URL.createObjectURL(file);

  if (file.type.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = file.name;
    img.className = "preview-media";
    return img;
  }

  if (file.type.startsWith("video/")) {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.className = "preview-media";
    return video;
  }

  const fallback = document.createElement("div");
  fallback.className = "preview-media";
  fallback.style.display = "grid";
  fallback.style.placeItems = "center";
  fallback.textContent = "No inline preview";
  return fallback;
}

async function sendSelectedFiles() {
  const peerIds = getSelectedPeerIds();
  if (!peerIds.length || !state.selectedFiles.length || !state.roomKey) {
    elements.cryptoStatus.textContent = "Choose at least one connected peer before sending";
    return;
  }

  elements.cryptoStatus.textContent = "Encrypting files and streaming to peers";

  for (const file of state.selectedFiles) {
    const hash = await computeFileHash(file);

    for (const peerId of peerIds) {
      const transferId = createTransferId();
      const transfer = {
        transferId,
        fileName: file.name,
        fileType: file.type || "application/octet-stream",
        fileSize: file.size,
        hash,
        totalChunks: Math.ceil(file.size / CHUNK_SIZE),
        startedAt: new Date().toISOString(),
        direction: "outgoing",
        peerId,
        file,
        ackedIndexes: new Set(),
        completed: false,
        historyLogged: false,
      };

      state.outgoingTransfers.set(transferId, transfer);
      renderTransferCard(transferId, {
        title: `${file.name} to ${state.peers.get(peerId)?.name || "peer"}`,
        subtitle: `Encrypted upload - ${formatBytes(file.size)}`,
        progress: 0,
      });

      sendPeerMessage(peerId, {
        type: "transfer-meta",
        meta: {
          transferId,
          fileName: transfer.fileName,
          fileType: transfer.fileType,
          fileSize: transfer.fileSize,
          hash: transfer.hash,
          totalChunks: transfer.totalChunks,
          startedAt: transfer.startedAt,
        },
      });
    }
  }

  renderTransferSummary();
}

function syncPendingTransfers(peerId) {
  const pending = Array.from(state.outgoingTransfers.values())
    .filter((transfer) => !transfer.completed)
    .map((transfer) => ({
      transferId: transfer.transferId,
      fileName: transfer.fileName,
      fileType: transfer.fileType,
      fileSize: transfer.fileSize,
      hash: transfer.hash,
      totalChunks: transfer.totalChunks,
      startedAt: transfer.startedAt,
    }));

  if (pending.length) {
    sendPeerMessage(peerId, { type: "sync-outgoing", transfers: pending });
  }
}

async function resumeOutgoingTransfer(peerId, transferId, nextChunk) {
  const transfer = state.outgoingTransfers.get(transferId);
  if (!transfer) {
    return;
  }

  transfer.peerId = peerId;

  for (let index = nextChunk; index < transfer.totalChunks; index += 1) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, transfer.file.size);
    const chunkBuffer = await transfer.file.slice(start, end).arrayBuffer();
    const encryptedChunk = await encryptChunk(chunkBuffer);

    await waitForBufferedAmount(peerId);
    sendPeerMessage(peerId, {
      type: "transfer-chunk",
      transferId,
      index,
      iv: encryptedChunk.iv,
      data: encryptedChunk.data,
    });

    updateOutgoingProgress(transferId, index + 1, false);
  }

  sendPeerMessage(peerId, { type: "transfer-complete", transferId });
}

async function waitForBufferedAmount(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer?.channel) {
    return;
  }

  while (peer.channel.bufferedAmount > 2 * CHUNK_SIZE) {
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function registerIncomingTransfer(peerId, meta) {
  if (state.incomingTransfers.has(meta.transferId)) {
    return state.incomingTransfers.get(meta.transferId);
  }

  const transfer = {
    ...meta,
    peerId,
    chunks: new Array(meta.totalChunks),
    receivedIndexes: new Set(),
    completed: false,
    senderFinished: false,
  };

  state.incomingTransfers.set(meta.transferId, transfer);
  renderTransferCard(meta.transferId, {
    title: `${meta.fileName} from ${state.peers.get(peerId)?.name || "peer"}`,
    subtitle: `Receiving securely - ${formatBytes(meta.fileSize)}`,
    progress: 0,
  });
  return transfer;
}

async function receiveChunk(peerId, message) {
  const transfer = state.incomingTransfers.get(message.transferId);
  if (!transfer) {
    return;
  }

  const decrypted = await decryptChunk(message.data, message.iv);
  transfer.chunks[message.index] = decrypted;
  transfer.receivedIndexes.add(message.index);

  sendPeerMessage(peerId, {
    type: "ack",
    transferId: message.transferId,
    index: message.index,
  });

  const progress = (transfer.receivedIndexes.size / transfer.totalChunks) * 100;
  updateTransferCard(message.transferId, progress, `${transfer.receivedIndexes.size}/${transfer.totalChunks} chunks verified`);

  if (transfer.senderFinished && transfer.receivedIndexes.size === transfer.totalChunks) {
    await finalizeIncomingTransfer(message.transferId);
  }
}

function updateOutgoingProgress(transferId, count, acked = true) {
  const transfer = state.outgoingTransfers.get(transferId);
  if (!transfer) {
    return;
  }

  if (acked) {
    transfer.ackedIndexes.add(count - 1);
  }

  const baseline = acked ? transfer.ackedIndexes.size : count;
  const progress = (baseline / transfer.totalChunks) * 100;
  updateTransferCard(transferId, progress, `${Math.min(baseline, transfer.totalChunks)}/${transfer.totalChunks} chunks delivered`);

  if (acked && transfer.ackedIndexes.size === transfer.totalChunks && !transfer.historyLogged) {
    transfer.completed = true;
    transfer.historyLogged = true;
    addHistory({
      type: "Sent",
      fileName: transfer.fileName,
      peerName: state.peers.get(transfer.peerId)?.name || "Peer",
      detail: `${formatBytes(transfer.fileSize)} - AES-GCM encrypted`,
    });
    scheduleTransferRemoval(transferId);
  }
}

async function finalizeIncomingTransfer(transferId) {
  const transfer = state.incomingTransfers.get(transferId);
  if (!transfer || transfer.completed || !transfer.senderFinished || transfer.receivedIndexes.size !== transfer.totalChunks) {
    return;
  }

  const blob = new Blob(transfer.chunks, { type: transfer.fileType });
  const digest = await computeHashFromBlob(blob);
  const verified = digest === transfer.hash;

  updateTransferCard(
    transferId,
    100,
    verified ? "Integrity check passed (SHA-256)" : "Integrity check failed"
  );

  if (!verified) {
    addHistory({
      type: "Receive failed",
      fileName: transfer.fileName,
      peerName: state.peers.get(transfer.peerId)?.name || "Peer",
      detail: "Hash mismatch detected",
    });
    scheduleTransferRemoval(transferId, 1500);
    return;
  }

  transfer.completed = true;
  const url = URL.createObjectURL(blob);
  addReceivedFile(transfer, url);
  injectReceivedPreview(transferId, transfer, url);
  addHistory({
    type: "Received",
    fileName: transfer.fileName,
    peerName: state.peers.get(transfer.peerId)?.name || "Peer",
    detail: `${formatBytes(transfer.fileSize)} - SHA-256 verified`,
  });
  scheduleTransferRemoval(transferId, 1500);
}

function addReceivedFile(transfer, url) {
  if (elements.receivedList.querySelector(".placeholder")) {
    elements.receivedList.innerHTML = "";
  }

  const item = document.createElement("article");
  item.className = "received-item";

  if (transfer.fileType.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = transfer.fileName;
    img.className = "preview-media";
    item.appendChild(img);
  } else if (transfer.fileType.startsWith("video/")) {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.className = "preview-media";
    item.appendChild(video);
  }

  const footer = document.createElement("div");
  footer.className = "preview-meta";
  footer.innerHTML = `
    <strong>${escapeHtml(transfer.fileName)}</strong>
    <span>${formatBytes(transfer.fileSize)} - From ${escapeHtml(state.peers.get(transfer.peerId)?.name || "Peer")}</span>
    <span><a href="${url}" download="${escapeHtml(transfer.fileName)}">Download file</a></span>
  `;
  item.appendChild(footer);
  elements.receivedList.prepend(item);
}

function injectReceivedPreview(transferId, transfer, url) {
  const card = state.transferCards.get(transferId);
  if (!card) {
    return;
  }

  if (transfer.fileType.startsWith("image/")) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = transfer.fileName;
    img.className = "preview-media";
    card.appendChild(img);
  } else if (transfer.fileType.startsWith("video/")) {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.className = "preview-media";
    card.appendChild(video);
  }

  const footer = document.createElement("div");
  footer.className = "preview-meta";
  footer.innerHTML = `<strong>Verified download ready</strong><span><a href="${url}" download="${escapeHtml(transfer.fileName)}">Download ${escapeHtml(transfer.fileName)}</a></span>`;
  card.appendChild(footer);
}

function renderTransferCard(transferId, { title, subtitle, progress }) {
  if (elements.transferList.querySelector(".placeholder")) {
    elements.transferList.innerHTML = "";
  }

  const card = document.createElement("article");
  card.className = "transfer-card";
  card.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(subtitle)}</span>
    <div class="progress-track"><div class="progress-bar" style="width:${progress}%"></div></div>
    <small>0%</small>
  `;

  state.transferCards.set(transferId, card);
  elements.transferList.prepend(card);
}

function updateTransferCard(transferId, progress, detail) {
  const card = state.transferCards.get(transferId);
  if (!card) {
    return;
  }

  const bar = card.querySelector(".progress-bar");
  const label = card.querySelector("small");
  bar.style.width = `${Math.min(progress, 100)}%`;
  label.textContent = `${Math.round(progress)}% - ${detail}`;
  renderTransferSummary();
}

function renderTransferSummary() {
  const total = state.transferCards.size;
  elements.transferSummary.textContent = total ? `${total} tracked transfer${total === 1 ? "" : "s"}` : "No active transfers";
}

function scheduleTransferRemoval(transferId, delay = 4000) {
  if (state.transferCleanupTimers.has(transferId)) {
    return;
  }

  const timer = setTimeout(() => {
    removeTransferCard(transferId);
  }, delay);

  state.transferCleanupTimers.set(transferId, timer);
}

function removeTransferCard(transferId) {
  const timer = state.transferCleanupTimers.get(transferId);
  if (timer) {
    clearTimeout(timer);
    state.transferCleanupTimers.delete(transferId);
  }

  const card = state.transferCards.get(transferId);
  if (card) {
    card.remove();
    state.transferCards.delete(transferId);
  }

  state.outgoingTransfers.delete(transferId);
  state.incomingTransfers.delete(transferId);

  if (!state.transferCards.size) {
    elements.transferList.innerHTML = '<p class="placeholder">Transfers will appear here.</p>';
  }

  renderTransferSummary();
}

function renderPeers() {
  const peers = Array.from(state.peers.values());
  elements.peerCount.textContent = `${peers.filter((peer) => peer.connected).length} online`;

  if (!peers.length) {
    elements.peerList.innerHTML = '<p class="placeholder">No peers connected yet.</p>';
    return;
  }

  elements.peerList.innerHTML = "";
  for (const peer of peers) {
    const item = document.createElement("div");
    item.className = "peer-chip";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(peer.name)}</strong>
        <small>${escapeHtml(peer.id.slice(0, 8))}</small>
      </div>
      <span class="${peer.connected ? "status-live" : "status-idle"}">${peer.connected ? "Ready" : "Reconnecting"}</span>
    `;
    elements.peerList.appendChild(item);
  }
}

function renderRecipientList() {
  const peers = Array.from(state.peers.values()).filter((peer) => peer.channel?.readyState === "open");

  if (!peers.length) {
    elements.recipientList.innerHTML = '<p class="placeholder">Connect to one or more peers to choose recipients.</p>';
    state.selectedPeerIds.clear();
    updateActionState();
    return;
  }

  for (const peerId of Array.from(state.selectedPeerIds)) {
    if (!peers.some((peer) => peer.id === peerId)) {
      state.selectedPeerIds.delete(peerId);
    }
  }

  if (!state.selectedPeerIds.size) {
    peers.forEach((peer) => state.selectedPeerIds.add(peer.id));
  }

  elements.recipientList.innerHTML = "";
  for (const peer of peers) {
    const item = document.createElement("div");
    item.className = "recipient-chip";
    item.innerHTML = `
      <label>
        <input type="checkbox" data-peer-id="${escapeHtml(peer.id)}" ${state.selectedPeerIds.has(peer.id) ? "checked" : ""}>
        <span>
          <strong>${escapeHtml(peer.name)}</strong>
          <small>${escapeHtml(peer.id.slice(0, 8))}</small>
        </span>
      </label>
      <span class="status-live">Ready</span>
    `;
    elements.recipientList.appendChild(item);
  }

  elements.recipientList.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const peerId = event.target.dataset.peerId;
      if (event.target.checked) {
        state.selectedPeerIds.add(peerId);
      } else {
        state.selectedPeerIds.delete(peerId);
      }
      updateActionState();
    });
  });

  updateActionState();
}

function getConnectedPeerIds() {
  return Array.from(state.peers.values())
    .filter((peer) => peer.channel?.readyState === "open")
    .map((peer) => peer.id);
}

function getSelectedPeerIds() {
  const connected = new Set(getConnectedPeerIds());
  return Array.from(state.selectedPeerIds).filter((peerId) => connected.has(peerId));
}

function teardownPeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) {
    return;
  }

  peer.channel?.close();
  peer.pc.close();
  state.peers.delete(peerId);
  state.selectedPeerIds.delete(peerId);
  renderRecipientList();
  updateActionState();
}

async function deriveRoomKey(password, roomId) {
  if (!hasNativeCryptoSuite()) {
    return deriveRoomKeyFallback(password, roomId);
  }

  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: textEncoder.encode(`cipherdrop:${roomId}`),
      iterations: 120000,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptChunk(buffer) {
  if (!hasNativeCryptoSuite()) {
    return encryptChunkFallback(buffer);
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    state.roomKey,
    buffer
  );

  return {
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
  };
}

async function decryptChunk(base64Data, base64Iv) {
  if (!hasNativeCryptoSuite()) {
    return decryptChunkFallback(base64Data, base64Iv);
  }

  const iv = base64ToBytes(base64Iv);
  const encrypted = base64ToBytes(base64Data);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    state.roomKey,
    encrypted
  );
  return decrypted;
}

async function computeFileHash(file) {
  if (!hasNativeCryptoSuite()) {
    return computeFileHashFallback(file);
  }

  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(digest));
}

async function computeHashFromBlob(blob) {
  if (!hasNativeCryptoSuite()) {
    return computeHashFromBlobFallback(blob);
  }

  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return bytesToHex(new Uint8Array(digest));
}

function deriveRoomKeyFallback(password, roomId) {
  if (!window.forge) {
    throw new Error("Forge fallback is unavailable");
  }

  const keyHex = forge.pkcs5.pbkdf2(password, `cipherdrop:${roomId}`, 120000, 32, forge.md.sha256.create());
  return {
    kind: "forge",
    keyHex: forge.util.bytesToHex(keyHex),
  };
}

function encryptChunkFallback(buffer) {
  if (!window.forge || !state.roomKey?.keyHex) {
    throw new Error("Forge encryption is unavailable");
  }

  const ivBytes = new Uint8Array(12);
  webCrypto.getRandomValues(ivBytes);

  const cipher = forge.cipher.createCipher("AES-GCM", forge.util.hexToBytes(state.roomKey.keyHex));
  cipher.start({ iv: uint8ToBinary(ivBytes) });
  cipher.update(forge.util.createBuffer(uint8ToBinary(new Uint8Array(buffer))));
  cipher.finish();

  const encryptedBytes = cipher.output.getBytes() + cipher.mode.tag.getBytes();
  return {
    iv: bytesToBase64(ivBytes),
    data: btoa(encryptedBytes),
  };
}

function decryptChunkFallback(base64Data, base64Iv) {
  if (!window.forge || !state.roomKey?.keyHex) {
    throw new Error("Forge decryption is unavailable");
  }

  const payload = atob(base64Data);
  const cipherBytes = payload.slice(0, -16);
  const tagBytes = payload.slice(-16);
  const decipher = forge.cipher.createDecipher("AES-GCM", forge.util.hexToBytes(state.roomKey.keyHex));
  decipher.start({
    iv: uint8ToBinary(base64ToBytes(base64Iv)),
    tag: forge.util.createBuffer(tagBytes),
  });
  decipher.update(forge.util.createBuffer(cipherBytes));
  const passed = decipher.finish();
  if (!passed) {
    throw new Error("Integrity verification failed during decrypt");
  }

  return binaryToArrayBuffer(decipher.output.getBytes());
}

async function computeFileHashFallback(file) {
  const buffer = await file.arrayBuffer();
  return computeSha256Fallback(new Uint8Array(buffer));
}

async function computeHashFromBlobFallback(blob) {
  const buffer = await blob.arrayBuffer();
  return computeSha256Fallback(new Uint8Array(buffer));
}

function computeSha256Fallback(bytes) {
  if (!window.forge) {
    throw new Error("Forge hashing is unavailable");
  }

  const md = forge.md.sha256.create();
  md.update(uint8ToBinary(bytes));
  return md.digest().toHex();
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function copyTextFallback(text) {
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  helper.style.pointerEvents = "none";
  document.body.appendChild(helper);
  helper.focus();
  helper.select();

  const copied = document.execCommand("copy");
  document.body.removeChild(helper);

  if (!copied) {
    throw new Error("execCommand copy failed");
  }
}

function createTransferId() {
  if (webCrypto?.randomUUID) {
    return webCrypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uint8ToBinary(bytes) {
  let result = "";
  for (let i = 0; i < bytes.length; i += 1) {
    result += String.fromCharCode(bytes[i]);
  }
  return result;
}

function binaryToArrayBuffer(binary) {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bytesToBase64(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function addHistory(entry) {
  state.history.unshift({
    timestamp: new Date().toLocaleString(),
    ...entry,
  });
  state.history = state.history.slice(0, 20);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history));
  renderHistory();
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function renderHistory() {
  if (!state.history.length) {
    elements.historyList.innerHTML = '<p class="placeholder">No transfer history yet.</p>';
    return;
  }

  elements.historyList.innerHTML = "";
  for (const item of state.history) {
    const card = document.createElement("article");
    card.className = "history-card";
    card.innerHTML = `
      <div class="history-meta">
        <strong>${escapeHtml(item.type)}</strong>
        <span>${escapeHtml(item.timestamp)}</span>
      </div>
      <span>${escapeHtml(item.fileName)} - ${escapeHtml(item.peerName || "Peer")}</span>
      <span>${escapeHtml(item.detail || "")}</span>
    `;
    elements.historyList.appendChild(card);
  }
}

function clearHistory() {
  state.history = [];
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`;
}
