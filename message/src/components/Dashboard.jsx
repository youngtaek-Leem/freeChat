import React, { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';
import { useNavigate, Link } from 'react-router-dom';
import { useChat } from '../ChatContext';

export default function Dashboard({ session }) {
  const navigate = useNavigate();
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const { unreadCounts } = useChat();

  useEffect(() => {
    fetchConnections();
  }, []);

  const fetchConnections = async () => {
    setLoading(true);
    // Fetch pending requests where user is receiver, and accepted connections
    const { data, error } = await supabase
      .from('connections')
      .select(`
        id, status, requester_id, receiver_id,
        requester:profiles!connections_requester_id_fkey(id, bio, keywords, avatar_url),
        receiver:profiles!connections_receiver_id_fkey(id, bio, keywords, avatar_url)
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
    <div className="container">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1>Messaging Dashboard</h1>
          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--primary-color)' }}>Logged in as: {session.user.email}</p>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <Link to="/discovery" className="btn" style={{ textDecoration: 'none', textAlign: 'center', backgroundColor: '#10b981' }}>🔍 Find Friends</Link>
          <Link to="/profile-setup" className="btn" style={{ textDecoration: 'none', textAlign: 'center' }}>Edit Profile</Link>
          <button onClick={handleLogout} className="btn" style={{ backgroundColor: 'var(--border-color)' }}>Log Out</button>
        </div>
      </header>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2rem' }}>
        <div className="glass-panel">
          <h2>Pending Friend Requests</h2>
          {pendingRequests.length === 0 ? (
            <p>No pending requests.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {pendingRequests.map(req => (
                <div key={req.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                  <span>{req.requester?.keywords?.split(',')[0] || 'Unknown User'} sent you a request</span>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <button onClick={() => handleUpdateStatus(req.id, 'accepted')} className="btn" style={{ padding: '0.5rem 1rem', width: 'auto', backgroundColor: '#10b981' }}>Accept</button>
                    <button onClick={() => handleUpdateStatus(req.id, 'rejected')} className="btn" style={{ padding: '0.5rem 1rem', width: 'auto', backgroundColor: '#ef4444' }}>Reject</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="glass-panel">
          <h2>My Friends</h2>
          {myFriends.length === 0 ? (
            <p>You haven't added any friends yet. Click "Find Friends" to start!</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {myFriends.map(friend => {
                const otherPerson = friend.requester_id === myId ? friend.receiver : friend.requester;
                if (!otherPerson) return null; // Skip if profile data is missing
                const roomId = [myId, otherPerson.id].sort().join('_');
                const unreadCount = unreadCounts[roomId] || 0;

                return (
                  <div key={friend.id} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1rem', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', position: 'relative' }}>
                     <div style={{ width: '40px', height: '40px', borderRadius: '50%', backgroundColor: 'var(--border-color)', backgroundImage: `url(${otherPerson?.avatar_url || ''})`, backgroundSize: 'cover' }}></div>
                     <div style={{ flexGrow: 1 }}>
                       <strong>
                         {otherPerson?.keywords?.split(',')[0] || 'Friend'}
                         {unreadCount > 0 && (
                           <span style={{ backgroundColor: '#ef4444', color: 'white', borderRadius: '50%', padding: '2px 6px', fontSize: '0.7rem', marginLeft: '0.5rem' }}>
                             {unreadCount}
                           </span>
                         )}
                       </strong>
                       <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{otherPerson?.bio?.substring(0, 30)}...</div>
                     </div>
                     <button className="btn" onClick={() => handleMessage(otherPerson.id)} style={{ marginLeft: 'auto', width: 'auto', padding: '0.5rem 1rem' }}>Message</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
