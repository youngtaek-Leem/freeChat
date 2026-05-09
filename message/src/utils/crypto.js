const ALGO = 'AES-GCM';
const ECDH_CURVE = 'P-256';
export const ENCRYPTION_PREFIX = '_v1_enc_:';

const encode = (text) => new TextEncoder().encode(text);
const decode = (buffer) => new TextDecoder().decode(buffer);

function concatBuffers(ab1, ab2) {
  const u1 = new Uint8Array(ab1);
  const u2 = new Uint8Array(ab2);
  const out = new Uint8Array(u1.length + u2.length);
  out.set(u1);
  out.set(u2, u1.length);
  return out.buffer;
}

export const cryptoUtils = {
  // ── ECDH key pair ─────────────────────────────────────────────────────────

  async generateKeyPair() {
    return window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: ECDH_CURVE },
      false,             // private key is non-extractable
      ['deriveBits']
    );
  },

  async exportPublicKey(publicKey) {
    const jwk = await window.crypto.subtle.exportKey('jwk', publicKey);
    return JSON.stringify(jwk);
  },

  async importPublicKey(jwkString) {
    const jwk = typeof jwkString === 'string' ? JSON.parse(jwkString) : jwkString;
    return window.crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'ECDH', namedCurve: ECDH_CURVE },
      false, []
    );
  },

  // ── Transport key derivation (ECDH → AES-GCM + HMAC) ─────────────────────

  async deriveRoomKeys(myPrivateKey, theirPublicKey) {
    const rawBits = await window.crypto.subtle.deriveBits(
      { name: 'ECDH', public: theirPublicKey },
      myPrivateKey,
      256
    );

    // Derive AES-GCM key: SHA-256(rawBits || "enc")
    const encMaterial = await window.crypto.subtle.digest(
      'SHA-256', concatBuffers(rawBits, encode('enc').buffer)
    );
    const encKey = await window.crypto.subtle.importKey(
      'raw', encMaterial, { name: ALGO }, false, ['encrypt', 'decrypt']
    );

    // Derive HMAC key: SHA-256(rawBits || "sig")
    const sigMaterial = await window.crypto.subtle.digest(
      'SHA-256', concatBuffers(rawBits, encode('sig').buffer)
    );
    const sigKey = await window.crypto.subtle.importKey(
      'raw', sigMaterial, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    );

    return { encKey, sigKey };
  },

  // ── HMAC sign / verify ────────────────────────────────────────────────────

  async sign(sigKey, data) {
    const bytes = encode(JSON.stringify(data));
    const sig = await window.crypto.subtle.sign('HMAC', sigKey, bytes);
    return btoa(String.fromCharCode(...new Uint8Array(sig)));
  },

  async verify(sigKey, data, sigBase64) {
    try {
      const bytes = encode(JSON.stringify(data));
      const sig = new Uint8Array(atob(sigBase64).split('').map(c => c.charCodeAt(0)));
      return window.crypto.subtle.verify('HMAC', sigKey, sig, bytes);
    } catch {
      return false;
    }
  },

  // ── Local storage key derivation (device master key based, unchanged) ─────

  async getDerivedKey(sharedSecret) {
    const secretBuffer = (sharedSecret instanceof Uint8Array || sharedSecret instanceof ArrayBuffer)
      ? sharedSecret
      : encode(sharedSecret);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', secretBuffer);
    return window.crypto.subtle.importKey(
      'raw', hashBuffer, { name: ALGO }, false, ['encrypt', 'decrypt']
    );
  },

  async getDeviceMasterKey(dbUtils) {
    const MASTER_KEY_ID = 'device_master_key';
    let masterKey = await dbUtils.getSecret(MASTER_KEY_ID);
    if (!masterKey) {
      const secureKey = await window.crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
      await dbUtils.saveSecret(MASTER_KEY_ID, secureKey);
      masterKey = secureKey;
      localStorage.removeItem('CHAT_APP_DEVICE_MASTER_KEY');
    }
    return masterKey;
  },

  async getRoomStorageKey(roomId, dbUtils) {
    const masterKey = await this.getDeviceMasterKey(dbUtils);
    if (!masterKey) throw new Error('Master key not found');
    const roomIdBuffer = encode(roomId);
    const iv = new Uint8Array(12); // constant IV for deterministic derivation
    const roomMaterial = await window.crypto.subtle.encrypt(
      { name: ALGO, iv }, masterKey, roomIdBuffer
    );
    return this.getDerivedKey(new Uint8Array(roomMaterial));
  },

  // ── AES-GCM encrypt / decrypt ─────────────────────────────────────────────

  async encrypt(text, key) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt(
      { name: ALGO, iv }, key, encode(text)
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return btoa(String.fromCharCode(...combined));
  },

  async decrypt(cipherText, key) {
    const combined = new Uint8Array(atob(cipherText).split('').map(c => c.charCodeAt(0)));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const decrypted = await window.crypto.subtle.decrypt(
      { name: ALGO, iv }, key, data
    );
    return decode(decrypted);
  },
};
