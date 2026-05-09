import { openDB } from 'idb';
import { cryptoUtils, ENCRYPTION_PREFIX } from './crypto';

const DB_NAME = 'ChatAppDB_v3_E2E'; // v3: ECDH key exchange, clears v2 data encrypted with weak roomId key
const STORE_NAME = 'messages';

let dbPromise = null;

export const dbUtils = {
  async initDB() {
    if (dbPromise) {
      try {
        const db = await dbPromise;
        return db;
      } catch (e) {
        console.warn("[DB] Existing dbPromise was rejected, retrying...");
        dbPromise = null;
      }
    }
    
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db, oldVersion) {
        console.log(`[DB] Upgrade: Creating Secure Stores (v${oldVersion} -> 1)...`);
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'messageId' });
          store.createIndex('roomId', 'roomId');
          store.createIndex('read', 'read');
        }
        if (!db.objectStoreNames.contains('secrets')) {
          db.createObjectStore('secrets', { keyPath: 'id' });
        }
      },
      blocked() {
        console.warn("[DB] Upgrade blocked! Please close other tabs.");
      },
      blocking() {
        console.warn("[DB] This tab is blocking an upgrade.");
      }
    });
    return dbPromise;
  },

  async saveSecret(id, key) {
    try {
      const db = await this.initDB();
      await db.put('secrets', { id, key });
      console.log(`[DB] Secret saved: ${id}`);
    } catch (e) {
      console.error(`[DB] Failed to save secret ${id}:`, e);
      throw e;
    }
  },

  async getSecret(id) {
    try {
      const db = await this.initDB();
      const entry = await db.get('secrets', id);
      console.log(`[DB] Secret retrieval for ${id}: ${entry ? 'FOUND' : 'NOT FOUND'}`);
      return entry ? entry.key : null;
    } catch (e) {
      console.error(`[DB] Failed to get secret ${id}:`, e);
      return null;
    }
  },

  async saveMessage(message) {
    try {
      if (!message.roomId || !message.messageId) {
        console.error("[DB] Rejecting message: Missing metadata", message);
        return;
      }

      const db = await this.initDB();
      
      // Encrypt message text before saving to DB
      let textToSave = message.text;
      try {
        if (message.text && !message.text.startsWith(ENCRYPTION_PREFIX)) {
          const localKey = await cryptoUtils.getRoomStorageKey(message.roomId, this);
          const encrypted = await cryptoUtils.encrypt(message.text, localKey);
          textToSave = ENCRYPTION_PREFIX + encrypted;
        }
      } catch (e) {
        console.error("[DB] Encryption error, fallback to plain:", e);
      }

      await db.put(STORE_NAME, { 
        ...message, 
        text: textToSave,
        read: message.read ? 1 : 0,
        recipientRead: message.recipientRead ? 1 : 0
      });
      console.log(`[DB] Saved message ${message.messageId} to room ${message.roomId}`);
    } catch (e) {
      console.error("[DB] Message save FAILED:", e);
    }
  },

  async getMessagesByRoom(roomId) {
    try {
      if (!roomId) return [];
      
      const db = await this.initDB();
      const msgs = await db.getAllFromIndex(STORE_NAME, 'roomId', roomId);
      
      if (msgs.length === 0) {
        // Diagnostic: Check if any messages exist at all in the store
        const allCount = await db.count(STORE_NAME);
        console.log(`[DB] Query for room ${roomId} returned 0 results. (Total messages in DB: ${allCount})`);
      } else {
        console.log(`[DB] Found ${msgs.length} messages for room ${roomId}`);
      }
      
      let localKey = null;
      try {
        localKey = await cryptoUtils.getRoomStorageKey(roomId, this);
      } catch (e) {
        console.error("[DB] Key derivation failed for room:", roomId);
      }

      // Decrypt messages
      const decryptedMsgs = await Promise.all(msgs.map(async (msg) => {
        if (msg.text && msg.text.startsWith(ENCRYPTION_PREFIX)) {
          if (!localKey) return { ...msg, text: "[Decryption Key Missing]" };
          try {
            const cipherText = msg.text.substring(ENCRYPTION_PREFIX.length);
            const decrypted = await cryptoUtils.decrypt(cipherText, localKey);
            return { ...msg, text: decrypted };
          } catch (e) {
            console.error("[DB] Decryption failed for:", msg.messageId);
            return { ...msg, text: "[Decryption Failed]" };
          }
        }
        return msg;
      }));

      return decryptedMsgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    } catch (e) {
      console.error("[DB] Query failed:", e);
      return [];
    }
  },

  async markRoomAsRead(roomId) {
    const db = await this.initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const msgs = await store.index('roomId').getAll(roomId);
    
    for (const msg of msgs) {
      if (msg.read === 0) {
        msg.read = 1;
        await store.put(msg);
      }
    }
    await tx.done;
  },

  async markMyMessagesAsRecipientRead(roomId, myId) {
    const db = await this.initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const msgs = await store.index('roomId').getAll(roomId);
    
    for (const msg of msgs) {
      if (msg.sender === myId && !msg.recipientRead) {
        msg.recipientRead = 1;
        await store.put(msg);
      }
    }
    await tx.done;
  },

  async getUnreadCounts() {
    const db = await this.initDB();
    const allUnread = await db.getAllFromIndex(STORE_NAME, 'read', 0);
    const counts = {};
    allUnread.forEach(m => {
      counts[m.roomId] = (counts[m.roomId] || 0) + 1;
    });
    return counts;
  },

  async deleteMessage(messageId) {
    const db = await this.initDB();
    await db.delete(STORE_NAME, messageId);
  },

  async clearRoomMessages(roomId) {
    const db = await this.initDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const index = tx.store.index('roomId');
    let cursor = await index.openCursor(IDBKeyRange.only(roomId));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }
};

