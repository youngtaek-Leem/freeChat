import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const AGENT_URL = 'ws://localhost:3001/ws';
const STATUS_URL = 'http://localhost:3001/status';
const BROWSE_URL = 'http://localhost:3001/browse';
const MKDIR_URL = 'http://localhost:3001/mkdir';

const TOOL_LABELS = {
  list_files: '📁 파일 목록',
  read_file: '📄 파일 읽기',
  write_file: '✏️ 파일 쓰기',
  delete_file: '🗑️ 파일 삭제',
  open_url: '🌐 URL 열기',
  fetch_webpage: '🔍 웹 페이지 가져오기',
  execute_shell: '⚡ 명령 실행',
  control_app: '🖥️ 앱 제어',
};

const RISK_COLORS = {
  low: 'rgba(34,197,94,0.15)',
  medium: 'rgba(234,179,8,0.15)',
  high: 'rgba(239,68,68,0.15)',
};

const RISK_BORDER = {
  low: 'rgba(34,197,94,0.4)',
  medium: 'rgba(234,179,8,0.4)',
  high: 'rgba(239,68,68,0.4)',
};

function WorkspacePicker({ workspace, hasGuide, onSet, onClear }) {
  const [open, setOpen] = useState(false);
  const [inputPath, setInputPath] = useState('');
  const [browse, setBrowse] = useState(null);
  const [browseError, setBrowseError] = useState('');
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderError, setNewFolderError] = useState('');
  const newFolderInputRef = useRef(null);

  const loadBrowse = async (path) => {
    setBrowseError('');
    try {
      const r = await fetch(`${BROWSE_URL}?path=${encodeURIComponent(path || '~')}`);
      if (!r.ok) { setBrowseError(`서버 오류: ${r.status}`); return; }
      const data = await r.json();
      if (data.error || !Array.isArray(data.dirs)) { setBrowseError(data.error || '응답 형식 오류'); return; }
      setBrowse(data);
      setInputPath(data.path);
    } catch {
      setBrowseError('Agent 서버가 실행 중인지 확인하세요.');
    }
  };

  const handleOpen = () => {
    setOpen(true);
    setInputPath(workspace || '~');
    loadBrowse(workspace || '~');
  };

  const handleSelect = (path) => {
    setInputPath(path);
    loadBrowse(path);
  };

  const handleConfirm = () => {
    onSet(inputPath);
    setOpen(false);
  };

  const handleNewFolderOpen = () => {
    setNewFolderMode(true);
    setNewFolderName('');
    setNewFolderError('');
    setTimeout(() => newFolderInputRef.current?.focus(), 50);
  };

  const handleNewFolderCreate = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderError('');
    try {
      const r = await fetch(MKDIR_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: browse?.path || inputPath, name }),
      });
      const data = await r.json();
      if (data.error) { setNewFolderError(data.error); return; }
      setNewFolderMode(false);
      setNewFolderName('');
      loadBrowse(browse?.path || inputPath);
    } catch {
      setNewFolderError('폴더 생성에 실패했습니다.');
    }
  };

  if (!open) return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.5rem',
      padding: '0.4rem 1rem',
      background: workspace ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.04)',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      fontSize: '0.78rem',
    }}>
      <span style={{ opacity: 0.5 }}>📁</span>
      {workspace ? (
        <>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#a5b4fc' }}>
            {workspace}
          </span>
          {hasGuide && (
            <span title="Guide.md 적용 중" style={{
              fontSize: '0.7rem', background: 'rgba(99,102,241,0.25)',
              border: '1px solid rgba(99,102,241,0.5)', borderRadius: '4px',
              padding: '1px 5px', color: '#818cf8', flexShrink: 0,
            }}>📋 Guide</span>
          )}
          <button onClick={handleOpen} style={btnStyle}>변경</button>
          <button onClick={onClear} style={{ ...btnStyle, color: '#f87171' }}>✕</button>
        </>
      ) : (
        <>
          <span style={{ flex: 1, opacity: 0.45 }}>작업 공간 미설정</span>
          <button onClick={handleOpen} style={btnStyle}>설정</button>
        </>
      )}
    </div>
  );

  return (
    <div style={{
      padding: '0.75rem 1rem',
      background: 'color-mix(in srgb, var(--primary-color), white 80%)',
      borderBottom: '2px solid var(--primary-color)',
    }}>
      <div style={{ fontWeight: '700', marginBottom: '0.5rem', fontSize: '0.85rem' }}>작업 공간 선택</div>

      {/* 직접 입력 */}
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem' }}>
        <input
          value={inputPath}
          onChange={e => setInputPath(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && loadBrowse(inputPath)}
          placeholder="폴더 경로 입력..."
          style={{
            flex: 1, borderRadius: '8px', padding: '5px 10px', fontSize: '0.8rem',
            background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(0,0,0,0.15)',
            color: '#1e1e2e',
          }}
        />
        <button onClick={() => loadBrowse(inputPath)} style={btnStyle}>이동</button>
      </div>

      {browseError && <div style={{ color: '#dc2626', fontSize: '0.78rem', marginBottom: '0.4rem' }}>{browseError}</div>}

      {/* 폴더 브라우저 */}
      {browse && (
        <div style={{
          background: 'rgba(255,255,255,0.6)', borderRadius: '8px',
          maxHeight: '160px', overflowY: 'auto', marginBottom: '0.5rem',
          border: '1px solid rgba(0,0,0,0.1)',
        }}>
          {/* 상위 폴더 */}
          {browse.parent !== browse.path && (
            <DirRow label="📂 .." onClick={() => handleSelect(browse.parent)} />
          )}
          {(browse.dirs?.length === 0) && (
            <div style={{ padding: '6px 10px', opacity: 0.45, fontSize: '0.78rem' }}>하위 폴더 없음</div>
          )}
          {(browse.dirs || []).map(d => (
            <DirRow key={d.path} label={`📁 ${d.name}`} onClick={() => handleSelect(d.path)} />
          ))}
        </div>
      )}

      {/* 새 폴더 생성 */}
      {browse && (
        newFolderMode ? (
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <span style={{ fontSize: '0.8rem', color: '#1e1e2e', opacity: 0.6 }}>📁</span>
              <input
                ref={newFolderInputRef}
                value={newFolderName}
                onChange={e => { setNewFolderName(e.target.value); setNewFolderError(''); }}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleNewFolderCreate();
                  if (e.key === 'Escape') setNewFolderMode(false);
                }}
                placeholder="새 폴더 이름..."
                style={{
                  flex: 1, borderRadius: '6px', padding: '4px 8px', fontSize: '0.8rem',
                  background: 'rgba(255,255,255,0.7)', border: '1px solid rgba(99,102,241,0.5)',
                  color: '#1e1e2e', outline: 'none',
                }}
              />
              <button onClick={handleNewFolderCreate} style={{ ...btnStyle, color: '#6366f1', fontWeight: '700' }}>만들기</button>
              <button onClick={() => setNewFolderMode(false)} style={{ ...btnStyle, opacity: 0.5 }}>✕</button>
            </div>
            {newFolderError && (
              <div style={{ color: '#dc2626', fontSize: '0.75rem', marginTop: '3px', paddingLeft: '1.2rem' }}>
                {newFolderError}
              </div>
            )}
          </div>
        ) : (
          <button
            onClick={handleNewFolderOpen}
            style={{ ...btnStyle, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '4px' }}
          >
            + 새 폴더
          </button>
        )
      )}

      <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <button onClick={() => setOpen(false)} style={{ ...btnStyle, opacity: 0.6 }}>취소</button>
        <button
          onClick={handleConfirm}
          disabled={!inputPath}
          style={{
            ...btnStyle,
            background: 'var(--primary-color)', color: 'white',
            padding: '5px 14px', borderRadius: '8px',
          }}
        >
          이 폴더로 설정
        </button>
      </div>
    </div>
  );
}

