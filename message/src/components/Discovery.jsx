import React, { useState } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate } from 'react-router-dom';

export default function Discovery({ session }) {
  const [searchTerm, setSearchTerm] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchTerm.trim()) return;

    setLoading(true);
    // Search in username, keywords, or bio
    const { data, error } = await supabase
      .from('profiles')
      .select('id, username, email, bio, keywords, avatar_url')
      .neq('id', session.user.id)
      .or(`username.ilike.%${searchTerm}%,keywords.ilike.%${searchTerm}%,bio.ilike.%${searchTerm}%`);

    if (error) {
      console.error(error);
      alert('Error searching: ' + error.message);
    } else {
      setResults(data || []);
    }
    setLoading(false);
  };

  const handleAddFriend = async (receiverId) => {
    const { error } = await supabase
      .from('connections')
      .insert({
        requester_id: session.user.id,
        receiver_id: receiverId,
        status: 'pending'
      });
    
    if (error) {
      if (error.code === '23505') {
        alert('Already sent request!');
      } else {
        alert('Error: ' + error.message);
      }
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
                width: '50px', 
                height: '50px', 
                borderRadius: '18px', 
                backgroundColor: 'var(--surface-color)',
                backgroundImage: profile.avatar_url ? `url(${profile.avatar_url})` : 'none',
                backgroundSize: 'cover',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.2rem',
                fontWeight: 'bold',
                color: 'var(--primary-color)',
                flexShrink: 0
              }}>
                {!profile.avatar_url && (profile.username || profile.email || '?')[0].toUpperCase()}
              </div>
              <div style={{ flexGrow: 1, minWidth: 0 }}>
                <div style={{ fontWeight: '600', fontSize: '1rem' }}>{profile.username || profile.email?.split('@')[0]}</div>
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
