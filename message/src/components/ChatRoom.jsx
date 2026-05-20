import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { cryptoUtils } from '../utils/crypto';
import { dbUtils } from '../utils/db';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useChat } from '../ChatContext';

const IMG_PREFIX = '_img_:';
const FILE_PREFIX = '_file_:';

const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const extractStoragePath = (text) => {
  if (text?.startsWith(IMG_PREFIX)) return text.substring(IMG_PREFIX.length);
  if (text?.startsWith(FILE_PREFIX)) {
    const content = text.substring(FILE_PREFIX.length);
    return content.substring(0, content.indexOf('|'));
  }
  return null;
};

const saveFile = async (blob, fileName) => {
  const file = new File([blob], fileName, { type: blob.type });
  // 모바일에서만 Web Share API 사용 (데스크탑은 <a download>로 충분)
  if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
      // 사용자가 공유 시트를 취소한 경우 — 정상
    }
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const ReceivedImage = ({ filePath }) => {
  const [state, setState] = useState('idle'); // idle | loading | loaded | expired
  const [blobUrl, setBlobUrl] = useState(null);
  const blobRef = useRef(null);

  const handleView = async () => {
    setState('loading');
    try {
      const { data, error } = await supabase.storage
        .from('chat-images')
        .createSignedUrl(filePath, 30);

      if (error || !data?.signedUrl) { setState('expired'); return; }

      const res = await fetch(data.signedUrl);
      if (!res.ok) { setState('expired'); return; }

      const blob = await res.blob();
      blobRef.current = blob;
      setBlobUrl(URL.createObjectURL(blob));
      setState('loaded');

      await supabase.storage.from('chat-images').remove([filePath]);
    } catch {
      setState('expired');
    }
  };

  if (state === 'idle') return (
    <button onClick={handleView} style={{
      background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
      borderRadius: '10px', padding: '0.5rem 0.8rem', cursor: 'pointer',
      color: 'inherit', fontSize: '0.9rem',
    }}>📷 사진 보기</button>
  );
  if (state === 'loading') return <span style={{ opacity: 0.6 }}>불러오는 중...</span>;
  if (state === 'expired') return <span style={{ opacity: 0.5 }}>📷 이미지 만료됨</span>;
  return (
    <div>
      <img src={blobUrl} alt="received" style={{ maxWidth: '220px', borderRadius: '10px', display: 'block' }} />
      <button onClick={() => saveFile(blobRef.current, 'photo.jpg')} style={{
        marginTop: '0.4rem', background: 'rgba(255,255,255,0.2)', border: 'none',
        borderRadius: '8px', padding: '4px 10px', cursor: 'pointer',
        color: 'inherit', fontSize: '0.8rem',
      }}>저장</button>
    </div>
  );
};

const ReceivedFile = ({ filePath, fileName }) => {
  // idle → fetching → ready(blob in ref) → done | expired
  const [state, setState] = useState('idle');
  const blobRef = useRef(null);

  // 1단계: 파일 fetch (gesture 불필요)
  const handleFetch = async () => {
    setState('fetching');
    try {
      const { data, error } = await supabase.storage
        .from('chat-images')
        .createSignedUrl(filePath, 60);
      if (error || !data?.signedUrl) { setState('expired'); return; }

      const res = await fetch(data.signedUrl);
      if (!res.ok) { setState('expired'); return; }

      blobRef.current = await res.blob();
      setState('ready');
      await supabase.storage.from('chat-images').remove([filePath]);
    } catch {
      setState('expired');
    }
  };

  // 2단계: 저장 (fresh user gesture → navigator.share 안전)
  const handleSave = async () => {
    try {
      await saveFile(blobRef.current, fileName);
      setState('done');
    } catch {
      alert('저장에 실패했습니다.');
    }
  };

  if (state === 'expired') return <span style={{ opacity: 0.5 }}>📎 파일 만료됨</span>;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <span style={{ fontSize: '1.4rem' }}>📎</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.85rem', fontWeight: '600', wordBreak: 'break-all' }}>{fileName}</div>
        <button
          onClick={state === 'ready' ? handleSave : state === 'idle' ? handleFetch : undefined}
          disabled={state === 'fetching' || state === 'done'}
          style={{
            marginTop: '0.3rem', background: 'rgba(255,255,255,0.2)', border: 'none',
            borderRadius: '8px', padding: '3px 10px',
            cursor: (state === 'fetching' || state === 'done') ? 'default' : 'pointer',
            color: 'inherit', fontSize: '0.8rem',
          }}
        >
          {state === 'fetching' ? '불러오는 중...' : state === 'ready' ? '저장하기' : state === 'done' ? '저장 완료' : '다운로드'}
        </button>
      </div>
    </div>
  );
};