const btnStyle = {
  background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)',
  borderRadius: '6px', padding: '3px 10px', cursor: 'pointer',
  color: 'inherit', fontSize: '0.78rem',
};

const dirRowStyle = {
  padding: '5px 10px', cursor: 'pointer', fontSize: '0.8rem',
  borderBottom: '1px solid rgba(0,0,0,0.06)', color: '#1e1e2e',
};

function DirRow({ label, onClick }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ ...dirRowStyle, background: hovered ? 'rgba(99,102,241,0.12)' : 'transparent' }}
    >
      {label}
    </div>
  );
}

function ToolBubble({ item }) {
  const [expanded, setExpanded] = useState(false);
  const risk = item.risk || 'medium';

  return (
    <div style={{
      alignSelf: 'flex-start',
      maxWidth: '90%',
      background: RISK_COLORS[risk],
      border: `1px solid ${RISK_BORDER[risk]}`,
      borderRadius: '12px',
      padding: '0.5rem 0.75rem',
      fontSize: '0.82rem',
    }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded(v => !v)}
      >
        <span>{TOOL_LABELS[item.name] || item.name}</span>
        {item.status === 'running' && <span style={{ opacity: 0.6 }}>실행 중...</span>}
        {item.status === 'done' && <span style={{ color: '#22c55e' }}>✓</span>}
        {item.status === 'cancelled' && <span style={{ color: '#ef4444' }}>✗ 취소됨</span>}
        <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.7rem' }}>{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: '0.4rem', borderTop: `1px solid ${RISK_BORDER[risk]}`, paddingTop: '0.4rem' }}>
          <div style={{ opacity: 0.7, marginBottom: '0.3rem' }}>
            <strong>입력:</strong>
            <pre style={{ margin: '2px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.78rem' }}>
              {JSON.stringify(item.args, null, 2)}
            </pre>
          </div>
          {item.result && (
            <div style={{ opacity: 0.85 }}>
              <strong>결과:</strong>
              <pre style={{ margin: '2px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '0.78rem', maxHeight: '150px', overflowY: 'auto' }}>
                {item.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmBubble({ item, onConfirm }) {
  return (
    <div style={{
      alignSelf: 'flex-start',
      maxWidth: '90%',
      background: 'rgba(239,68,68,0.12)',
      border: '1px solid rgba(239,68,68,0.5)',
      borderRadius: '12px',
      padding: '0.75rem',
      fontSize: '0.85rem',
    }}>
      <div style={{ fontWeight: '700', marginBottom: '0.4rem', color: '#ef4444' }}>
        ⚠️ 위험 작업 승인 필요
      </div>
      <div style={{ marginBottom: '0.3rem' }}>
        <strong>{TOOL_LABELS[item.name] || item.name}</strong>
      </div>
      <pre style={{ fontSize: '0.78rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all', opacity: 0.8, marginBottom: '0.6rem' }}>
        {JSON.stringify(item.args, null, 2)}
      </pre>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          onClick={() => onConfirm(item.id, true)}
          style={{
            background: 'rgba(239,68,68,0.8)', color: 'white', border: 'none',
            borderRadius: '8px', padding: '5px 14px', cursor: 'pointer', fontSize: '0.82rem',
          }}
        >
          허용
        </button>
        <button
          onClick={() => onConfirm(item.id, false)}
          style={{
            background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
            borderRadius: '8px', padding: '5px 14px', cursor: 'pointer', fontSize: '0.82rem',
            color: 'inherit',
          }}
        >
          취소
        </button>
      </div>
    </div>
  );
}

export default function AgentChatRoom() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [serverInfo, setServerInfo] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [hasGuide, setHasGuide] = useState(false);

  const wsRef = useRef(null);
  const endRef = useRef(null);
  const reconnectTimer = useRef(null);

  const addMsg = useCallback((msg) => {
    setMessages(prev => [...prev, { ...msg, id: crypto.randomUUID() }]);
  }, []);

  const updateLastTool = useCallback((toolId, patch) => {
    setMessages(prev => prev.map(m =>
      m.type === 'tool' && m.toolId === toolId ? { ...m, ...patch } : m
    ));
  }, []);

  const connect = useCallback(() => {
    const state = wsRef.current?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const ws = new WebSocket(AGENT_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      clearTimeout(reconnectTimer.current);
    };

    ws.onclose = () => {
      setConnected(false);
      setAgentBusy(false);
      reconnectTimer.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      // onerror 후 onclose가 자동으로 호출되므로 별도 close() 불필요
    };

    ws.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }

      if (data.type === 'text') {
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last?.type === 'assistant') {
            return [...prev.slice(0, -1), { ...last, text: last.text + data.text }];
          }
          return [...prev, { id: crypto.randomUUID(), type: 'assistant', text: data.text }];
        });
      } else if (data.type === 'tool_start') {
        addMsg({ type: 'tool', toolId: data.id, name: data.name, args: data.args, risk: data.risk, status: 'running' });
      } else if (data.type === 'tool_result') {
        updateLastTool(data.id, { result: data.result, status: data.success ? 'done' : 'cancelled' });
      } else if (data.type === 'confirm_request') {
        addMsg({ type: 'confirm', id: data.id, name: data.name, args: data.args });
      } else if (data.type === 'workspace_set') {
        setWorkspace(data.path || null);
        setHasGuide(data.has_guide || false);
      } else if (data.type === 'workspace_error') {
        addMsg({ type: 'error', text: `작업 공간 오류: ${data.message}` });
      } else if (data.type === 'done') {
        setAgentBusy(false);
      } else if (data.type === 'error') {
        addMsg({ type: 'error', text: data.message });
        setAgentBusy(false);
      }
    };
  }, [addMsg, updateLastTool]);

  useEffect(() => {
    connect();
    fetch(STATUS_URL)
      .then(r => r.json())
      .then(setServerInfo)
      .catch(() => {});
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = (e) => {
    e.preventDefault();
    if (!input.trim() || !connected || agentBusy) return;
    const text = input.trim();
    setInput('');
    setAgentBusy(true);
    addMsg({ type: 'user', text });
    wsRef.current.send(JSON.stringify({ type: 'message', text }));
  };

  const handleConfirm = (toolId, approved) => {
    // Replace confirm bubble with result indication
    setMessages(prev => prev.map(m =>
      m.type === 'confirm' && m.id === toolId
        ? { ...m, type: 'confirm_resolved', approved }
        : m
    ));
    wsRef.current?.send(JSON.stringify({ type: 'confirm', tool_call_id: toolId, approved }));
  };

  const clearChat = () => setMessages([]);

  const handleSetWorkspace = (path) => {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'set_workspace', path }));
  };

  const handleClearWorkspace = () => {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'set_workspace', path: '' }));
  };

  return (
    <div className="container" style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      padding: 0, maxWidth: '600px', backgroundColor: 'var(--bg-color)',
    }}>
      {/* Header */}
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

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div style={{
            width: '41px', height: '41px', borderRadius: '10px',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.3rem', flexShrink: 0,
          }}>🤖</div>
          <div>
            <div style={{ fontWeight: '700', fontSize: '1rem' }}>AI Agent</div>
            <div style={{ fontSize: '0.65rem', opacity: 0.7, display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{
                width: '6px', height: '6px', borderRadius: '50%',
                background: connected ? '#22c55e' : '#ef4444',
                display: 'inline-block',
              }} />
              {connected
                ? (serverInfo ? `${serverInfo.model} · ${serverInfo.os}` : '연결됨')
                : '서버 연결 중...'}
            </div>
          </div>
        </div>

        <button onClick={clearChat} style={{
          background: 'none', border: 'none', color: '#ef4444',
          cursor: 'pointer', padding: '5px', fontSize: '1rem', opacity: 0.9, fontWeight: 'bold',
        }}>Clear</button>
      </header>

      {/* Workspace picker */}
      {connected && (
        <WorkspacePicker
          workspace={workspace}
          hasGuide={hasGuide}
          onSet={handleSetWorkspace}
          onClear={handleClearWorkspace}
        />
      )}

      {/* Server offline notice */}
      {!connected && (
        <div style={{
          padding: '0.6rem 1rem', fontSize: '0.82rem', textAlign: 'center',
          background: 'rgba(239,68,68,0.1)', borderBottom: '1px solid rgba(239,68,68,0.3)',
          color: '#ef4444',
        }}>
          Agent 서버가 오프라인입니다. <code>./start_agent.sh</code> (또는 <code>start_agent.bat</code>)을 실행하세요.
        </div>
      )}

      {/* Messages */}
      <div style={{
        flexGrow: 1, overflowY: 'auto', padding: '1rem',
        display: 'flex', flexDirection: 'column', gap: '0.75rem',
        backgroundImage: 'radial-gradient(circle at top right, color-mix(in srgb, var(--primary-color), transparent 92%), transparent)',
      }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', marginTop: '4rem', opacity: 0.5 }}>
            <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🤖</div>
            <div style={{ fontSize: '0.9rem' }}>
              gemma4 로컬 AI 에이전트입니다.<br />
              파일 조작, 앱 제어, 웹 브라우징, 코드 실행이 가능합니다.
            </div>
            {workspace && (
              <div style={{ marginTop: '0.8rem', fontSize: '0.78rem', color: '#a5b4fc', opacity: 1 }}>
                📁 작업 공간: {workspace}
              </div>
            )}
            <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' }}>
              {[
                '데스크탑 파일 목록을 보여줘',
                'Safari에서 오늘 날씨 확인해줘',
                'Python으로 현재 시간 출력해줘',
              ].map(hint => (
                <button key={hint} onClick={() => setInput(hint)} style={{
                  background: 'var(--surface-color)', border: '1px solid var(--border-color)',
                  borderRadius: '20px', padding: '6px 14px', cursor: 'pointer',
                  color: 'var(--text-muted)', fontSize: '0.8rem',
                }}>{hint}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.type === 'user') return (
            <div key={msg.id} style={{
              alignSelf: 'flex-end',
              backgroundColor: 'var(--primary-color)', color: 'white',
              padding: '0.6rem 0.9rem',
              borderRadius: '18px 18px 4px 18px',
              maxWidth: '85%', wordBreak: 'break-word',
              boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
              fontSize: '0.95rem', lineHeight: '1.4',
            }}>{msg.text}</div>
          );

          if (msg.type === 'assistant') return (
            <div key={msg.id} style={{
              alignSelf: 'flex-start',
              backgroundColor: 'var(--surface-color)',
              padding: '0.6rem 0.9rem',
              borderRadius: '18px 18px 18px 4px',
              maxWidth: '85%', wordBreak: 'break-word',
              boxShadow: '0 2px 5px rgba(0,0,0,0.1)',
              fontSize: '0.9rem', lineHeight: '1.6',
            }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  p: ({ children }) => <p style={{ margin: '0.3rem 0' }}>{children}</p>,
                  ul: ({ children }) => <ul style={{ margin: '0.3rem 0', paddingLeft: '1.2rem' }}>{children}</ul>,
                  ol: ({ children }) => <ol style={{ margin: '0.3rem 0', paddingLeft: '1.2rem' }}>{children}</ol>,
                  li: ({ children }) => <li style={{ margin: '0.15rem 0' }}>{children}</li>,
                  h1: ({ children }) => <h1 style={{ fontSize: '1.1rem', fontWeight: '800', margin: '0.6rem 0 0.3rem' }}>{children}</h1>,
                  h2: ({ children }) => <h2 style={{ fontSize: '1rem', fontWeight: '700', margin: '0.5rem 0 0.2rem' }}>{children}</h2>,
                  h3: ({ children }) => <h3 style={{ fontSize: '0.95rem', fontWeight: '700', margin: '0.4rem 0 0.2rem' }}>{children}</h3>,
                  h4: ({ children }) => <h4 style={{ fontSize: '0.9rem', fontWeight: '700', margin: '0.3rem 0 0.1rem' }}>{children}</h4>,
                  code: ({ inline, children }) => inline
                    ? <code style={{ background: 'rgba(0,0,0,0.15)', borderRadius: '4px', padding: '1px 5px', fontSize: '0.85em', fontFamily: 'monospace' }}>{children}</code>
                    : <pre style={{ background: 'rgba(0,0,0,0.2)', borderRadius: '8px', padding: '0.6rem 0.8rem', overflowX: 'auto', margin: '0.4rem 0', fontSize: '0.82rem', fontFamily: 'monospace' }}><code>{children}</code></pre>,
                  blockquote: ({ children }) => <blockquote style={{ borderLeft: '3px solid var(--primary-color)', margin: '0.3rem 0', paddingLeft: '0.7rem', opacity: 0.8 }}>{children}</blockquote>,
                  hr: () => <hr style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.15)', margin: '0.5rem 0' }} />,
                  table: ({ children }) => <div style={{ overflowX: 'auto', margin: '0.4rem 0' }}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.82rem' }}>{children}</table></div>,
                  th: ({ children }) => <th style={{ border: '1px solid rgba(255,255,255,0.2)', padding: '4px 8px', background: 'rgba(255,255,255,0.1)', textAlign: 'left' }}>{children}</th>,
                  td: ({ children }) => <td style={{ border: '1px solid rgba(255,255,255,0.15)', padding: '4px 8px' }}>{children}</td>,
                  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--primary-color)', textDecoration: 'underline' }}>{children}</a>,
                  strong: ({ children }) => <strong style={{ fontWeight: '700' }}>{children}</strong>,
                }}
              >
                {msg.text}
              </ReactMarkdown>
            </div>
          );

          if (msg.type === 'tool') return <ToolBubble key={msg.id} item={msg} />;

          if (msg.type === 'confirm') return (
            <ConfirmBubble key={msg.id} item={msg} onConfirm={handleConfirm} />
          );

          if (msg.type === 'confirm_resolved') return (
            <div key={msg.id} style={{
              alignSelf: 'flex-start', fontSize: '0.78rem', opacity: 0.6,
            }}>
              {msg.approved ? '✓ 작업 허용됨' : '✗ 작업 취소됨'}
            </div>
          );

          if (msg.type === 'error') return (
            <div key={msg.id} style={{
              alignSelf: 'flex-start',
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '10px', padding: '0.5rem 0.75rem',
              fontSize: '0.82rem', color: '#ef4444',
            }}>⚠️ {msg.text}</div>
          );

          return null;
        })}

        {agentBusy && (
          <div style={{
            alignSelf: 'flex-start', opacity: 0.5, fontSize: '0.85rem',
            display: 'flex', gap: '4px', alignItems: 'center',
          }}>
            <span style={{ animation: 'pulse 1s infinite' }}>●</span>
            <span style={{ animationDelay: '0.2s', animation: 'pulse 1s infinite' }}>●</span>
            <span style={{ animationDelay: '0.4s', animation: 'pulse 1s infinite' }}>●</span>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '0.75rem 1rem 1.5rem 1rem',
        backgroundColor: 'color-mix(in srgb, var(--primary-color), white 75%)',
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderTop: '2px solid var(--primary-color)',
      }}>
        <form onSubmit={sendMessage} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={
              !connected ? '서버 오프라인...' :
              agentBusy ? 'AI가 작업 중입니다...' :
              '명령을 입력하세요...'
            }
            disabled={!connected || agentBusy}
            className="input-field"
            style={{
              marginBottom: 0, flexGrow: 1, borderRadius: '24px', paddingLeft: '1.25rem',
              backgroundColor: 'var(--surface-color)', border: '1px solid var(--border-color)',
              color: 'var(--text-main)',
            }}
          />
          <button
            type="submit"
            className="btn"
            disabled={!input.trim() || !connected || agentBusy}
            style={{
              width: '45px', height: '45px', borderRadius: '50%', padding: 0, minWidth: '45px',
              backgroundColor: input.trim() && connected && !agentBusy
                ? 'var(--primary-color)' : 'rgba(255,255,255,0.1)',
              transition: 'background-color 0.3s',
            }}
          >↑</button>
        </form>
      </div>
    </div>
  );
}
