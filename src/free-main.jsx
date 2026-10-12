import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { createFreeCatalog } from './free-catalog.mjs';
import './style.css';
import './mobile.css';
import './free-mode.css';

const files = ['catalog', 'free-pricing-policy', 'name-aliases', 'arcana-catalog', 'equipment-bonuses', 'character-stats', 'free-levels', 'free-equipment'];
Promise.all(files.map(async name => {
  const response = await fetch('../data/' + name + '.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(name + ' 数据加载失败');
  return response.json();
})).then(([catalog, policy, nameAliases, arcana, equipmentBonuses, characterStats, freeLevels, freeEquipment]) => {
  const freeCatalog = createFreeCatalog(catalog, { arcana, equipmentBonuses, characterStats, freeLevels, freeEquipment });
  createRoot(document.getElementById('root')).render(<React.StrictMode><App catalog={freeCatalog} policy={policy} nameAliases={nameAliases} /></React.StrictMode>);
}).catch(error => {
  document.getElementById('root').textContent = '加载失败：' + error.message + '。请刷新后重试。';
});
