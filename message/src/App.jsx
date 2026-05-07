import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { supabase } from './supabaseClient';
import Auth from './components/Auth';
import ProfileSetup from './components/ProfileSetup';
import Dashboard from './components/Dashboard';
import Discovery from './components/Discovery';
import ChatRoom from './components/ChatRoom';
import Navigation from './components/Navigation';
import { ChatProvider } from './ChatContext';

function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) fetchTheme(session.user.id);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) fetchTheme(session.user.id);
    });

    return () => subscription.unsubscribe();
  }, []);

  const fetchTheme = async (userId) => {
    const { data } = await supabase
      .from('profiles')
      .select('theme_color')
      .eq('id', userId)
      .single();
    if (data?.theme_color) {
      document.documentElement.style.setProperty('--primary-color', data.theme_color);
      // Generate a slightly darker color for hover (optional)
      document.documentElement.style.setProperty('--primary-hover', data.theme_color + 'dd');
    }
  };

  if (loading) return <div className="container">Loading...</div>;

  return (
    <ChatProvider>
      <Router basename="/freeChat">
        {session && <Navigation />}
        <Routes>
          <Route path="/" element={!session ? <Auth /> : <Navigate to="/dashboard" />} />
          <Route path="/profile-setup" element={session ? <ProfileSetup session={session} /> : <Navigate to="/" />} />
          <Route path="/dashboard" element={session ? <Dashboard session={session} /> : <Navigate to="/" />} />
          <Route path="/discovery" element={session ? <Discovery session={session} /> : <Navigate to="/" />} />
          <Route path="/chat/:roomId" element={session ? <ChatRoom session={session} /> : <Navigate to="/" />} />
        </Routes>
      </Router>
    </ChatProvider>
  );
}

export default App;
