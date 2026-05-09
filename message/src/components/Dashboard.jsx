import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate, Link } from 'react-router-dom';
import { useChat } from '../ChatContext';

export default function Dashboard({ session }) {
  const navigate = useNavigate();
   const [connections, setConnections] = useState([]);
   const [userProfile, setUserProfile] = useState(null);
   const [loading, setLoading] = useState(true);
   const { unreadCounts } = useChat();

   useEffect(() => {
     fetchConnections();
     fetchUserProfile();
   }, []);

   const fetchUserProfile = async () => {
     const { data } = await supabase
       .from('profiles')
       .select('username')
       .eq('id', session.user.id)
       .single();
     if (data) setUserProfile(data);
   };

  const fetchConnections = async () => {
    setLoading(true);
    // Fetch pending requests where user is receiver, and accepted connections
    const { data, error } = await supabase
      .from('connections')
      .select(`
        id, status, requester_id, receiver_id,
        requester:profiles!connections_requester_id_fkey(id, bio, username, keywords, avatar_url),
        receiver:profiles!connections_receiver_id_fkey(id, bio, username, keywords, avatar_url)
      `)
      .or(`requester_id.eq.${session.user.id},receiver_id.eq.${session.user.id}`);
      
    if (error) {
      console.error("Error fetching connections:", error);
    }
    
    if (!error && data) {
      setConnections(data);
    }
    setLoading(false);
  };

  const handleUpdateStatus = async (connectionId, newStatus) => {
    const { error } = await supabase
      .from('connections')
      .update({ status: newStatus })
      .eq('id', connectionId);
      
    if (!error) {
      fetchConnections();
    } else {
      alert('Error updating status: ' + error.message);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/');
  };

  const handleMessage = (friendId) => {
    const roomId = [myId, friendId].sort().join('_');
    navigate(`/chat/${roomId}`);
  };

  const myId = session.user.id;
  const pendingRequests = connections.filter(c => c.status === 'pending' && c.receiver_id === myId);
  const myFriends = connections.filter(c => c.status === 'accepted');

  return (
    <div className="container" style={{ padding: 0, height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-color)' }}>
      {/* Mobile Dashboard Header */}
      <header style={{ 
        padding: '1.5rem 1rem 1rem 1rem', 
        backgroundColor: 'color-mix(in srgb, var(--primary-color), white 75%)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderBottom: '2px solid var(--primary-color)',
        position: 'sticky',
        top: 0,
        zIndex: 10
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: '800' }}>
              {userProfile?.username || 'Me'}
            </h1>
          </div>
          <div style={{ display: 'flex', gap: '0.8rem', alignItems: 'center' }}>
            <button onClick={handleLogout} style={{ 
              background: 'rgba(255,255,255,0.1)', 
              border: 'none', 
              color: 'var(--text-main)', 
              fontSize: '0.75rem',
              padding: '4px 10px',
              borderRadius: '12px'
            }}>Logout</button>
          </div>
        </div>
      </header>

      <div style={{ flexGrow: 1, overflowY: 'auto', padding: '1rem', paddingBottom: '80px' }}>
        {/* Pending Requests Section */}
        {pendingRequests.length > 0 && (
          <div style={{ marginBottom: '2rem' }}>
            <h3 style={{ fontSize: '0.75rem', color: 'var(--primary-color)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.8rem' }}>
              Pending Requests ({pendingRequests.length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
              {pendingRequests.map(req => (
                <div key={req.id} className="glass-panel" style={{ padding: '1rem', flexDirection: 'row', alignItems: 'center', gap: '1rem' }}>
                  <div style={{ flexGrow: 1 }}>
                    <div style={{ fontWeight: '600', fontSize: '0.95rem' }}>{req.requester?.keywords?.split(',')[0] || 'Unknown'}</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>wants to connect</div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button onClick={() => handleUpdateStatus(req.id, 'accepted')} className="btn" style={{ padding: '0.4rem 0.8rem', width: 'auto', fontSize: '0.8rem' }}>Accept</button>
                    <button onClick={() => handleUpdateStatus(req.id, 'rejected')} className="btn" style={{ padding: '0.4rem 0.8rem', width: 'auto', fontSize: '0.8rem', backgroundColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }}>Reject</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Connections Section */}
        <h3 style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '1rem' }}>
          Messages
        </h3>
        
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {myFriends.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem 1rem', opacity: 0.5 }}>
              <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>💬</div>
              <p>No conversations yet.<br/>Find friends to start chatting!</p>
            </div>
          ) : (
            myFriends.map((friend) => {
              const otherPerson = friend.requester_id === myId ? friend.receiver : friend.requester;
              if (!otherPerson) return null;
              const roomId = [myId, otherPerson.id].sort().join('_');
              const unreadCount = unreadCounts[roomId] || 0;

              return (
                <Link 
                  key={friend.id} 
                  to={`/chat/${roomId}`}
                  style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '1rem', 
                    padding: '0.85rem 0',
                    textDecoration: 'none',
                    color: 'inherit',
                    borderBottom: '1px solid rgba(255,255,255,0.03)'
                  }}
                >
                  <div style={{ 
                    width: '54px', 
                    height: '54px', 
                    borderRadius: '20px', 
                    backgroundColor: 'var(--surface-color)',
                    backgroundImage: `url(${otherPerson?.avatar_url || ''})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    border: '1px solid rgba(255,255,255,0.05)',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '1.2rem',
                    fontWeight: 'bold',
                    color: 'var(--primary-color)'
                  }}>
                    {!otherPerson?.avatar_url && (otherPerson?.username || '?')[0].toUpperCase()}
                  </div>
                  <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
                      <div style={{ fontWeight: '600', fontSize: '1.05rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {otherPerson?.username || 'Friend'}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Now
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: '1rem' }}>
                        {otherPerson?.bio || 'Start a conversation...'}
                      </div>
                      {unreadCount > 0 && (
                        <div style={{ 
                          backgroundColor: '#ef4444', 
                          color: 'white', 
                          borderRadius: '10px', 
                          minWidth: '20px', 
                          height: '20px', 
                          display: 'flex', 
                          alignItems: 'center', 
                          justifyContent: 'center',
                          fontSize: '0.75rem',
                          fontWeight: 'bold',
                          padding: '0 6px'
                        }}>
                          {unreadCount}
                        </div>
                      )}
                    </div>
                  </div>
                </Link>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
