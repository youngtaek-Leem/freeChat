import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { cryptoUtils } from '../utils/crypto';
import { dbUtils } from '../utils/db';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useChat } from '../ChatContext';

const ChatRoom = ({ session }) => {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [encryptionKey, setEncryptionKey] = useState(null);
  const [friendProfile, setFriendProfile] = useState(null);
  const messagesEndRef = useRef(null);
  const channelRef = useRef(null);
  const { setActiveRoom } = useChat();

  // We will use the roomId as the shared secret for this MVP
  const sharedSecret = roomId;
  const friendId = roomId.split('_').find(id => id !== session.user.id);

  useEffect(() => {
    setActiveRoom(roomId);
    
    const init = async () => {
      const key = await cryptoUtils.getDerivedKey(sharedSecret);
      setEncryptionKey(key);

      const localMsgs = await dbUtils.getMessagesByRoom(roomId);
      setMessages(localMsgs);

      // Fetch friend's profile info
      const { data } = await supabase.from('profiles').select('*').eq('id', friendId).single();
      setFriendProfile(data);
    };
    init();

    return () => setActiveRoom(null);
  }, [roomId, sharedSecret, friendId]);

  useEffect(() => {
    if (!encryptionKey) return;

    // Use a room-specific channel name so it doesn't conflict with the global listener
    const channel = supabase.channel(`room:${roomId}`, {
      config: { broadcast: { self: false } }
    });
    channelRef.current = channel;

    channel
      .on('broadcast', { event: '*' }, async (eventPayload) => {
        console.log("ChatRoom: Received broadcast", eventPayload);
        const { event, payload } = eventPayload;
        
        if (event === 'message') {
          const { sender, encryptedText, roomId: msgRoomId, messageId, timestamp } = payload;
          if (msgRoomId !== roomId) return; 
          
          try {
            const decryptedText = await cryptoUtils.decrypt(encryptedText, encryptionKey);
            const newMessage = { 
              messageId, roomId, sender, text: decryptedText, timestamp,
              read: true
            };

            await dbUtils.saveMessage(newMessage);
            setMessages(prev => {
              if (prev.find(m => m.messageId === newMessage.messageId)) return prev;
              return [...prev, newMessage];
            });
          } catch (e) {
            console.error("Failed to decrypt message:", e);
          }
        } else if (event === 'delete_message') {
          console.log("ChatRoom: Received delete_message event", payload);
          const messageId = payload.messageId || payload; // Get the string directly
          if (!messageId || typeof messageId !== 'string') return;
          setMessages(prev => prev.filter(m => m.messageId !== messageId));
          await dbUtils.deleteMessage(messageId);
        } else if (event === 'clear_chat') {
          console.log("ChatRoom: Received clear_chat event");
          setMessages([]);
          await dbUtils.clearRoomMessages(roomId);
        }
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('Joined room:', roomId);
        }
      });

    return () => { supabase.removeChannel(channel); };
  }, [encryptionKey, roomId, session.user.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() || !encryptionKey) return;

    try {
      const encryptedText = await cryptoUtils.encrypt(input, encryptionKey);
      const messageId = window.crypto.randomUUID();
      const timestamp = new Date().toISOString();

      const payload = {
        type: 'broadcast',
        event: 'message',
        payload: { sender: session.user.id, encryptedText, roomId, messageId, timestamp },
      };

      // 1. Update UI and Local DB first (Immediate feedback)
      const myMessage = { 
        messageId,
        roomId, 
        sender: session.user.id, 
        text: input, 
        timestamp,
        read: true
      };
      
      console.log("ChatRoom: Saving to local DB and updating UI...");
      await dbUtils.saveMessage(myMessage);
      setMessages(prev => [...prev, myMessage]);
      const lastInput = input;
      setInput('');

      // 2. Send to the active room channel (Fast & Direct)
      if (channelRef.current) {
        console.log("ChatRoom: Sending broadcast to room...");
        channelRef.current.send(payload);
      }

      // 3. Send to the friend's personal channel (For background notification)
      console.log("ChatRoom: Sending broadcast to friend's channel...");
      const userChannel = supabase.channel(`user:${friendId}`);
      userChannel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await userChannel.send(payload);
          setTimeout(() => supabase.removeChannel(userChannel), 1000);
        }
      });

      // 4. Store in server's pending_messages table (For offline/logout delivery)
      console.log("ChatRoom: Storing in pending_messages table...");
      const { error: insErr } = await supabase.from('pending_messages').insert({
        sender_id: session.user.id,
        receiver_id: friendId,
        room_id: roomId,
        encrypted_payload: encryptedText,
        message_id: messageId,
        timestamp: timestamp
      });
      if (insErr) console.error("ChatRoom: Pending insert failed:", insErr);
      
    } catch (e) {
      console.error("ChatRoom: Send error:", e);
      alert("Error sending message");
    }
  };

  const deleteMessage = async (messageId) => {
    try {
      // 1. Remove from local state and DB
      setMessages(prev => prev.filter(m => m.messageId !== messageId));
      await dbUtils.deleteMessage(messageId);

      const deletePayload = {
        type: 'broadcast',
        event: 'delete_message',
        payload: { messageId },
      };

      // 2. Broadcast deletion
      if (channelRef.current) await channelRef.current.send(deletePayload);
      
      const userChannel = supabase.channel(`user:${friendId}`);
      userChannel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await userChannel.send(deletePayload);
          setTimeout(() => supabase.removeChannel(userChannel), 1000);
        }
      });

      // 3. Remove from server pending messages
      await supabase.from('pending_messages').delete().eq('message_id', messageId);
    } catch (e) {
      console.error("Error deleting message:", e);
    }
  };

  const clearChat = async () => {
    if (!window.confirm("ARE YOU SURE? This will delete ALL messages for BOTH participants FOREVER.")) return;

    try {
      // 1. Local cleanup
      setMessages([]);
      await dbUtils.clearRoomMessages(roomId);

      const clearPayload = {
        type: 'broadcast',
        event: 'clear_chat',
        payload: { roomId },
      };

      // 2. Broadcast to room and personal channel
      if (channelRef.current) await channelRef.current.send(clearPayload);
      
      const userChannel = supabase.channel(`user:${friendId}`);
      userChannel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await userChannel.send(clearPayload);
          setTimeout(() => supabase.removeChannel(userChannel), 1000);
        }
      });

      // 3. Cleanup server postbox
      await supabase.from('pending_messages').delete().eq('room_id', roomId);
    } catch (e) {
      console.error("Error clearing chat:", e);
    }
  };

  return (
    <div className="container" style={{ display: 'flex', flexDirection: 'column', height: '100vh', paddingBottom: '1rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <Link to="/" className="btn" style={{ 
          textDecoration: 'none', 
          backgroundColor: '#4b5563', 
          width: 'auto', 
          padding: '5px 12px', 
          fontSize: '0.9rem',
          margin: 0
        }}>← Back</Link>
        <h2 style={{ margin: 0, fontSize: '1.1rem', wordBreak: 'break-all', maxWidth: '60%', textAlign: 'center' }}>
          {friendProfile?.email || 'Loading...'}
        </h2>
        <button 
          onClick={clearChat}
          style={{ 
            background: 'none', 
            border: '1px solid rgba(239, 68, 68, 0.5)', 
            color: '#ef4444', 
            cursor: 'pointer',
            padding: '5px 10px',
            borderRadius: '5px',
            fontSize: '0.8rem'
          }}
        >
          🗑️ Clear All
        </button>
      </header>

      <div className="glass-panel" style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flexGrow: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {messages.map((msg, i) => {
            const isMe = msg.sender === session.user.id;
            return (
              <div key={i} style={{
                alignSelf: isMe ? 'flex-end' : 'flex-start',
                backgroundColor: isMe ? 'var(--primary-color)' : 'rgba(255,255,255,0.1)',
                padding: '0.75rem 1rem',
                borderRadius: '12px',
                maxWidth: '70%',
                wordBreak: 'break-word',
                position: 'relative',
                group: 'true' // For hover detection
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                  <div>{msg.text}</div>
                  {isMe && (
                    <button 
                      onClick={() => deleteMessage(msg.messageId)}
                      style={{ 
                        background: 'none', 
                        border: 'none', 
                        color: 'rgba(255,255,255,0.4)', 
                        cursor: 'pointer',
                        fontSize: '0.8rem',
                        padding: '0 0 0 5px'
                      }}
                      title="Delete message"
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)', marginTop: '0.25rem', textAlign: isMe ? 'right' : 'left' }}>
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>
        <form onSubmit={sendMessage} style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
          <input 
            type="text" 
            value={input} 
            onChange={(e) => setInput(e.target.value)} 
            placeholder="Type a message..."
            className="input-field"
            style={{ marginBottom: 0, flexGrow: 1 }}
          />
          <button type="submit" className="btn" style={{ width: 'auto' }}>Send</button>
        </form>
      </div>
    </div>
  );
};

export default ChatRoom;
