const ALGO = 'AES-GCM';

const encode = (text) => new TextEncoder().encode(text);
const decode = (buffer) => new TextDecoder().decode(buffer);

export const cryptoUtils = {
  async getDerivedKey(sharedSecret) {
    // Hash the sharedSecret using SHA-256 to ensure it's exactly 256 bits (32 bytes)
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', encode(sharedSecret));
    return await window.crypto.subtle.importKey(
      'raw',
      hashBuffer,
      { name: ALGO },
      false,
      ['encrypt', 'decrypt']
    );
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
