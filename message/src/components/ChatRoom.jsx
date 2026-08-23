import React, { useEffect, useState, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { cryptoUtils } from '../utils/crypto';
import { dbUtils } from '../utils/db';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useChat } from '../ChatContext';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const IMG_PREFIX = '_img_:';
const FILE_PREFIX = '_file_:';

// **bold**한국어 패턴: 닫힘 ** 바로 뒤 한국어는 zero-width space 삽입해 파싱 보정
const fixMarkdown = (text) => {
  if (!text) return text;
  return text.replace(/(\*{1,2}[^*]+\*{1,2})([가-힣])/g, '$1​$2');
};

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

const CopyButton = ({ text, isMe }) => {
  const [copied, setCopied] = useState(false);
  const handle = async (e) => {
    e.stopPropagation();
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button onClick={handle} style={{
      background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px',
      color: copied
        ? 'var(--primary-color)'
        : isMe ? 'rgba(255,255,255,0.6)' : 'var(--text-muted)',
      fontSize: '0.65rem',
    }}>
      {copied ? '✓' : '복사'}
    </button>
  );
};

// 암호화 첨부파일 복호화 — 평문(AI 발신·구버전) 파일은 그대로 반환
const decryptBlob = async (buffer, encKey) => {
  if (encKey) {
    try {
      return new Blob([await cryptoUtils.decryptBytes(buffer, encKey)]);
    } catch { /* 평문 파일 — fallthrough */ }
  }
  return new Blob([buffer]);
};

