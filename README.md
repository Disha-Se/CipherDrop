# CipherDrop 🔐⚡

> Encrypted. Peer-to-peer. No cloud. Works on your phone.

**CipherDrop** transfers files directly between any two devices — laptop to phone, phone to phone, any browser — through a live encrypted WebRTC connection. The server never sees your files.

---

## Screenshots

| Session control | QR connect + live peers | Transfer in progress + audit trail |
|---|---|---|
| ![Session](https://github.com/Disha-Se/CipherDrop/blob/main/Screenshot%202026-04-12%20222746.png) | ![QR](https://github.com/Disha-Se/CipherDrop/blob/main/Screenshot%202026-04-12%20223016.png) | ![Transfer](https://github.com/Disha-Se/CipherDrop/blob/main/Screenshot%202026-04-12%20223046.png) |

---

## How It Works

```
Your Laptop                          Friend's Phone
──────────                           ──────────────
Create room + password               Scan QR code
                           →         Auto-joined ✅ (Ready)
Select files
Encrypt chunks (AES-GCM)   →→→→→→→→  Receiving... ████████ 100%
                                     SHA-256 ✅ Verified
Audit trail logged ✓                 Audit trail logged ✓
```

---

## Why CipherDrop Is Different

Most "secure file sharing" tools upload your file to a server and give you a download link. That server sees, stores, and controls everything.

**CipherDrop skips the server for file transfer entirely.** The server only helps two devices find each other. Once the WebRTC channel is open — it's direct, encrypted, and yours.

---

## Security Architecture

| Layer | Implementation |
|---|---|
| **Access control** | Password-protected rooms — wrong password, no entry |
| **Server-side password storage** | Hashed with `scrypt` via Node.js `crypto` — never stored in plaintext |
| **Encryption key** | Both devices independently derive the same AES key using **PBKDF2** (SHA-256, 120,000 iterations) — key is never transmitted |
| **File encryption** | Every chunk encrypted with **AES-GCM** before leaving the sender's device |
| **Integrity verification** | **SHA-256** hash computed before send, recomputed after reassembly — mismatch = transfer failed |
| **Transport** | **WebRTC RTCDataChannel** — direct device-to-device, no relay for file data |
| **Resumable transfers** | Chunk-level index tracking — reconnects continue from the exact missed chunk |

---

## Features

- 📱 **Works on phones** — any browser, no install, scan QR to join
- 👥 **Multi-peer rooms** — multiple devices in one room, send to specific peers
- 📊 **Live transfer progress** — chunk-by-chunk progress bar in real time
- 🖼️ **Media preview** — images and videos preview before sending
- 📋 **Audit trail** — every transfer logged with timestamp, size, encryption method, and peer
- 🔁 **Resumable transfers** — dropped mid-file? Picks up from exactly where it stopped
- 📷 **QR onboarding** — room ID + password bundled in one scannable code

---

## Tech Stack

| | Tech |
|---|---|
| Server | Node.js, Express, Socket.IO |
| Crypto | Web Crypto API + Forge.js (Safari/fallback) |
| Transport | WebRTC (RTCDataChannel) |
| Frontend | Vanilla JS, HTML, CSS |

---

## Run It Locally

```bash
git clone https://github.com/yourusername/cipherdrop
cd cipherdrop
npm install
node server.js
```

- Open `http://localhost:3000` on your laptop
- Open `http://<your-local-ip>:3000` on your phone
- Create a room → scan the QR → start dropping files 🚀

---

## Limitations

- Best on the same local network (no TURN relay for cross-network yet)
- Transfer history stored locally in the browser
- Prototype-grade — not hardened for public deployment (no HTTPS, no PKI)

---

## Cybersecurity Concepts Demonstrated

**Confidentiality** — AES-GCM encryption on every chunk  
**Integrity** — SHA-256 hash verification post-transfer  
**Access Control** — password-protected sessions with hashed storage  
**Key Derivation** — PBKDF2 from shared secret, independently on both sides  
**Audit Trail** — local transfer history with encryption metadata  

> Every security feature is load-bearing — not decoration.
