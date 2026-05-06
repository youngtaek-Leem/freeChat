import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate } from 'react-router-dom';

export default function ProfileSetup({ session }) {
  const [loading, setLoading] = useState(true);
  const [bio, setBio] = useState('');
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
        .select(`bio, keywords, avatar_url`)
        .eq('id', user.id)
        .single();

      if (!ignore) {
        if (data) {
          setBio(data.bio || '');
          setKeywords(data.keywords || '');
          setAvatarUrl(data.avatar_url || '');
        }
        setLoading(false);
      }
    }
    getProfile();
    return () => { ignore = true; };
  }, [session]);

  const updateProfile = async (e) => {
    e.preventDefault();
    setLoading(true);
    const { user } = session;

    const updates = {
      id: user.id,
      bio,
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
    <div className="container" style={{ display: 'flex', justifyContent: 'center', marginTop: '2rem' }}>
      <div className="glass-panel" style={{ maxWidth: '500px', width: '100%' }}>
        <h2>Setup Your Profile</h2>
        <p>This information will be visible to everyone.</p>
        <form onSubmit={updateProfile}>
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>Bio</label>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className="input-field"
            style={{ minHeight: '100px', resize: 'vertical' }}
            placeholder="Tell us about yourself..."
          />
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>Keywords (comma separated)</label>
          <input
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            className="input-field"
            placeholder="e.g. coding, music, movies"
          />
          {/* Avatar Upload Placeholder */}
          <label style={{ display: 'block', marginBottom: '0.5rem' }}>Avatar Image URL (Storage integration pending)</label>
          <input
            type="text"
            value={avatarUrl || ''}
            onChange={(e) => setAvatarUrl(e.target.value)}
            className="input-field"
            placeholder="https://..."
          />
          <button className="btn" type="submit" disabled={loading}>
            {loading ? 'Saving...' : 'Save Profile'}
          </button>
        </form>
      </div>
    </div>
  );
}
