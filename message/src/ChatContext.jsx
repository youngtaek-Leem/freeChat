import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { supabase } from './supabaseClient';
import { cryptoUtils } from './utils/crypto';
import { dbUtils } from './utils/db';

const ChatContext = createContext();

export const ChatProvider = ({ children }) => {
  const [unreadCounts, setUnreadCounts] = useState({});
  const [session, setSession] = useState(null);
  const activeRoomRef = useRef(null);
  const privateKeyRef = useRef(null);
  const publicKeyCacheRef = useRef(new Map()); // userId → CryptoKey (public)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;

    const myId = session.user.id;
    let channel = null;
    let cancelled = false;

    // ── helpers ──────────────────────────────────────────────────────────────

    const getPublicKey = async (userId) => {
      if (publicKeyCacheRef.current.has(userId)) return publicKeyCacheRef.current.get(userId);
      const { data } = await supabase
        .from('profiles').select('public_key').eq('id', userId).single();
      if (!data?.public_key) return null;
      try {
        const key = await cryptoUtils.importPublicKey(data.public_key);
        publicKeyCacheRef.current.set(userId, key);
        return key;
      } catch { return null; }
    };

    const getKeysForRoom = async (roomId) => {
      if (!privateKeyRef.current) return null;
      const friendId = roomId.split('_').find(id => id !== myId);
      if (!friendId) return null;
      const friendPubKey = await getPublicKey(friendId);
      if (!friendPubKey) return null;
      return cryptoUtils.deriveRoomKeys(privateKeyRef.current, friendPubKey);
    };

    // ── main init ────────────────────────────────────────────────────────────

    const run = async () => {
      // 1. Init ECDH key pair
      let privateKey = await dbUtils.getSecret('ecdh_private_key');
      if (!privateKey) {
        const keyPair = await cryptoUtils.generateKeyPair();
        privateKey = keyPair.privateKey;
        const jwk = await cryptoUtils.exportPublicKey(keyPair.publicKey);
        await dbUtils.saveSecret('ecdh_private_key', privateKey);
        await dbUtils.saveSecret('ecdh_public_key_jwk', jwk);
        const { error } = await supabase.from('profiles').upsert({ id: myId, public_key: jwk });
        if (error) console.warn('[Auth] public_key upload failed — run SQL migration:', error.message);
      } else {
        // Re-upload on every login to keep Supabase in sync
        const jwk = await dbUtils.getSecret('ecdh_public_key_jwk');
        if (jwk) await supabase.from('profiles').upsert({ id: myId, public_key: jwk });
      }
      if (cancelled) return;
      privateKeyRef.current = privateKey;

      // 2. Load unread counts
      const counts = await dbUtils.getUnreadCounts();
      if (!cancelled) setUnreadCounts(counts);

      // 3. Sync offline pending messages
      try {
        const { data, error } = await supabase
          .from('pending_messages').select('*').eq('receiver_id', myId);
        if (!error && data?.length > 0) {
          const successfulIds = [];
          for (const msg of data) {
            try {
              const friendPubKey = await getPublicKey(msg.sender_id);
              if (!friendPubKey) continue;
              const { encKey } = await cryptoUtils.deriveRoomKeys(privateKey, friendPubKey);
              const text = await cryptoUtils.decrypt(msg.encrypted_payload, encKey);
              await dbUtils.saveMessage({
                messageId: msg.message_id,
                roomId: msg.room_id,
                sender: msg.sender_id,
                text,
                timestamp: msg.timestamp,
                read: activeRoomRef.current === msg.room_id,
              });
              successfulIds.push(msg.id);
            } catch (e) {
              console.error('Failed to sync message:', e);
            }
          }
          if (successfulIds.length > 0) {
            await supabase.from('pending_messages').delete().in('id', successfulIds);
          }
          if (!cancelled) setUnreadCounts(await dbUtils.getUnreadCounts());
        }
      } catch (e) {
        console.error('Offline sync failed:', e);
      }

      if (cancelled) return;

      // 4. Subscribe to personal broadcast channel
      channel = supabase.channel(`user:${myId}`, {
        config: { broadcast: { self: false } },
      });

      channel.on('broadcast', { event: '*' }, async (eventPayload) => {
        const { event, payload } = eventPayload;

        if (event === 'message') {
          const { sender, encryptedText, roomId, messageId, timestamp, sig } = payload;
          if (!sig || !sender || !roomId) return;
          // Sender must be the room's other participant
          if (sender !== roomId.split('_').find(id => id !== myId)) return;

          try {
            const keys = await getKeysForRoom(roomId);
            if (!keys) return;
            if (!await cryptoUtils.verify(keys.sigKey, { sender, roomId, messageId, timestamp }, sig)) return;
            const text = await cryptoUtils.decrypt(encryptedText, keys.encKey);
            const isRead = activeRoomRef.current === roomId;
            await dbUtils.saveMessage({ messageId, roomId, sender, text, timestamp, read: isRead });
            if (!isRead) setUnreadCounts(await dbUtils.getUnreadCounts());
          } catch (e) {
            console.error('Background message error:', e);
          }

        } else if (event === 'delete_message') {
          const { messageId, sender, roomId, sig } = payload;
          if (!messageId || !sender || !roomId || !sig) return;
          if (sender !== roomId.split('_').find(id => id !== myId)) return;

          try {
            const keys = await getKeysForRoom(roomId);
            if (!keys) return;
            if (!await cryptoUtils.verify(keys.sigKey, { sender, roomId, messageId }, sig)) return;
            await dbUtils.deleteMessage(messageId);
            setUnreadCounts(await dbUtils.getUnreadCounts());
          } catch (e) {
            console.error('Background delete error:', e);
          }

        } else if (event === 'clear_chat') {
          const { roomId, sender, sig } = payload;
          if (!roomId || !sender || !sig) return;
          if (sender !== roomId.split('_').find(id => id !== myId)) return;

          try {
            const keys = await getKeysForRoom(roomId);
            if (!keys) return;
            if (!await cryptoUtils.verify(keys.sigKey, { sender, roomId }, sig)) return;
            await dbUtils.clearRoomMessages(roomId);
            setUnreadCounts(await dbUtils.getUnreadCounts());
          } catch (e) {
            console.error('Background clear error:', e);
          }

        } else if (event === 'read_receipt') {
          const { roomId, readerId } = payload;
          if (roomId && readerId) {
            await dbUtils.markMyMessagesAsRecipientRead(roomId, myId);
          }
        }
      }).subscribe();
    };

    run();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [session]);

  const markAsRead = async (roomId) => {
    await dbUtils.markRoomAsRead(roomId);
    setUnreadCounts(prev => { const n = { ...prev }; delete n[roomId]; return n; });
  };

  const setActiveRoom = (roomId) => {
    activeRoomRef.current = roomId;
    if (roomId) markAsRead(roomId);
  };

  return (
    <ChatContext.Provider value={{ unreadCounts, markAsRead, setActiveRoom }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => useContext(ChatContext);
