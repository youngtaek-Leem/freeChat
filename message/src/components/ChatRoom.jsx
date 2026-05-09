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
  const [encKey, setEncKey] = useState(null);
  const [sigKey, setSigKey] = useState(null);
  const [friendProfile, setFriendProfile] = useState(null);
  const [keyError, setKeyError] = useState(null);
  const messagesEndRef = useRef(null);
  const channelRef = useRef(null);
  const { setActiveRoom } = useChat();

  const myId = session.user.id;
  const friendId = roomId.split('_').find(id => id !== myId);

  useEffect(() => {
    setActiveRoom(roomId);

    const init = async () => {
      // Load local messages first for instant display
      const localMsgs = await dbUtils.getMessagesByRoom(roomId);
      setMessages(localMsgs);

      // Get own private key
      const privateKey = await dbUtils.getSecret('ecdh_private_key');
      if (!privateKey) {
        setKeyError('Local key missing. Please log out and log in again.');
        return;
      }

      // Fetch friend's profile and public key
      const { data } = await supabase
        .from('profiles')
        .select('username, public_key')
        .eq('id', friendId)
        .single();
      setFriendProfile(data);

      if (!data?.public_key) {
        setKeyError('Friend has not set up secure messaging yet. Ask them to log in again.');
        return;
      }

      // Derive ECDH transport keys
      try {
        const friendPubKey = await cryptoUtils.importPublicKey(data.public_key);
        const keys = await cryptoUtils.deriveRoomKeys(privateKey, friendPubKey);
        setEncKey(keys.encKey);
        setSigKey(keys.sigKey);
      } catch (e) {
        setKeyError('Failed to establish secure channel.');
        console.error('[ChatRoom] Key derivation failed:', e);
      }
    };

    init();
    return () => setActiveRoom(null);
  }, [roomId, friendId]);

  // Subscribe to room broadcast channel once keys are ready
  useEffect(() => {
    if (!encKey || !sigKey) return;

    const channel = supabase.channel(`room:${roomId}`, {
      config: { broadcast: { self: false } },
    });
    channelRef.current = channel;

    channel.on('broadcast', { event: '*' }, async (eventPayload) => {
      const { event, payload } = eventPayload;

      if (event === 'message') {
        const { sender, encryptedText, roomId: msgRoomId, messageId, timestamp, sig } = payload;
        if (msgRoomId !== roomId || !sig) return;
        // Only accept messages from the room's other participant
        if (sender !== friendId) return;

        try {
          if (!await cryptoUtils.verify(sigKey, { sender, roomId, messageId, timestamp }, sig)) return;
          const text = await cryptoUtils.decrypt(encryptedText, encKey);
          const newMsg = { messageId, roomId, sender, text, timestamp, read: true };
          await dbUtils.saveMessage(newMsg);
          setMessages(prev => prev.find(m => m.messageId === messageId) ? prev : [...prev, newMsg]);
        } catch (e) {
          console.error('Failed to decrypt message:', e);
        }

      } else if (event === 'delete_message') {
        const { messageId, sender, roomId: msgRoomId, sig } = payload;
        if (!messageId || !sig || sender !== friendId) return;
        const rid = msgRoomId || roomId;
        try {
          if (!await cryptoUtils.verify(sigKey, { sender, roomId: rid, messageId }, sig)) return;
          setMessages(prev => prev.filter(m => m.messageId !== messageId));
          await dbUtils.deleteMessage(messageId);
        } catch (e) {
          console.error('Failed to process delete:', e);
        }

      } else if (event === 'clear_chat') {
        const { roomId: msgRoomId, sender, sig } = payload;
        if (!sig || sender !== friendId) return;
        const rid = msgRoomId || roomId;
        try {
          if (!await cryptoUtils.verify(sigKey, { sender, roomId: rid }, sig)) return;
          setMessages([]);
          await dbUtils.clearRoomMessages(roomId);
        } catch (e) {
          console.error('Failed to process clear:', e);
        }
      }
    }).subscribe((status) => {
      if (status === 'SUBSCRIBED') console.log('Joined room:', roomId);
    });

    return () => supabase.removeChannel(channel);
  }, [encKey, sigKey, roomId, friendId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() || !encKey || !sigKey) return;

    try {
      const encryptedText = await cryptoUtils.encrypt(input, encKey);
      const messageId = window.crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const sender = myId;

      // Sign message metadata
      const sig = await cryptoUtils.sign(sigKey, { sender, roomId, messageId, timestamp });

      const broadcastPayload = {
        type: 'broadcast',
        event: 'message',
        payload: { sender, encryptedText, roomId, messageId, timestamp, sig },
      };

      // Optimistic update
      await dbUtils.saveMessage({ messageId, roomId, sender, text: input, timestamp, read: true });
      setMessages(prev => [...prev, { messageId, roomId, sender, text: input, timestamp, read: true }]);
      setInput('');

      // Broadcast to room channel
      if (channelRef.current) channelRef.current.send(broadcastPayload);

      // Notify friend's personal channel (for background delivery)
      const userChannel = supabase.channel(`user:${friendId}`);
      userChannel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await userChannel.send(broadcastPayload);
          setTimeout(() => supabase.removeChannel(userChannel), 1000);
        }
      });

      // Store in server pending_messages for offline delivery
      const { error: insErr } = await supabase.from('pending_messages').insert({
        sender_id: sender,
        receiver_id: friendId,
        room_id: roomId,
        encrypted_payload: encryptedText,
        message_id: messageId,
        timestamp,
      });
      if (insErr) console.error('Pending insert failed:', insErr);
    } catch (e) {
      console.error('Send error:', e);
      alert('Error sending message');
    }
  };

  const deleteMessage = async (messageId) => {
    if (!sigKey) return;
    try {
      setMessages(prev => prev.filter(m => m.messageId !== messageId));
      await dbUtils.deleteMessage(messageId);

      const sender = myId;
      const sig = await cryptoUtils.sign(sigKey, { sender, roomId, messageId });
      const deletePayload = {
        type: 'broadcast',
        event: 'delete_message',
        payload: { messageId, sender, roomId, sig },
      };

      if (channelRef.current) await channelRef.current.send(deletePayload);

      const userChannel = supabase.channel(`user:${friendId}`);
      userChannel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await userChannel.send(deletePayload);
          setTimeout(() => supabase.removeChannel(userChannel), 1000);
        }
      });

      await supabase.from('pending_messages').delete().eq('message_id', messageId);
    } catch (e) {
      console.error('Error deleting message:', e);
    }
  };

  const clearChat = async () => {
    if (!sigKey) return;
    if (!window.confirm('ARE YOU SURE? This will delete ALL messages for BOTH participants FOREVER.')) return;

    try {
      setMessages([]);
      await dbUtils.clearRoomMessages(roomId);

      const sender = myId;
      const sig = await cryptoUtils.sign(sigKey, { sender, roomId });
      const clearPayload = {
        type: 'broadcast',
        event: 'clear_chat',
        payload: { roomId, sender, sig },
      };

      if (channelRef.current) await channelRef.current.send(clearPayload);

      const userChannel = supabase.channel(`user:${friendId}`);
      userChannel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await userChannel.send(clearPayload);
          setTimeout(() => supabase.removeChannel(userChannel), 1000);
        }
      });

      await supabase.from('pending_messages').delete().eq('room_id', roomId);
    } catch (e) {
      console.error('Error clearing chat:', e);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="container" style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      padding: 0, maxWidth: '600px', backgroundColor: 'var(--bg-color)',
    }}>
      <header style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '0.75rem 1rem',
        borderBottom: '2px solid var(--primary-color)',
        backgroundColor: 'color-mix(in srgb, var(--primary-color), white 75%)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        position: 'sticky', top: 0, zIndex: 10,
      }}>
        <Link to="/" className="btn" style={{
          textDecoration: 'none', backgroundColor: 'transparent',
          width: 'auto', padding: '5px 8px', fontSize: '1rem',
          margin: 0, color: 'var(--primary-color)',
        }}>〈 Back</Link>
        <h2 style={{
          margin: 0, fontSize: '1.1rem', fontWeight: '700',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '50%',
        }}>
          {friendProfile?.username || 'Loading...'}
        </h2>
        <button onClick={clearChat} style={{
          background: 'none', border: 'none', color: '#ef4444',
          cursor: 'pointer', padding: '5px', fontSize: '1rem', opacity: 0.9, fontWeight: 'bold',
        }}>
          Clear
        </button>
      </header>

      {keyError && (
        <div style={{
          padding: '1rem', backgroundColor: 'rgba(239,68,68,0.1)',
          borderBottom: '1px solid rgba(239,68,68,0.3)',
          color: '#ef4444', fontSize: '0.85rem', textAlign: 'center',
        }}>
          🔒 {keyError}
        </div>
      )}

      <div style={{
        flexGrow: 1, overflowY: 'auto', padding: '1rem',
        display: 'flex', flexDirection: 'column', gap: '0.75rem',
        backgroundImage: 'radial-gradient(circle at top right, color-mix(in srgb, var(--primary-color), transparent 92%), transparent)',
      }}>
        {messages.map((msg, i) => {
          const isMe = msg.sender === myId;
          return (
            <div key={i} style={{
              alignSelf: isMe ? 'flex-end' : 'flex-start',
              backgroundColor: isMe ? 'var(--primary-color)' : 'var(--surface-color)',
              color: isMe ? 'white' : 'var(--text-main)',
              padding: '0.6rem 0.9rem',
              borderRadius: isMe ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
              maxWidth: '85%', wordBreak: 'break-word',
              position: 'relative', boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                <div style={{ fontSize: '0.95rem', lineHeight: '1.4' }}>{msg.text}</div>
                {isMe && (
                  <button onClick={() => deleteMessage(msg.messageId)} style={{
                    background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)',
                    cursor: 'pointer', fontSize: '0.7rem', marginTop: '2px',
                  }}>✕</button>
                )}
              </div>
              <div style={{
                fontSize: '0.65rem',
                color: isMe ? 'rgba(255,255,255,0.6)' : 'var(--text-muted)',
                marginTop: '0.2rem', textAlign: isMe ? 'right' : 'left',
              }}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div style={{
        padding: '0.75rem 1rem 1.5rem 1rem',
        backgroundColor: 'color-mix(in srgb, var(--primary-color), white 75%)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderTop: '2px solid var(--primary-color)',
      }}>
        <form onSubmit={sendMessage} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="text" value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={keyError ? 'Secure channel unavailable' : 'Type a message...'}
            disabled={!!keyError}
            className="input-field"
            style={{
              marginBottom: 0, flexGrow: 1, borderRadius: '24px', paddingLeft: '1.25rem',
              backgroundColor: 'var(--surface-color)', border: '1px solid var(--border-color)',
              color: 'var(--text-main)',
            }}
          />
          <button type="submit" className="btn" style={{
            width: '45px', height: '45px', borderRadius: '50%', padding: 0, minWidth: '45px',
            backgroundColor: input.trim() && !keyError ? 'var(--primary-color)' : 'rgba(255,255,255,0.1)',
            transition: 'background-color 0.3s',
          }} disabled={!input.trim() || !!keyError}>
            ↑
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChatRoom;