const AI_AGENT_ID = 'a04fce0a-02f8-4040-962a-22d7d98851f0';
const AI_PREFIX = '_ai_:';

const ChatRoom = ({ session }) => {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [encKey, setEncKey] = useState(null);
  const [sigKey, setSigKey] = useState(null);
  const [friendProfile, setFriendProfile] = useState(null);
  const [keyError, setKeyError] = useState(null);
  const [isAiRoom, setIsAiRoom] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // null | { done, total }
  const messagesEndRef = useRef(null);
  const channelRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const { setActiveRoom, markAsRead } = useChat();

  const myId = session.user.id;
  const friendId = roomId.split('_').find(id => id !== myId);

  useEffect(() => {
    setActiveRoom(roomId);

    const init = async () => {
      const localMsgs = await dbUtils.getMessagesByRoom(roomId);
      setMessages(localMsgs);

      const privateKey = await dbUtils.getSecret('ecdh_private_key');
      if (!privateKey) {
        setKeyError('Local key missing. Please log out and log in again.');
        return;
      }

      if (friendId === AI_AGENT_ID) {
        const { data: aiProfile } = await supabase
          .from('profiles')
          .select('username, avatar_url')
          .eq('id', friendId)
          .single();
        setFriendProfile(aiProfile);
        setIsAiRoom(true);
        return;
      }

      const { data } = await supabase
        .from('profiles')
        .select('username, public_key, avatar_url')
        .eq('id', friendId)
        .single();
      setFriendProfile(data);

      if (!data?.public_key) {
        setKeyError('Friend has not set up secure messaging yet. Ask them to log in again.');
        return;
      }

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
        if (sender !== friendId) return;

        try {
          if (!await cryptoUtils.verify(sigKey, { sender, roomId, messageId, timestamp }, sig)) return;
          const text = await cryptoUtils.decrypt(encryptedText, encKey);
          const newMsg = { messageId, roomId, sender, text, timestamp, read: true, recipientRead: false };
          await dbUtils.saveMessage(newMsg);
          setMessages(prev => prev.find(m => m.messageId === messageId) ? prev : [...prev, newMsg]);

          // Send read receipt back to sender
          markAsRead(roomId);
          const readPayload = {
            type: 'broadcast',
            event: 'read_receipt',
            payload: { roomId, readerId: myId },
          };
          if (channelRef.current) channelRef.current.send(readPayload);
          const userChannel = supabase.channel(`user:${sender}`);
          userChannel.subscribe(async (s) => {
            if (s === 'SUBSCRIBED') {
              await userChannel.send(readPayload);
              setTimeout(() => supabase.removeChannel(userChannel), 1000);
            }
          });
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

      } else if (event === 'read_receipt') {
        const { roomId: rId, readerId } = payload;
        if (rId === roomId && readerId === friendId) {
          setMessages(prev => prev.map(m =>
            m.sender === myId ? { ...m, recipientRead: true } : m
          ));
        }
      }
    }).subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('Joined room:', roomId);
        // Notify sender that we've read their messages
        const readPayload = {
          type: 'broadcast',
          event: 'read_receipt',
          payload: { roomId, readerId: myId },
        };
        channel.send(readPayload);
        const userChannel = supabase.channel(`user:${friendId}`);
        userChannel.subscribe(async (s) => {
          if (s === 'SUBSCRIBED') {
            await userChannel.send(readPayload);
            setTimeout(() => supabase.removeChannel(userChannel), 1000);
          }
        });
      }
    });

    return () => supabase.removeChannel(channel);
  }, [encKey, sigKey, roomId, friendId]);

  // Poll for AI Friend responses every 2 seconds
  useEffect(() => {
    if (!isAiRoom) return;
    const poll = async () => {
      const { data } = await supabase
        .from('pending_messages')
        .select('*')
        .eq('room_id', roomId)
        .eq('sender_id', AI_AGENT_ID)
        .order('timestamp', { ascending: true });
      if (data?.length > 0) {
        for (const row of data) {
          const text = row.encrypted_payload?.startsWith(AI_PREFIX)
            ? row.encrypted_payload.slice(AI_PREFIX.length)
            : row.encrypted_payload;
          const newMsg = { messageId: row.message_id, roomId, sender: row.sender_id, text, timestamp: row.timestamp, read: true, recipientRead: true };
          await dbUtils.saveMessage(newMsg);
          setMessages(prev => prev.find(m => m.messageId === row.message_id) ? prev : [...prev, newMsg]);
        }
        await supabase.from('pending_messages').delete().in('id', data.map(r => r.id));
      }
    };
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [isAiRoom, roomId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendImage = async (file) => {
    const ext = file.name.split('.').pop() || 'jpg';
    const filePath = `${roomId}/${window.crypto.randomUUID()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('chat-images')
      .upload(filePath, file, { contentType: file.type });
    if (uploadError) throw uploadError;

    const localImageUrl = URL.createObjectURL(file);
    const messageText = `${IMG_PREFIX}${filePath}`;
    const encryptedText = await cryptoUtils.encrypt(messageText, encKey);
    const messageId = window.crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const sender = myId;
    const sig = await cryptoUtils.sign(sigKey, { sender, roomId, messageId, timestamp });

    const broadcastPayload = {
      type: 'broadcast', event: 'message',
      payload: { sender, encryptedText, roomId, messageId, timestamp, sig },
    };

    const myMessage = { messageId, roomId, sender, text: messageText, timestamp, read: true, recipientRead: false, localImageUrl };
    await dbUtils.saveMessage(myMessage);
    setMessages(prev => [...prev, myMessage]);

    if (channelRef.current) channelRef.current.send(broadcastPayload);
    const userChannel = supabase.channel(`user:${friendId}`);
    userChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await userChannel.send(broadcastPayload);
        setTimeout(() => supabase.removeChannel(userChannel), 1000);
      }
    });

    await supabase.from('pending_messages').insert({
      sender_id: sender, receiver_id: friendId,
      room_id: roomId, encrypted_payload: encryptedText,
      message_id: messageId, timestamp,
    });
  };

  const sendFile = async (file) => {
    const ext = file.name.split('.').pop() || 'bin';
    const filePath = `files/${roomId}/${window.crypto.randomUUID()}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('chat-images')
      .upload(filePath, file, { contentType: file.type });
    if (uploadError) throw uploadError;

    const messageText = `${FILE_PREFIX}${filePath}|${file.name}`;
    const encryptedText = await cryptoUtils.encrypt(messageText, encKey);
    const messageId = window.crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const sender = myId;
    const sig = await cryptoUtils.sign(sigKey, { sender, roomId, messageId, timestamp });

    const broadcastPayload = {
      type: 'broadcast', event: 'message',
      payload: { sender, encryptedText, roomId, messageId, timestamp, sig },
    };

    const myMessage = { messageId, roomId, sender, text: messageText, timestamp, read: true, recipientRead: false };
    await dbUtils.saveMessage(myMessage);
    setMessages(prev => [...prev, myMessage]);

    if (channelRef.current) channelRef.current.send(broadcastPayload);
    const userChannel = supabase.channel(`user:${friendId}`);
    userChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await userChannel.send(broadcastPayload);
        setTimeout(() => supabase.removeChannel(userChannel), 1000);
      }
    });

    await supabase.from('pending_messages').insert({
      sender_id: sender, receiver_id: friendId,
      room_id: roomId, encrypted_payload: encryptedText,
      message_id: messageId, timestamp,
    });
  };

  const sendFiles = async (files) => {
    if (!encKey || !sigKey || files.length === 0) return;
    const limited = Array.from(files).slice(0, 10);
    setUploadProgress({ done: 0, total: limited.length });
    let failed = 0;
    for (const file of limited) {
      try {
        await sendFile(file);
      } catch (e) {
        console.error('File send error:', e);
        failed++;
      }
      setUploadProgress(prev => ({ ...prev, done: prev.done + 1 }));
    }
    setUploadProgress(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (failed > 0) alert(`${failed}개 파일 전송에 실패했습니다.`);
  };

  const sendImages = async (files) => {
    if (!encKey || !sigKey || files.length === 0) return;
    const limited = Array.from(files).slice(0, 10);
    setUploadProgress({ done: 0, total: limited.length });
    let failed = 0;
    for (const file of limited) {
      try {
        await sendImage(file);
      } catch (e) {
        console.error('Image send error:', e);
        failed++;
      }
      setUploadProgress(prev => ({ ...prev, done: prev.done + 1 }));
    }
    setUploadProgress(null);
    if (imageInputRef.current) imageInputRef.current.value = '';
    if (failed > 0) alert(`${failed}장 전송에 실패했습니다.`);
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    if (!isAiRoom && (!encKey || !sigKey)) return;
    const ta = e.target.closest?.('form')?.querySelector('textarea');
    if (ta) ta.style.height = 'auto';

    if (isAiRoom) {
      try {
        const messageId = window.crypto.randomUUID();
        const timestamp = new Date().toISOString();
        const myMessage = { messageId, roomId, sender: myId, text: input, timestamp, read: true, recipientRead: false };
        await dbUtils.saveMessage(myMessage);
        setMessages(prev => [...prev, myMessage]);
        setInput('');
        await supabase.from('pending_messages').insert({
          sender_id: myId, receiver_id: friendId,
          room_id: roomId, encrypted_payload: `${AI_PREFIX}${input}`,
          message_id: messageId, timestamp,
        });
      } catch (err) {
        console.error('AI send error:', err);
      }
      return;
    }

    try {
      const encryptedText = await cryptoUtils.encrypt(input, encKey);
      const messageId = window.crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const sender = myId;

      const sig = await cryptoUtils.sign(sigKey, { sender, roomId, messageId, timestamp });

      const broadcastPayload = {
        type: 'broadcast',
        event: 'message',
        payload: { sender, encryptedText, roomId, messageId, timestamp, sig },
      };

      const myMessage = { messageId, roomId, sender, text: input, timestamp, read: true, recipientRead: false };
      await dbUtils.saveMessage(myMessage);
      setMessages(prev => [...prev, myMessage]);
      setInput('');

      if (channelRef.current) channelRef.current.send(broadcastPayload);

      const userChannel = supabase.channel(`user:${friendId}`);
      userChannel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await userChannel.send(broadcastPayload);
          setTimeout(() => supabase.removeChannel(userChannel), 1000);
        }
      });

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
      const msg = messages.find(m => m.messageId === messageId);
      const storagePath = msg ? extractStoragePath(msg.text) : null;

      setMessages(prev => prev.filter(m => m.messageId !== messageId));
      await dbUtils.deleteMessage(messageId);

      if (storagePath) {
        await supabase.storage.from('chat-images').remove([storagePath]);
      }

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

      const storagePaths = messages.map(m => extractStoragePath(m.text)).filter(Boolean);
      if (storagePaths.length > 0) {
        await supabase.storage.from('chat-images').remove(storagePaths);
      }
    } catch (e) {
      console.error('Error clearing chat:', e);
    }
  };

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', maxWidth: '50%', overflow: 'hidden' }}>
          <div style={{
            width: '41px', height: '41px', borderRadius: '10px', flexShrink: 0,
            backgroundImage: `url(${friendProfile?.avatar_url || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(friendProfile?.username || friendId)}`})`,
            backgroundSize: '39px 39px', backgroundPosition: 'center 30%',
            backgroundColor: 'var(--surface-color)',
          }} />
          <h2 style={{
            margin: 0, fontSize: '1.1rem', fontWeight: '700',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {friendProfile?.username || 'Loading...'}
          </h2>
        </div>
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
                <div style={{ fontSize: '0.95rem', lineHeight: '1.4' }}>
                  {msg.text?.startsWith(IMG_PREFIX) ? (
                    isMe ? (
                      msg.localImageUrl
                        ? <img src={msg.localImageUrl} alt="sent" style={{ maxWidth: '220px', borderRadius: '10px', display: 'block' }} onError={(e) => { e.target.replaceWith(Object.assign(document.createElement('span'), { textContent: '📷 사진 전송됨', style: 'opacity:0.6' })); }} />
                        : <span style={{ opacity: 0.6 }}>📷 사진 전송됨</span>
                    ) : (
                      <ReceivedImage filePath={msg.text.substring(IMG_PREFIX.length)} />
                    )
                  ) : msg.text?.startsWith(FILE_PREFIX) ? (() => {
                    const content = msg.text.substring(FILE_PREFIX.length);
                    const sepIdx = content.indexOf('|');
                    const filePath = content.substring(0, sepIdx);
                    const fileName = content.substring(sepIdx + 1);
                    return isMe
                      ? <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><span style={{ fontSize: '1.4rem' }}>📎</span><span style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>{fileName}</span></div>
                      : <ReceivedFile filePath={filePath} fileName={fileName} />;
                  })() : (
                    msg.text
                  )}
                </div>
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
                marginTop: '0.2rem',
                textAlign: isMe ? 'right' : 'left',
                display: 'flex',
                justifyContent: isMe ? 'flex-end' : 'flex-start',
                alignItems: 'center',
                gap: '4px',
              }}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {isMe && !msg.recipientRead && (
                  <span style={{ fontSize: '0.6rem' }}>✓</span>
                )}
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
        <form onSubmit={sendMessage} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files?.length) sendImages(e.target.files); }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files?.length) sendFiles(e.target.files); }}
          />
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            disabled={(!isAiRoom && !!keyError) || !!uploadProgress}
            style={{
              width: '45px', height: '45px', borderRadius: '50%', padding: 0, minWidth: '45px',
              backgroundColor: 'rgba(255,255,255,0.1)', border: 'none', cursor: 'pointer',
              fontSize: uploadProgress ? '0.7rem' : '1.2rem', flexShrink: 0, color: 'var(--text-main)',
            }}
          >
            {uploadProgress ? `${uploadProgress.done}/${uploadProgress.total}` : '📷'}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={(!isAiRoom && !!keyError) || !!uploadProgress}
            style={{
              width: '45px', height: '45px', borderRadius: '50%', padding: 0, minWidth: '45px',
              backgroundColor: 'rgba(255,255,255,0.1)', border: 'none', cursor: 'pointer',
              fontSize: '1.2rem', flexShrink: 0, color: 'var(--text-main)',
            }}
          >
            📎
          </button>
          <textarea
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(e);
              }
            }}
            placeholder={(!isAiRoom && keyError) ? 'Secure channel unavailable' : 'Type a message... (Shift+Enter: 줄바꿈)'}
            disabled={!isAiRoom && !!keyError}
            className="input-field"
            style={{
              marginBottom: 0, flexGrow: 1, borderRadius: '16px', paddingLeft: '1.25rem',
              paddingTop: '0.65rem', paddingBottom: '0.65rem',
              backgroundColor: 'var(--surface-color)', border: '1px solid var(--border-color)',
              color: 'var(--text-main)', resize: 'none', overflow: 'hidden',
              lineHeight: '1.5', fontFamily: 'inherit', fontSize: 'inherit',
            }}
          />
          <button type="submit" className="btn" style={{
            width: '45px', height: '45px', borderRadius: '50%', padding: 0, minWidth: '45px',
            backgroundColor: input.trim() && (isAiRoom || !keyError) ? 'var(--primary-color)' : 'rgba(255,255,255,0.1)',
            transition: 'background-color 0.3s',
          }} disabled={!input.trim() || (!isAiRoom && !!keyError)}>
            ↑
          </button>
        </form>
      </div>
    </div>
  );
};

export default ChatRoom;
