import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { supabase } from './supabaseClient';
import { cryptoUtils } from './utils/crypto';
import { dbUtils } from './utils/db';

const ChatContext = createContext();

export const ChatProvider = ({ children }) => {
  const [unreadCounts, setUnreadCounts] = useState({});
  const [session, setSession] = useState(null);
  const activeRoomRef = useRef(null);

  useEffect(() => {
    console.log("ChatProvider: Initializing auth...");
    supabase.auth.getSession().then(({ data: { session } }) => {
      console.log("ChatProvider: Session loaded", session?.user?.id);
      setSession(session);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      console.log("ChatProvider: No session, skipping realtime init");
      return;
    }

    console.log("ChatProvider: Starting realtime and sync for", session.user.id);
    
    // Sync offline messages from server
    syncOfflineMessages(session.user.id);

    dbUtils.getUnreadCounts()
      .then(counts => {
        console.log("ChatProvider: Unread counts loaded", counts);
        setUnreadCounts(counts);
      })
      .catch(err => console.error("Initial unread load failed:", err));

    const myId = session.user.id;
    const channel = supabase.channel(`user:${myId}`, {
      config: { broadcast: { self: false } }
    });

    channel
      .on('broadcast', { event: '*' }, async (eventPayload) => {
        const { event, payload } = eventPayload;
        
        if (event === 'message') {
          const { sender, encryptedText, roomId, messageId, timestamp } = payload;
          try {
            const isRead = activeRoomRef.current === roomId;
            const key = await cryptoUtils.getDerivedKey(roomId);
            const decryptedText = await cryptoUtils.decrypt(encryptedText, key);
            
            const newMessage = { 
              messageId, roomId, sender, text: decryptedText, timestamp, 
              read: isRead
            };

            await dbUtils.saveMessage(newMessage);
            if (!isRead) {
              const counts = await dbUtils.getUnreadCounts();
              setUnreadCounts(counts);
            }
          } catch (e) {
            console.error("Background message error:", e);
          }
        } else if (event === 'delete_message') {
          const messageId = payload.messageId || payload;
          if (messageId && typeof messageId === 'string') {
            await dbUtils.deleteMessage(messageId);
            const counts = await dbUtils.getUnreadCounts();
            setUnreadCounts(counts);
          }
        } else if (event === 'clear_chat') {
          const { roomId } = payload;
          await dbUtils.clearRoomMessages(roomId);
          const counts = await dbUtils.getUnreadCounts();
          setUnreadCounts(counts);
        } else if (event === 'read_receipt') {
          const { roomId, readerId } = payload;
          await dbUtils.markMyMessagesAsRecipientRead(roomId, myId);
        }
      })
      .subscribe((status) => {
        console.log(`ChatProvider: Subscription status for user:${myId}:`, status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [session]);

  const syncOfflineMessages = async (myId) => {
    try {
      console.log("ChatProvider: Syncing offline messages...");
      const { data, error } = await supabase
        .from('pending_messages')
        .select('*')
        .eq('receiver_id', myId);

      if (error) throw error;
      if (!data || data.length === 0) return;

      for (const msg of data) {
        try {
          const sharedSecret = msg.room_id;
          const key = await cryptoUtils.getDerivedKey(sharedSecret);
          const decryptedText = await cryptoUtils.decrypt(msg.encrypted_payload, key);

          const newMessage = {
            messageId: msg.message_id,
            roomId: msg.room_id,
            sender: msg.sender_id,
            text: decryptedText,
            timestamp: msg.timestamp,
            read: activeRoomRef.current === msg.room_id
          };

          await dbUtils.saveMessage(newMessage);
        } catch (e) {
          console.error("Failed to sync individual message:", e);
        }
      }

      // Clear the postbox after successful sync
      const idsToDelete = data.map(m => m.id);
      await supabase.from('pending_messages').delete().in('id', idsToDelete);
      
      console.log(`ChatProvider: Synced ${data.length} messages.`);
      const counts = await dbUtils.getUnreadCounts();
      setUnreadCounts(counts);
    } catch (e) {
      console.error("Offline sync failed:", e);
    }
  };

  const markAsRead = async (roomId) => {
    await dbUtils.markRoomAsRead(roomId);
    setUnreadCounts(prev => {
      const next = { ...prev };
      delete next[roomId];
      return next;
    });
  };

  const setActiveRoom = (roomId) => {
    activeRoomRef.current = roomId;
    if (roomId) {
      markAsRead(roomId);
    }
  };

  return (
    <ChatContext.Provider value={{ unreadCounts, markAsRead, setActiveRoom }}>
      {children}
    </ChatContext.Provider>
  );
};

export const useChat = () => useContext(ChatContext);
