import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const Navigation = () => {
  const location = useLocation();
  
  // Only show navigation for these paths
  const showNavPaths = ['/dashboard', '/discovery', '/profile-setup'];
  const shouldShow = showNavPaths.some(path => location.pathname.startsWith(path)) || location.pathname === '/';

  if (!shouldShow) return null;

  const navItemStyle = (path) => ({
    textDecoration: 'none',
    color: location.pathname === path ? 'var(--primary-color)' : 'var(--text-muted)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    transition: 'color 0.2s'
  });

  return (
    <nav style={{ 
      display: 'flex', 
      justifyContent: 'space-around', 
      padding: '0.8rem 0.5rem calc(0.8rem + env(safe-area-inset-bottom)) 0.5rem',
      backgroundColor: 'rgba(255, 255, 255, 0.85)',
      backdropFilter: 'blur(20px)',
      WebkitBackdropFilter: 'blur(20px)',
      borderTop: '1px solid var(--border-color)',
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      zIndex: 1000,
      maxWidth: '600px',
      margin: '0 auto'
    }}>
      <Link to="/dashboard" style={navItemStyle('/dashboard')}>
        <span style={{ fontSize: '1.2rem' }}>💬</span>
        <span style={{ fontSize: '0.65rem', fontWeight: location.pathname === '/dashboard' ? '600' : '400' }}>Chats</span>
      </Link>
      <Link to="/discovery" style={navItemStyle('/discovery')}>
        <span style={{ fontSize: '1.2rem' }}>🔍</span>
        <span style={{ fontSize: '0.65rem', fontWeight: location.pathname === '/discovery' ? '600' : '400' }}>Search</span>
      </Link>
      <Link to="/profile-setup" style={navItemStyle('/profile-setup')}>
        <span style={{ fontSize: '1.2rem' }}>👤</span>
        <span style={{ fontSize: '0.65rem', fontWeight: location.pathname === '/profile-setup' ? '600' : '400' }}>Profile</span>
      </Link>
    </nav>
  );
};

export default Navigation;
