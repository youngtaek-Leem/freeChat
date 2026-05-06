import { openDB } from 'idb';

const DB_NAME = 'ChatAppDB_FINAL';
const STORE_NAME = 'messages';

export const dbUtils = {
  async initDB() {
    return openDB(DB_NAME, 1, { // Reset to version 1 with new name
      upgrade(db) {
        console.log("Upgrading/Creating IndexedDB...");
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'messageId' });
          store.createIndex('roomId', 'roomId');
          store.createIndex('read', 'read');
        }
      },
    });
  },

  async saveMessage(message) {
    const db = await this.initDB();
    await db.put(STORE_NAME, { 
      ...message, 
      read: message.read ? 1 : 0 // Using 1/0 for boolean indexing safety
    });
  },

  async getMessagesByRoom(roomId) {
    const db = await this.initDB();
    const msgs = await db.getAllFromIndex(STORE_NAME, 'roomId', roomId);
    return msgs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
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
  }
};