const ReceivedImage = ({ filePath, encKey }) => {
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

      const blob = await decryptBlob(await res.arrayBuffer(), encKey);
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

const ReceivedFile = ({ filePath, fileName, encKey }) => {
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

      blobRef.current = await decryptBlob(await res.arrayBuffer(), encKey);
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
  const [aiProcessing, setAiProcessing] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // null | { done, total }
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]); // [{file, type:'image'|'file', previewUrl}]
  const messagesEndRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const attachMenuRef = useRef(null);
  const { setActiveRoom } = useChat();

  const myId = session.user.id;
  const friendId = roomId.split('_').find(id => id !== myId);

  // 읽음 확인 전송: pending row insert → DB 트리거가 상대 채널로 broadcast
  const sendReadReceipt = () => {
    supabase.from('pending_messages').insert({
      sender_id: myId, receiver_id: friendId, room_id: roomId,
      encrypted_payload: '', message_id: window.crypto.randomUUID(),
      timestamp: new Date().toISOString(), event: 'read_receipt',
    }).then(({ error }) => { if (error) console.error('Read receipt failed:', error); });
  };

  // ChatContext 가 검증·복호화·저장까지 마친 이벤트를 받아 화면만 갱신
  const handleRoomEvent = (evt) => {
    if (evt.type === 'message') {
      setMessages(prev => prev.find(m => m.messageId === evt.message.messageId) ? prev : [...prev, evt.message]);
      sendReadReceipt();
    } else if (evt.type === 'delete') {
      setMessages(prev => prev.filter(m => m.messageId !== evt.messageId));
    } else if (evt.type === 'clear') {
      setMessages([]);
    } else if (evt.type === 'read') {
      setMessages(prev => prev.map(m => m.sender === myId ? { ...m, recipientRead: true } : m));
    } else if (evt.type === 'ai_status') {
      // 같은 messageId 로 갱신되는 진행 상태 버블
      setAiProcessing(true);
      setMessages(prev => {
        const exists = prev.find(m => m.messageId === evt.message.messageId);
        if (exists) return prev.map(m => m.messageId === evt.message.messageId ? evt.message : m);
        return [...prev, evt.message];
      });
    } else if (evt.type === 'ai_message') {
      setAiProcessing(false);
      setMessages(prev => {
        const withoutStatus = prev.filter(m => !m.isStatus);
        return withoutStatus.find(m => m.messageId === evt.message.messageId)
          ? withoutStatus : [...withoutStatus, evt.message];
      });
      // 탭이 백그라운드일 때 브라우저 알림 표시
      if (document.hidden && Notification.permission === 'granted') {
        new Notification('AI Friend 💬', {
          body: evt.message.text.replace(/[#*`_~]/g, '').slice(0, 120),
          icon: '/freeChat/icon.png',
          tag: 'ai-msg',
        });
      }
    }
  };

  useEffect(() => {
    setActiveRoom(roomId, handleRoomEvent);

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
        // 방 진입을 상대에게 알림 (밀린 메시지 읽음 처리)
        sendReadReceipt();
      } catch (e) {
        setKeyError('Failed to establish secure channel.');
        console.error('[ChatRoom] Key derivation failed:', e);
      }
    };

    init();
    return () => setActiveRoom(null);
  }, [roomId, friendId]);

  // 알림 권한 요청 (최초 1회)
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (!showAttachMenu) return;
    const handler = (e) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target)) {
        setShowAttachMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAttachMenu]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendImage = async (file) => {
    const ext = file.name.split('.').pop() || 'jpg';
    const filePath = `${roomId}/${window.crypto.randomUUID()}.${ext}`;

    // 첨부파일도 방 키로 E2E 암호화 후 업로드 (서버에는 암호문만 저장)
    const encBytes = await cryptoUtils.encryptBytes(await file.arrayBuffer(), encKey);
    const { error: uploadError } = await supabase.storage
      .from('chat-images')
      .upload(filePath, new Blob([encBytes]), { contentType: 'application/octet-stream' });
    if (uploadError) throw uploadError;

    const localImageUrl = URL.createObjectURL(file);
    const messageText = `${IMG_PREFIX}${filePath}`;
    const encryptedText = await cryptoUtils.encrypt(messageText, encKey);
    const messageId = window.crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const sender = myId;
    const sig = await cryptoUtils.sign(sigKey, { sender, roomId, messageId, encryptedText });

    const myMessage = { messageId, roomId, sender, text: messageText, timestamp, read: true, recipientRead: false, localImageUrl };
    await dbUtils.saveMessage(myMessage);
    setMessages(prev => [...prev, myMessage]);

    const { error: insErr } = await supabase.from('pending_messages').insert({
      sender_id: sender, receiver_id: friendId,
      room_id: roomId, encrypted_payload: encryptedText,
      message_id: messageId, timestamp, sig, event: 'message',
    });
    if (insErr) throw insErr;
  };

  const sendFile = async (file) => {
    const ext = file.name.split('.').pop() || 'bin';
    const filePath = `files/${roomId}/${window.crypto.randomUUID()}.${ext}`;

    // 첨부파일도 방 키로 E2E 암호화 후 업로드 (서버에는 암호문만 저장)
    const encBytes = await cryptoUtils.encryptBytes(await file.arrayBuffer(), encKey);
    const { error: uploadError } = await supabase.storage
      .from('chat-images')
      .upload(filePath, new Blob([encBytes]), { contentType: 'application/octet-stream' });
    if (uploadError) throw uploadError;

    const messageText = `${FILE_PREFIX}${filePath}|${file.name}`;
    const encryptedText = await cryptoUtils.encrypt(messageText, encKey);
    const messageId = window.crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const sender = myId;
    const sig = await cryptoUtils.sign(sigKey, { sender, roomId, messageId, encryptedText });

    const myMessage = { messageId, roomId, sender, text: messageText, timestamp, read: true, recipientRead: false };
    await dbUtils.saveMessage(myMessage);
    setMessages(prev => [...prev, myMessage]);

    const { error: insErr } = await supabase.from('pending_messages').insert({
      sender_id: sender, receiver_id: friendId,
      room_id: roomId, encrypted_payload: encryptedText,
      message_id: messageId, timestamp, sig, event: 'message',
    });
    if (insErr) throw insErr;
  };

  const sendAiImage = async (file) => {
    const ext = file.name.split('.').pop() || 'jpg';
    const filePath = `${roomId}/${window.crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('chat-images')
      .upload(filePath, file, { contentType: file.type });
    if (uploadError) throw uploadError;

    const localImageUrl = URL.createObjectURL(file);
    const messageText = `${IMG_PREFIX}${filePath}`;
    const messageId = window.crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const myMessage = { messageId, roomId, sender: myId, text: messageText, timestamp, read: true, recipientRead: false, localImageUrl };
    await dbUtils.saveMessage(myMessage);
    setMessages(prev => [...prev, myMessage]);
    await supabase.from('pending_messages').insert({
      sender_id: myId, receiver_id: friendId,
      room_id: roomId, encrypted_payload: `${AI_PREFIX}${IMG_PREFIX}${filePath}`,
      message_id: messageId, timestamp,
    });
    setAiProcessing(true);
  };

  const sendAiFile = async (file) => {
    const ext = file.name.split('.').pop() || 'bin';
    const filePath = `files/${roomId}/${window.crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('chat-images')
      .upload(filePath, file, { contentType: file.type });
    if (uploadError) throw uploadError;

    const messageText = `${FILE_PREFIX}${filePath}|${file.name}`;
    const messageId = window.crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const myMessage = { messageId, roomId, sender: myId, text: messageText, timestamp, read: true, recipientRead: false };
    await dbUtils.saveMessage(myMessage);
    setMessages(prev => [...prev, myMessage]);
    await supabase.from('pending_messages').insert({
      sender_id: myId, receiver_id: friendId,
      room_id: roomId, encrypted_payload: `${AI_PREFIX}${FILE_PREFIX}${filePath}|${file.name}`,
      message_id: messageId, timestamp,
    });
    setAiProcessing(true);
  };

  const sendFiles = async (files) => {
    if (!isAiRoom && (!encKey || !sigKey)) return;
    if (files.length === 0) return;
    const limited = Array.from(files).slice(0, 10);
    setUploadProgress({ done: 0, total: limited.length });
    let failed = 0;
    for (const file of limited) {
      try {
        if (isAiRoom) await sendAiFile(file);
        else await sendFile(file);
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
    if (!isAiRoom && (!encKey || !sigKey)) return;
    if (files.length === 0) return;
    const limited = Array.from(files).slice(0, 10);
    setUploadProgress({ done: 0, total: limited.length });
    let failed = 0;
    for (const file of limited) {
      try {
        if (isAiRoom) await sendAiImage(file);
        else await sendImage(file);
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

  const stopAiProcessing = async () => {
    setAiProcessing(false);
    setMessages(prev => prev.filter(m => !m.isStatus));
    await supabase.from('pending_messages').insert({
      sender_id: myId, receiver_id: AI_AGENT_ID,
      room_id: roomId, encrypted_payload: '_ai_stop_:',
      message_id: window.crypto.randomUUID(), timestamp: new Date().toISOString(),
    });
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() && pendingFiles.length === 0) return;
    if (!isAiRoom && (!encKey || !sigKey)) return;
    const ta = e.target.closest?.('form')?.querySelector('textarea');
    if (ta) ta.style.height = 'auto';

    if (isAiRoom) {
      try {
        // 텍스트 메시지 전송
        if (input.trim()) {
          const messageId = window.crypto.randomUUID();
          const timestamp = new Date().toISOString();
          const myMessage = { messageId, roomId, sender: myId, text: input, timestamp, read: true, recipientRead: false };
          await dbUtils.saveMessage(myMessage);
          setMessages(prev => [...prev, myMessage]);
          await supabase.from('pending_messages').insert({
            sender_id: myId, receiver_id: friendId,
            room_id: roomId, encrypted_payload: `${AI_PREFIX}${input}`,
            message_id: messageId, timestamp,
          });
        }
        setInput('');
        // pendingFiles 전송
        if (pendingFiles.length > 0) {
          const images = pendingFiles.filter(f => f.type === 'image').map(f => f.file);
          const files  = pendingFiles.filter(f => f.type === 'file').map(f => f.file);
          if (images.length) await sendImages(images);
          if (files.length)  await sendFiles(files);
          pendingFiles.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
          setPendingFiles([]);
        }
        setAiProcessing(true);
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

      const sig = await cryptoUtils.sign(sigKey, { sender, roomId, messageId, encryptedText });

      const myMessage = { messageId, roomId, sender, text: input, timestamp, read: true, recipientRead: false };
      await dbUtils.saveMessage(myMessage);
      setMessages(prev => [...prev, myMessage]);
      setInput('');

      const { error: insErr } = await supabase.from('pending_messages').insert({
        sender_id: sender,
        receiver_id: friendId,
        room_id: roomId,
        encrypted_payload: encryptedText,
        message_id: messageId,
        timestamp,
        sig,
        event: 'message',
      });
      if (insErr) console.error('Pending insert failed:', insErr);

      // pendingFiles 전송 (일반 채팅)
      if (pendingFiles.length > 0) {
        const images = pendingFiles.filter(f => f.type === 'image').map(f => f.file);
        const files  = pendingFiles.filter(f => f.type === 'file').map(f => f.file);
        if (images.length) await sendImages(images);
        if (files.length)  await sendFiles(files);
        pendingFiles.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
        setPendingFiles([]);
      }
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

      // 미전달 원본을 먼저 회수한 뒤 삭제 지시 row 전송 (같은 message_id 재사용)
      await supabase.from('pending_messages').delete().eq('message_id', messageId);
      await supabase.from('pending_messages').insert({
        sender_id: sender, receiver_id: friendId, room_id: roomId,
        encrypted_payload: '', message_id: messageId,
        timestamp: new Date().toISOString(), sig, event: 'delete_message',
      });
    } catch (e) {
      console.error('Error deleting message:', e);
    }
  };

  const clearChat = async () => {
    if (!isAiRoom && !sigKey) return;
    if (!window.confirm('ARE YOU SURE? This will delete ALL messages for BOTH participants FOREVER.')) return;

    try {
      if (isAiRoom) {
        // 1) IndexedDB에서 현재 대화 읽기
        const allMsgs = await dbUtils.getMessagesByRoom(roomId);
        if (allMsgs.length > 0) {
          // 2) JSON 파일로 다운로드 저장
          const now = new Date();
          const pad = n => String(n).padStart(2, '0');
          const filename = `chat_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
          const exportData = {
            saved_at: now.toISOString(),
            room_id: roomId,
            messages: allMsgs.map(m => ({
              role: m.sender === myId ? 'user' : 'assistant',
              sender: m.sender,
              content: m.text,
              timestamp: m.timestamp,
            })),
          };
          const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);

          // 3) agent_server conversation 초기화 신호
          await supabase.from('pending_messages').insert({
            sender_id: myId, receiver_id: AI_AGENT_ID,
            room_id: roomId, encrypted_payload: '_ai_clear_history_:',
            message_id: window.crypto.randomUUID(), timestamp: new Date().toISOString(),
          });
        }
      }

      setMessages([]);
      await dbUtils.clearRoomMessages(roomId);
      await supabase.from('pending_messages').delete().eq('room_id', roomId);

      if (isAiRoom) return;

      if (!isAiRoom) {
        const sender = myId;
        const sig = await cryptoUtils.sign(sigKey, { sender, roomId });

        const storagePaths = messages.map(m => extractStoragePath(m.text)).filter(Boolean);
        if (storagePaths.length > 0) {
          await supabase.storage.from('chat-images').remove(storagePaths);
        }

        // 전체 삭제 지시 row 전송 (위에서 방 전체 pending 삭제 후 insert)
        await supabase.from('pending_messages').insert({
          sender_id: sender, receiver_id: friendId, room_id: roomId,
          encrypted_payload: '', message_id: window.crypto.randomUUID(),
          timestamp: new Date().toISOString(), sig, event: 'clear_chat',
        });
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

          if (msg.isStatus) {
            return (
              <div key={i} style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{
                  backgroundColor: 'var(--surface-color)', color: 'var(--text-muted)',
                  padding: '0.5rem 0.9rem', borderRadius: '18px 18px 18px 4px',
                  fontSize: '0.85rem', boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                }}>
                  <span style={{ display: 'inline-block', animation: 'ai-spin 1s linear infinite', fontSize: '0.9rem' }}>⏳</span>
                  {msg.text}
                </div>
              </div>
            );
          }

          return (
            <div key={i} style={{
              alignSelf: isMe ? 'flex-end' : 'flex-start',
              backgroundColor: isMe ? 'var(--primary-color)' : 'var(--surface-color)',
              color: isMe ? 'white' : 'var(--text-main)',
              padding: '0.6rem 0.9rem',
              borderRadius: isMe ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
              maxWidth: (!isMe && isAiRoom) ? '95%' : '85%', wordBreak: 'break-word',
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
                      <ReceivedImage filePath={msg.text.substring(IMG_PREFIX.length)} encKey={encKey} />
                    )
                  ) : msg.text?.startsWith(FILE_PREFIX) ? (() => {
                    const content = msg.text.substring(FILE_PREFIX.length);
                    const sepIdx = content.indexOf('|');
                    const filePath = content.substring(0, sepIdx);
                    const fileName = content.substring(sepIdx + 1);
                    return isMe
                      ? <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><span style={{ fontSize: '1.4rem' }}>📎</span><span style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>{fileName}</span></div>
                      : <ReceivedFile filePath={filePath} fileName={fileName} encKey={encKey} />;
                  })() : (!isMe && isAiRoom) ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      children={fixMarkdown(msg.text)}
                      components={{
                        p: ({ children }) => <p style={{ margin: '0 0 0.5em 0' }}>{children}</p>,
                        ul: ({ children }) => <ul style={{ margin: '0.3em 0', paddingLeft: '1.3em' }}>{children}</ul>,
                        ol: ({ children }) => <ol style={{ margin: '0.3em 0', paddingLeft: '1.3em' }}>{children}</ol>,
                        li: ({ children }) => <li style={{ margin: '0.15em 0' }}>{children}</li>,
                        code: ({ inline, children }) => inline
                          ? <code style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '4px', padding: '0 4px', fontFamily: 'monospace', fontSize: '0.88em' }}>{children}</code>
                          : <pre style={{ background: 'rgba(0,0,0,0.25)', borderRadius: '8px', padding: '0.6em 0.8em', overflowX: 'auto', margin: '0.4em 0' }}><code style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>{children}</code></pre>,
                        strong: ({ children }) => <strong style={{ fontWeight: '700' }}>{children}</strong>,
                        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary-color)', textDecoration: 'underline' }}>{children}</a>,
                        blockquote: ({ children }) => <blockquote style={{ borderLeft: '3px solid var(--primary-color)', margin: '0.3em 0', paddingLeft: '0.8em', opacity: 0.85 }}>{children}</blockquote>,
                        h1: ({ children }) => <h3 style={{ margin: '0.4em 0 0.2em', fontSize: '1.1em', fontWeight: '700' }}>{children}</h3>,
                        h2: ({ children }) => <h4 style={{ margin: '0.4em 0 0.2em', fontSize: '1.05em', fontWeight: '700' }}>{children}</h4>,
                        h3: ({ children }) => <h5 style={{ margin: '0.3em 0 0.15em', fontSize: '1em', fontWeight: '700' }}>{children}</h5>,
                        table: ({ children }) => <table style={{ borderCollapse: 'collapse', margin: '0.4em 0', fontSize: '0.88em', width: '100%' }}>{children}</table>,
                        th: ({ children }) => <th style={{ border: '1px solid rgba(255,255,255,0.2)', padding: '4px 8px', background: 'rgba(0,0,0,0.2)' }}>{children}</th>,
                        td: ({ children }) => <td style={{ border: '1px solid rgba(255,255,255,0.15)', padding: '4px 8px' }}>{children}</td>,
                      }}
                    >
                    </ReactMarkdown>
                  ) : (
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
                display: 'flex',
                justifyContent: isMe ? 'flex-end' : 'flex-start',
                alignItems: 'center',
                gap: '6px',
              }}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                {isMe && !msg.recipientRead && (
                  <span style={{ fontSize: '0.6rem' }}>✓</span>
                )}
                {!msg.text?.startsWith(IMG_PREFIX) && !msg.text?.startsWith(FILE_PREFIX) && msg.text && (
                  <CopyButton text={msg.text} isMe={isMe} />
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
        {/* 첨부 파일 미리보기 */}
        {pendingFiles.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
            {pendingFiles.map((pf, idx) => (
              <div key={idx} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                {pf.type === 'image' ? (
                  <img src={pf.previewUrl} alt={pf.file.name}
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border-color)' }} />
                ) : (
                  <div style={{
                    padding: '0.3rem 0.6rem', borderRadius: 8, fontSize: '0.78rem',
                    background: 'var(--surface-color)', border: '1px solid var(--border-color)',
                    maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>📄 {pf.file.name}</div>
                )}
                <button type="button" onClick={() => {
                  if (pf.previewUrl) URL.revokeObjectURL(pf.previewUrl);
                  setPendingFiles(prev => prev.filter((_, i) => i !== idx));
                }} style={{
                  position: 'absolute', top: -6, right: -6,
                  width: 18, height: 18, borderRadius: '50%', border: 'none',
                  background: '#ef4444', color: '#fff', fontSize: '0.7rem',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>✕</button>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={sendMessage} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', position: 'relative' }}>
          <input ref={imageInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files?.length) {
                const newFiles = Array.from(e.target.files).map(f => ({
                  file: f, type: 'image', previewUrl: URL.createObjectURL(f),
                }));
                setPendingFiles(prev => [...prev, ...newFiles]);
                setShowAttachMenu(false);
                e.target.value = '';
              }
            }} />
          <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files?.length) {
                const newFiles = Array.from(e.target.files).map(f => ({
                  file: f, type: 'file', previewUrl: null,
                }));
                setPendingFiles(prev => [...prev, ...newFiles]);
                setShowAttachMenu(false);
                e.target.value = '';
              }
            }} />

          {/* 첨부 메뉴 팝업 */}
          {showAttachMenu && (
            <div ref={attachMenuRef} style={{
              position: 'absolute', bottom: '54px', left: 0,
              display: 'flex', flexDirection: 'column', gap: '0.4rem',
              background: 'var(--surface-color)', border: '1px solid var(--border-color)',
              borderRadius: '12px', padding: '0.5rem',
              boxShadow: '0 4px 16px rgba(0,0,0,0.15)', zIndex: 10,
            }}>
              <button type="button"
                onClick={() => imageInputRef.current?.click()}
                disabled={(!isAiRoom && !!keyError) || !!uploadProgress}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '0.4rem 0.8rem', borderRadius: '8px', color: 'var(--text-main)',
                  fontSize: '0.9rem', whiteSpace: 'nowrap',
                }}>
                <span style={{ fontSize: '1.3rem' }}>📷</span> 사진
              </button>
              <button type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={(!isAiRoom && !!keyError) || !!uploadProgress}
                style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  background: 'none', border: 'none', cursor: 'pointer',
                  padding: '0.4rem 0.8rem', borderRadius: '8px', color: 'var(--text-main)',
                  fontSize: '0.9rem', whiteSpace: 'nowrap',
                }}>
                <span style={{ fontSize: '1.3rem' }}>📎</span> 파일
              </button>
            </div>
          )}

          {/* + 버튼 */}
          <button
            type="button"
            onClick={() => setShowAttachMenu(v => !v)}
            disabled={(!isAiRoom && !!keyError) || !!uploadProgress}
            style={{
              width: '45px', height: '45px', borderRadius: '50%', padding: 0, minWidth: '45px',
              backgroundColor: showAttachMenu ? 'var(--primary-color)' : 'var(--primary-glow)',
              border: '1.5px solid var(--primary-color)', cursor: 'pointer', flexShrink: 0,
              color: showAttachMenu ? 'white' : 'var(--primary-color)',
              fontSize: uploadProgress ? '0.7rem' : '1.4rem',
              transition: 'background-color 0.15s, transform 0.15s',
              transform: showAttachMenu ? 'rotate(45deg)' : 'none',
            }}
          >
            {uploadProgress ? `${uploadProgress.done}/${uploadProgress.total}` : '+'}
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
          {isAiRoom && aiProcessing ? (
            <button type="button" onClick={stopAiProcessing} style={{
              width: '45px', height: '45px', borderRadius: '50%', padding: 0, minWidth: '45px',
              backgroundColor: '#e53e3e', border: 'none', cursor: 'pointer',
              fontSize: '1rem', flexShrink: 0, color: 'white', transition: 'background-color 0.3s',
            }}>
              ⏹
            </button>
          ) : (
            <button type="submit" className="btn" style={{
              width: '45px', height: '45px', borderRadius: '50%', padding: 0, minWidth: '45px',
              backgroundColor: input.trim() && (isAiRoom || !keyError) ? 'var(--primary-color)' : 'rgba(255,255,255,0.1)',
              transition: 'background-color 0.3s',
            }} disabled={!input.trim() || (!isAiRoom && !!keyError)}>
              ↑
            </button>
          )}
        </form>
      </div>
    </div>
  );
};

export default ChatRoom;
