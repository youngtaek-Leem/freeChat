import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate } from 'react-router-dom';

export default function ProfileSetup({ session }) {
  const [loading, setLoading] = useState(true);
  const [bio, setBio] = useState('');
  const [username, setUsername] = useState('');
  const [themeColor, setThemeColor] = useState('#6366f1');
  const [keywords, setKeywords] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(null);
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
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: '800' }}>Edit Profile</h1>
      </header>

      <div style={{ padding: '1.5rem', flexGrow: 1, overflowY: 'auto', paddingBottom: '80px' }}>
        <div className="glass-panel">
          <p style={{ fontSize: '0.9rem', marginBottom: '2rem' }}>Update your information to help friends find you easily.</p>
          
          <form onSubmit={updateProfile}>
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
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', marginLeft: '4px' }}>AVATAR IMAGE URL</label>
              <input
                type="text"
                value={avatarUrl || ''}
                onChange={(e) => setAvatarUrl(e.target.value)}
                className="input-field"
                placeholder="https://..."
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
          </form>
        </div>
      </div>
    </div>
  );
}
