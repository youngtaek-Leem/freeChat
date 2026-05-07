const ALGO = 'AES-GCM';
const STORAGE_MASTER_KEY_NAME = 'CHAT_APP_DEVICE_MASTER_KEY';
export const ENCRYPTION_PREFIX = '_v1_enc_:';

const encode = (text) => new TextEncoder().encode(text);
const decode = (buffer) => new TextDecoder().decode(buffer);

export const cryptoUtils = {
  async getDerivedKey(sharedSecret) {
    // If sharedSecret is already a buffer/Uint8Array, use it directly.
    // Otherwise, encode the string.
    const secretBuffer = (sharedSecret instanceof Uint8Array || sharedSecret instanceof ArrayBuffer)
      ? sharedSecret
      : encode(sharedSecret);

    const hashBuffer = await window.crypto.subtle.digest('SHA-256', secretBuffer);
    return await window.crypto.subtle.importKey(
      'raw',
      hashBuffer,
      { name: ALGO },
      false,
      ['encrypt', 'decrypt']
    );
  },

  async getDeviceMasterKey(dbUtils) {
    const MASTER_KEY_ID = 'device_master_key';
    
    // Use the passed dbUtils to avoid circular dependency
    let masterKey = await dbUtils.getSecret(MASTER_KEY_ID);
    if (!masterKey) {
      console.warn("[Crypto] !!! MASTER KEY MISSING, GENERATING NEW ONE !!!");
      // Generate a non-extractable master key
      const secureKey = await window.crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false, // NON-EXTRACTABLE
        ['encrypt', 'decrypt']
      );
      
      await dbUtils.saveSecret(MASTER_KEY_ID, secureKey);
      masterKey = secureKey;
      
      // Cleanup legacy localStorage key if it exists
      localStorage.removeItem(STORAGE_MASTER_KEY_NAME);
    }
    return masterKey;
  },

  async getRoomStorageKey(roomId, dbUtils) {
    try {
      const masterKey = await this.getDeviceMasterKey(dbUtils);
      if (!masterKey) throw new Error("Master key not found");
      
      // For per-room isolation, we use the Master Key to encrypt the RoomID deterministically
      const roomIdBuffer = encode(roomId);
      const iv = new Uint8Array(12); // Constant IV for deterministic derivation
      const roomMaterial = await window.crypto.subtle.encrypt(
        { name: ALGO, iv },
        masterKey,
        roomIdBuffer
      );
      
      // roomMaterial is an ArrayBuffer, pass it to getDerivedKey
      return await this.getDerivedKey(new Uint8Array(roomMaterial));
    } catch (e) {
      console.error(`[Crypto] Failed to derive room key for ${roomId}:`, e);
      throw e;
    }
  },

  async encrypt(text, key) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt(
      { name: ALGO, iv },
      key,
      encode(text)
    );

    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    
    // Base64 encode for safe transmission
    return btoa(String.fromCharCode(...combined));
  },

  async decrypt(cipherText, key) {
    const combined = new Uint8Array(atob(cipherText).split('').map(c => c.charCodeAt(0)));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);

    const decrypted = await window.crypto.subtle.decrypt(
      { name: ALGO, iv },
      key,
      data
    );

    return decode(decrypted);
  }
};

