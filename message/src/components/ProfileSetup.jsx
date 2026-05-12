import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../supabaseClient';
import { dbUtils } from '../utils/db';
import { useNavigate } from 'react-router-dom';

export default function ProfileSetup({ session }) {
  const [loading, setLoading] = useState(true);
  const [bio, setBio] = useState('');
  const [username, setUsername] = useState('');
  const [themeColor, setThemeColor] = useState('#6366f1');
  const [keywords, setKeywords] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const fileInputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    let ignore = false;
    async function getProfile() {
      setLoading(true);
      const { user } = session;
      const { data, error } = await supabase
        .from('profiles')
        .select(`bio, username, keywords, avatar_url, theme_color`)
        .eq('id', user.id)
        .single();

      if (!ignore) {
        if (data) {
          setBio(data.bio || '');
          setUsername(data.username || '');
          setThemeColor(data.theme_color || '#6366f1');
          setKeywords(data.keywords || '');
          setAvatarUrl(data.avatar_url || '');
        }
        setLoading(false);
      }
    }
    getProfile();
    return () => { ignore = true; };
  }, [session]);

  // Live preview: update CSS variables whenever themeColor changes
  useEffect(() => {
    if (themeColor) {
      document.documentElement.style.setProperty('--primary-color', themeColor);
      document.documentElement.style.setProperty('--primary-hover', themeColor + 'dd');
    }
  }, [themeColor]);

  const handleDeleteAccount = async () => {
    const confirmed = window.confirm(
      '정말 계정을 삭제하시겠습니까?\n\n채팅 기록과 모든 정보가 영구적으로 삭제되며 복구할 수 없습니다.'
    );
    if (!confirmed) return;

    setLoading(true);
    try {
      // 로컬 IndexedDB 전체 삭제
      const db = await dbUtils.initDB();
      await db.clear('messages');
      await db.clear('secrets');

      // 서버 데이터 삭제 (connections, pending_messages, profiles, auth.users)
      const { error } = await supabase.rpc('delete_user_account');
      if (error) throw error;

      await supabase.auth.signOut();
    } catch (err) {
      alert('계정 삭제 중 오류가 발생했습니다: ' + err.message);
      setLoading(false);
    }
  };

  const updateProfile = async (e) => {
    e.preventDefault();
    setLoading(true);
    const { user } = session;

    const updates = {
      id: user.id,
      bio,
      username,
      theme_color: themeColor,
      keywords,
      avatar_url: avatarUrl,
      updated_at: new Date(),
    };

    let { error } = await supabase.from('profiles').upsert(updates);
    if (error) {
      alert(error.message);
    } else {
      navigate('/dashboard');
    }
    setLoading(false);
  };

  const resizeToJpeg = (file) => new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 200;
      canvas.height = 200;
      const ctx = canvas.getContext('2d');
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 200, 200);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob(resolve, 'image/jpeg', 0.80);
    };
    img.src = objectUrl;
  });

  const handleAvatarReset = async () => {
    if (!avatarUrl) return;
    setAvatarUploading(true);
    try {
      await supabase.storage.from('avatars').remove([`${session.user.id}.jpg`]);
      await supabase.from('profiles').update({ avatar_url: null }).eq('id', session.user.id);
      setAvatarUrl(null);
    } catch (err) {
      alert('Reset failed: ' + err.message);
    }
    setAvatarUploading(false);
  };

  const handleAvatarChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    try {
      const blob = await resizeToJpeg(file);
      const path = `${session.user.id}.jpg`;
      const { error } = await supabase.storage.from('avatars').upload(path, blob, {
        contentType: 'image/jpeg',
        upsert: true,
      });
      if (error) throw error;
      const { data } = supabase.storage.from('avatars').getPublicUrl(path);
      // Add cache-busting param so browser reloads after re-upload
      const url = data.publicUrl + '?t=' + Date.now();
      setAvatarUrl(url);
      await supabase.from('profiles').update({ avatar_url: url }).eq('id', session.user.id);
    } catch (err) {
      alert('Avatar upload failed: ' + err.message);
    }
    setAvatarUploading(false);
  };

  const dicebearUrl = `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(username || session.user.id)}`;
  const displayAvatar = avatarUrl || dicebearUrl;

  return (
    <div className="container" style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: 0 }}>
      {/* Header */}
      <header style={{
        padding: '1.5rem 1rem 1rem 1rem',
        backgroundColor: 'color-mix(in srgb, var(--primary-color), white 75%)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '2px solid var(--primary-color)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: '800' }}>Edit Profile</h1>
          <button
            type="button"
            onClick={async () => { await supabase.auth.signOut(); navigate('/'); }}
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: 'none',
              color: 'var(--text-main)',
              fontSize: '0.75rem',
              padding: '4px 10px',
              borderRadius: '12px',
              cursor: 'pointer',
            }}
          >Logout</button>
        </div>
      </header>

      <div style={{ padding: '1.5rem', flexGrow: 1, overflowY: 'auto', paddingBottom: '80px' }}>
        <div className="glass-panel">
          <p style={{ fontSize: '0.9rem', marginBottom: '2rem' }}>Update your information to help friends find you easily.</p>
          
          <form onSubmit={updateProfile}>
            {/* Avatar */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: '2rem' }}>
              <div
                onClick={() => !avatarUploading && fileInputRef.current?.click()}
                style={{
                  width: '96px',
                  height: '96px',
                  borderRadius: '28px',
                  backgroundImage: `url(${displayAvatar})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  backgroundColor: 'var(--surface-color)',
                  cursor: avatarUploading ? 'default' : 'pointer',
                  border: '2px solid var(--primary-color)',
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {avatarUploading && (
                  <div style={{
                    position: 'absolute', inset: 0, borderRadius: '26px',
                    backgroundColor: 'rgba(0,0,0,0.5)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.75rem', color: 'white'
                  }}>...</div>
                )}
                {!avatarUploading && (
                  <div style={{
                    position: 'absolute', bottom: '-6px', right: '-6px',
                    width: '26px', height: '26px', borderRadius: '50%',
                    backgroundColor: 'var(--primary-color)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '14px', color: 'white', border: '2px solid var(--bg-color)'
                  }}>✎</div>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleAvatarChange}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.6rem' }}>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                  {avatarUrl ? 'Tap to change photo' : 'Tap to upload photo (auto-generated now)'}
                </p>
                {avatarUrl && !avatarUploading && (
                  <button
                    type="button"
                    onClick={handleAvatarReset}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-muted)',
                      fontSize: '0.75rem',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      padding: 0,
                    }}
                  >Reset</button>
                )}
              </div>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', marginLeft: '4px' }}>EMAIL</label>
              <div className="input-field" style={{ marginBottom: 0, color: 'var(--text-muted)', pointerEvents: 'none' }}>
                {session.user.email}
              </div>
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', marginLeft: '4px' }}>NICKNAME</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input-field"
                placeholder="Enter your nickname"
                style={{ marginBottom: 0 }}
              />
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', marginLeft: '4px' }}>BIO</label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                className="input-field"
                style={{ minHeight: '120px', resize: 'none', marginBottom: 0 }}
                placeholder="Tell us about yourself..."
              />
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', marginLeft: '4px' }}>KEYWORDS (COMMA SEPARATED)</label>
              <input
                type="text"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                className="input-field"
                placeholder="e.g. coding, music, movies"
                style={{ marginBottom: 0 }}
              />
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={{ display: 'block', marginBottom: '0.8rem', fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '4px' }}>THEME COLOR</label>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '1rem', marginLeft: '4px' }}>
                {['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#ffffff', '#9ca3af', '#4b5563', '#1f2937'].map(color => (
                  <div 
                    key={color}
                    onClick={() => setThemeColor(color)}
                    style={{ 
                      width: '32px', 
                      height: '32px', 
                      borderRadius: '50%', 
                      backgroundColor: color, 
                      cursor: 'pointer',
                      border: themeColor === color ? '3px solid white' : 'none',
                      boxShadow: themeColor === color ? '0 0 10px rgba(0,0,0,0.5)' : 'none'
                    }}
                  />
                ))}
                <input 
                  type="color" 
                  value={themeColor} 
                  onChange={(e) => setThemeColor(e.target.value)}
                  style={{ width: '32px', height: '32px', border: 'none', background: 'none', cursor: 'pointer' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem' }}>
              <button className="btn" type="submit" disabled={loading}>
                {loading ? '저장 중...' : '저장'}
              </button>
              <button
                type="button"
                onClick={() => navigate('/dashboard')}
                className="btn"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  color: 'var(--text-main)',
                  border: '1px solid rgba(255,255,255,0.1)'
                }}
              >
                취소
              </button>
            </div>

            <div style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                계정을 삭제하면 채팅 기록과 모든 데이터가 영구적으로 삭제됩니다.
              </p>
              <button
                type="button"
                onClick={handleDeleteAccount}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '0.8rem',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  color: '#ef4444',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: '12px',
                  fontSize: '0.95rem',
                  cursor: 'pointer',
                }}
              >
                계정 삭제
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
