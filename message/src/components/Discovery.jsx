import React, { useState } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate } from 'react-router-dom';

const AI_AGENT_ID = 'a04fce0a-02f8-4040-962a-22d7d98851f0';

export default function Discovery({ session }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchTerm.trim()) return;

    setLoading(true);
    // Strip PostgREST filter syntax characters to prevent filter injection
    const safe = searchTerm.replace(/[,()]/g, '').trim();
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, bio, keywords, avatar_url')
      .neq('id', session.user.id)
      .or(`username.ilike.%${safe}%,keywords.ilike.%${safe}%,bio.ilike.%${safe}%`);

    if (error) {
      console.error(error);
      alert('Error searching: ' + error.message);
    } else {
      const canSeeAiFriend = session.user.email === 'leemyt@hanmail.net';
      setResults(canSeeAiFriend ? (data || []) : (data || []).filter(p => p.id !== AI_AGENT_ID));
    }
    setLoading(false);
  };

  const handleAddFriend = async (receiverId) => {
    const { error } = await supabase
      .from('connections')
      .upsert({
        requester_id: session.user.id,
        receiver_id: receiverId,
        status: 'pending'
      }, { onConflict: 'requester_id,receiver_id' });
    
    if (error) {
      alert('Error: ' + error.message);
    } else {
      alert('Friend request sent!');
    }
  };

  return (
    <div className="container" style={{ padding: 0, height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ 
        padding: '1.5rem 1rem 1rem 1rem', 
        backgroundColor: 'color-mix(in srgb, var(--primary-color), white 75%)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '2px solid var(--primary-color)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', width: '100%' }}>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: '800' }}>Search</h1>
        </div>
      </header>

      <div style={{ padding: '1rem' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by name, keywords..."
            className="input-field"
            style={{ marginBottom: 0, borderRadius: '12px' }}
          />
          <button type="submit" className="btn" disabled={loading} style={{ width: '80px', padding: 0 }}>
            {loading ? '...' : 'Search'}
          </button>
        </form>
      </div>

      <div style={{ flexGrow: 1, overflowY: 'auto', padding: '0 1rem', paddingBottom: '80px' }}>
        {results.length === 0 && !loading ? (
          <div style={{ textAlign: 'center', marginTop: '3rem', opacity: 0.5 }}>
            <p>Try searching for keywords like "coding" or "music"</p>
          </div>
        ) : (
          results.map((profile) => (
            <div key={profile.id} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              padding: '1rem 0',
              borderBottom: '1px solid rgba(255,255,255,0.03)'
            }}>
              <div style={{
                width: '57px',
                height: '57px',
                borderRadius: '18px',
                backgroundColor: 'var(--surface-color)',
                backgroundImage: `url(${profile.avatar_url || `https://api.dicebear.com/9.x/avataaars/svg?seed=${encodeURIComponent(profile.username || profile.id)}`})`,
                backgroundSize: '58px 58px',
                backgroundPosition: 'center 30%',
                flexShrink: 0
              }} />
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                <div style={{ fontWeight: '600', fontSize: '1rem' }}>{profile.username || 'Unknown'}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {profile.keywords || profile.bio || 'No keywords set'}
                </div>
              </div>
              <button 
                className="btn" 
                onClick={() => handleAddFriend(profile.id)}
                style={{ width: 'auto', padding: '6px 12px', fontSize: '0.8rem', borderRadius: '10px' }}
              >
                Add
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
