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
    // Search in keywords or bio
    const { data, error } = await supabase
      .from('profiles')
      .select('id, bio, keywords, avatar_url')
      .neq('id', session.user.id)
      .or(`keywords.ilike.%${searchTerm}%,bio.ilike.%${searchTerm}%`);

    if (error) {
      console.error(error);
      alert('Error searching: ' + error.message);
    } else {
      setResults(data || []);
    }
    setLoading(false);
  };

  const handleAddFriend = async (receiverId) => {
    // Add friend logic: insert into connections table
    const { error } = await supabase
      .from('connections')
      .insert({
        requester_id: session.user.id,
        receiver_id: receiverId,
        status: 'pending'
      });
    
    if (error) {
      if (error.code === '23505') { // Unique violation
        alert('Friend request already sent or you are already friends!');
      } else {
        alert('Error sending request: ' + error.message);
      }
    } else {
      alert('Friend request sent!');
    }
  };

  return (
    <div className="container">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h2>Discover Friends</h2>
        <button onClick={() => navigate('/dashboard')} className="btn" style={{ width: 'auto', backgroundColor: 'var(--border-color)' }}>Back to Dashboard</button>
      </header>

      <div className="glass-panel" style={{ marginBottom: '2rem' }}>
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: '1rem' }}>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search by keywords or bio..."
            className="input-field"
            style={{ marginBottom: 0 }}
          />
          <button type="submit" className="btn" disabled={loading} style={{ width: 'auto' }}>
            {loading ? 'Searching...' : 'Search'}
          </button>
        </form>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1.5rem' }}>
        {results.map((profile) => (
          <div key={profile.id} className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div style={{
                width: '60px', height: '60px', borderRadius: '50%', backgroundColor: 'var(--border-color)',
                backgroundImage: profile.avatar_url ? `url(${profile.avatar_url})` : 'none',
                backgroundSize: 'cover', backgroundPosition: 'center'
              }}></div>
              <div>
                <strong>{profile.keywords ? profile.keywords.split(',')[0] : 'User'}</strong>
              </div>
            </div>
            <p style={{ margin: 0, flexGrow: 1, color: 'var(--text-main)', fontSize: '0.9rem' }}>{profile.bio || 'No bio available.'}</p>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1rem' }}>
              Keywords: {profile.keywords || 'None'}
            </div>
            <button className="btn" onClick={() => handleAddFriend(profile.id)}>
              Add Friend
            </button>
          </div>
        ))}
        {results.length === 0 && !loading && (
          <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>
            No users found. Try a different keyword!
          </div>
        )}
      </div>
    </div>
  );
}
