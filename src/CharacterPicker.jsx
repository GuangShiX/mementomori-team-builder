import React, { useEffect, useRef, useState } from 'react';
import { filterRosterCharacters } from './character-search.mjs';

export function CharacterPickerContents({ catalog, team, targetIndex, aliases, elements, freeCharacters, search, element, onSearch, onElement, onChoose, onClose, renderPortrait, closeIcon, searchIcon }) {
  const filtered = filterRosterCharacters(catalog.characters, aliases, search, element);
  const replacing = Boolean(team.members[targetIndex]);
  return <>
    <header className="character-picker-header"><div><h2 id="character-picker-title">{replacing ? '更换' : '选择'}第 {targetIndex + 1} 位角色</h2><p id="character-picker-description">{replacing ? '新角色保留该位置的稀有度与装备；已入队角色可互换位置。' : '点选角色加入此位置，已入队角色可移动到此处。'}</p></div><button type="button" aria-label="关闭角色选择器" onClick={onClose} autoFocus>{closeIcon}</button></header>
    <label className="character-picker-search">{searchIcon}<input type="search" aria-label="查找角色名称或简称" placeholder="搜索名称或简称" value={search} onChange={event => onSearch(event.target.value)} /></label>
    <div className="character-picker-filters" role="group" aria-label="选人属性筛选"><button type="button" aria-pressed={element === 'all'} onClick={() => onElement('all')}>全部</button>{Object.entries(elements).map(([key, value]) => <button key={key} type="button" aria-pressed={element === key} onClick={() => onElement(key)}>{value.name}</button>)}</div>
    <div className="character-picker-grid" role="group" aria-label="点选配队角色">{filtered.map(character => {
      const position = team.members.findIndex(member => member?.characterId === character.id);
      const isCurrent = position === targetIndex;
      const positionLabel = isCurrent ? '当前角色' : position >= 0 ? `第 ${position + 1} 位 · ${replacing ? '点击互换' : '点击移入'}` : '';
      const entitlement = freeCharacters.get(character.id);
      return <button type="button" className={`character-picker-tile${isCurrent ? ' is-current' : ''}`} key={character.id} disabled={isCurrent} aria-label={`${character.name}${character.subtitle ? ` · ${character.subtitle}` : ''}${positionLabel ? `，${positionLabel}` : ''}`} onClick={() => onChoose(character.id)}>
        {renderPortrait(character, position >= 0 ? team.members[position].rarity : 'SR')}
        <span className="tile-name">{character.name}</span><span className="tile-subtitle">{character.subtitle || '\u00a0'}</span>
        <span className="picker-position">{positionLabel || (entitlement ? `${entitlement.rarity} 免费` : '\u00a0')}</span>
      </button>;
    })}{filtered.length === 0 && <p className="no-results">没有找到角色，试试正式名称、简称或其它属性。</p>}</div>
    <footer className="character-picker-footer"><span role="status">{filtered.length} 位角色</span><button type="button" className="button" onClick={onClose}>取消</button></footer>
  </>;
}

export default function CharacterPicker(props) {
  const dialogRef = useRef(null);
  const [search, setSearch] = useState('');
  const [element, setElement] = useState('all');
  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = document.activeElement;
    const rootOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.documentElement.style.overflow = rootOverflow;
      document.body.style.overflow = bodyOverflow;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialogRef} className="character-picker" aria-labelledby="character-picker-title" aria-describedby="character-picker-description" onCancel={event => { event.preventDefault(); props.onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) props.onClose();
  }}><CharacterPickerContents {...props} search={search} element={element} onSearch={setSearch} onElement={setElement} /></dialog>;
}
