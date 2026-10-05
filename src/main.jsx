import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './style.css';

const base = import.meta.env.BASE_URL;
Promise.all([
  fetch(`${base}data/catalog.json`).then(r => { if (!r.ok) throw Error('角色与装备目录加载失败'); return r.json(); }),
  fetch(`${base}data/pricing-policy.json`).then(r => { if (!r.ok) throw Error('计价规则加载失败'); return r.json(); }),
]).then(([catalog, policy]) => {
  createRoot(document.getElementById('root')).render(<React.StrictMode><App catalog={catalog} policy={policy} /></React.StrictMode>);
}).catch(error => {
  document.getElementById('root').textContent = `加载失败：${error.message}。请刷新后重试。`;
});
