import React, { useState } from 'react';
import { supabase } from '../supabaseClient';

export default function Auth() {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLogin, setIsLogin] = useState(true);

  const handleAuth = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (isLogin) {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ 
          email, 
          password,
          options: {
            emailRedirectTo: undefined // No email confirmation as requested
          }
        });
        if (error) throw error;
      }
    } catch (error) {
      alert(error.error_description || error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', padding: '2rem' }}>
      <div style={{ width: '100%', textAlign: 'center' }}>
        {/* Branding Area */}
        <div style={{ marginBottom: '3rem' }}>
          <div style={{ 
            width: '70px', 
            height: '70px', 
            backgroundColor: 'var(--primary-color)', 
            borderRadius: '22px', 
            margin: '0 auto 1.5rem auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '2rem',
            boxShadow: '0 10px 25px rgba(99, 102, 241, 0.4)',
            color: 'white'
          }}>
            G
          </div>
          <h1 style={{ fontSize: '2.2rem', marginBottom: '0.5rem', fontWeight: '800' }}>Gemma</h1>
          <p style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>Secure E2E Messaging</p>
        </div>

        <div className="glass-panel" style={{ textAlign: 'left', animation: 'fadeIn 0.5s ease-out' }}>
          <h2 style={{ fontSize: '1.4rem', marginBottom: '0.5rem' }}>{isLogin ? 'Welcome Back' : 'Create Account'}</h2>
          <p style={{ fontSize: '0.9rem', marginBottom: '2rem' }}>
            {isLogin ? 'Login to continue your conversations.' : 'Join us and start secure messaging today.'}
          </p>
          
          <form onSubmit={handleAuth}>
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', marginLeft: '4px' }}>EMAIL</label>
              <input
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input-field"
                required
                style={{ marginBottom: 0 }}
              />
            </div>
            <div style={{ marginBottom: '2rem' }}>
              <label style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', marginLeft: '4px' }}>PASSWORD</label>
              <input
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input-field"
                required
                style={{ marginBottom: 0 }}
              />
            </div>
            <button className="btn" type="submit" disabled={loading} style={{ 
              padding: '1rem', 
              fontSize: '1.1rem',
              boxShadow: '0 4px 15px rgba(99, 102, 241, 0.3)'
            }}>
              {loading ? 'Connecting...' : (isLogin ? 'Sign In' : 'Sign Up')}
            </button>
          </form>

          <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
            <button 
              type="button"
              onClick={() => setIsLogin(!isLogin)} 
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.9rem' }}
            >
              {isLogin ? "New here? " : "Already member? "}
              <span style={{ color: 'var(--primary-color)', fontWeight: '600' }}>
                {isLogin ? "Create an account" : "Login"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
