import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { createTeam, createMember } from '../src/domain.mjs';
import { applyEquipmentPreset } from '../src/equipment-presets.mjs';
import { placeRosterCharacter, swapTeamPositions } from '../src/team-interactions.mjs';
import { filterRosterCharacters } from '../src/character-search.mjs';

const [catalog, policy, freeLibrary, appSource] = await Promise.all([
  ...['catalog', 'pricing-policy', 'free-library'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))),
  readFile(new URL('../src/App.jsx', import.meta.url), 'utf8'),
]);

function handlerBody(name) {
  const body = appSource.match(new RegExp(`  function ${name}\\(([^\\n]*)\\) \\{([\\s\\S]*?)\\n  \\}`));
  assert.ok(body, `production handler ${name} exists`);
  return { parameters: body[1], body: body[2] };
}

// Use the production event bodies, with React state updates applied between taps.
// This follows the existing builder UI harness without introducing a DOM runtime.
function phoneSession(team, activePage = 'stats') {
  const state = { team, activePage, selectedIndex: team.members.findIndex(Boolean), pickerIndex: null, reorderMode: false, swapFrom: null, removedMember: null, teamActionStatus: '', runeBatch: null, runeFillReport: null, notice: null };
  const pageChanges = [];
  const handlerNames = ['changeTeam', 'applyPlacement', 'selectMember', 'openCharacterPicker', 'chooseRosterCharacter', 'chooseTeamPosition', 'undoRemoveMember', 'removeMember'];
  const handlers = Object.fromEntries(handlerNames.map(name => [name, (...args) => invoke(name, ...args)]));
  function invoke(name, ...args) {
    const setters = Object.fromEntries(Object.keys(state).map(key => [`set${key[0].toUpperCase()}${key.slice(1)}`, value => {
      if (key === 'activePage') pageChanges.push(value);
      state[key] = typeof value === 'function' ? value(state[key]) : value;
    }]));
    const scope = { ...state, ...setters, ...handlers, catalog, freeLibrary, characters: new Map(catalog.characters.map(character => [character.id, character])), placeRosterCharacter, swapTeamPositions, characterLabel: character => character.name };
    const production = handlerBody(name);
    return new Function(...Object.keys(scope), `return function(${production.parameters}) {${production.body}\n};`)(...Object.values(scope))(...args);
  }
  return { state, invoke, pageChanges };
}

function elements(tree) {
  if (!React.isValidElement(tree)) return [];
  return [tree, ...React.Children.toArray(tree.props.children).flatMap(elements)];
}

test('mobile character search accepts formal names, aliases, variants and element filters while excluding R characters', () => {
  const characters = [
    { id: 101, name: '阿姆雷特', subtitle: '仲夏夜之梦', variant: 'SP', element: 'green', baseRarity: 8 },
    { id: 102, name: '梅莉亚', element: 'red', baseRarity: 8, aliases: ['灾芽'] },
    { id: 103, name: '伊利亚', element: 'red', baseRarity: 2 },
  ];
  const aliases = new Map([[101, '夏姆']]);
  for (const query of ['阿姆', '仲夏', 'sp', ' 夏姆 ', '101']) assert.deepEqual(filterRosterCharacters(characters, aliases, query).map(character => character.id), [101]);
  assert.deepEqual(filterRosterCharacters(characters, aliases, '灾芽', 'red').map(character => character.id), [102]);
  assert.deepEqual(filterRosterCharacters(characters, aliases, '夏姆', 'red'), []);
  assert.deepEqual(filterRosterCharacters(characters, aliases, '', 'red').map(character => character.id), [102]);
});

test('character picker labels replacement and move actions, disables the current member and exposes touch button callbacks', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { CharacterPickerContents } = await server.ssrLoadModule('/src/CharacterPicker.jsx');
    const team = createTeam();
    team.members[0] = createMember(54);
    team.members[1] = { ...createMember(124), rarity: 'LR' };
    const chosen = [], searched = [], filtered = [], closed = [];
    const props = { catalog: { characters: catalog.characters.filter(character => [54, 124, 85].includes(character.id)) }, team, targetIndex: 0, aliases: new Map(), elements: { red: { name: '红' }, green: { name: '绿' } }, freeCharacters: new Map([[85, { rarity: 'SR' }]]), search: '', element: 'all', onChoose: id => chosen.push(id), onSearch: value => searched.push(value), onElement: value => filtered.push(value), onClose: () => closed.push(true), renderPortrait: (character, rarity) => React.createElement('span', { 'data-character': character.id, 'data-rarity': rarity }), closeIcon: '×', searchIcon: '搜索' };
    const tree = CharacterPickerContents(props);
    const nodes = elements(tree);
    const tiles = nodes.filter(node => node.props.className?.startsWith('character-picker-tile'));
    assert.equal(tiles.length, 3);
    const current = tiles.find(node => node.props.disabled);
    assert.match(current.props['aria-label'], /当前角色/);
    const swap = tiles.find(node => /点击互换/.test(node.props['aria-label']));
    swap.props.onClick();
    assert.deepEqual(chosen, [124]);
    assert.equal(elements(swap).find(node => node.props['data-character'] === 124).props['data-rarity'], 'LR');
    nodes.find(node => node.props['aria-label'] === '查找角色名称或简称').props.onChange({ target: { value: '夏姆' } });
    nodes.find(node => node.type === 'button' && node.props.children === '红').props.onClick();
    nodes.find(node => node.props['aria-label'] === '关闭角色选择器').props.onClick();
    assert.deepEqual(searched, ['夏姆']);
    assert.deepEqual(filtered, ['red']);
    assert.equal(closed.length, 1);
    const emptyTarget = renderToStaticMarkup(CharacterPickerContents({ ...props, targetIndex: 2 }));
    assert.match(emptyTarget, /点击移入/);
    assert.doesNotMatch(emptyTarget, /点击互换|当前角色/);
    assert.match(renderToStaticMarkup(tree), /新角色保留该位置的稀有度与装备/);
    const emptySearch = renderToStaticMarkup(CharacterPickerContents({ ...props, search: '不存在的角色' }));
    assert.match(emptySearch, /没有找到角色/);
    assert.match(emptySearch, /0 位角色/);
  } finally { await server.close(); }
});

test('phone App rendering exposes five tap targets and guarded team actions while rules and roster start collapsed', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const originalWindow = globalThis.window;
  const originalStorage = globalThis.localStorage;
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    globalThis.window = { matchMedia: () => ({ matches: true }) };
    globalThis.localStorage = { getItem: () => null };
    const markup = renderToStaticMarkup(React.createElement(App, { catalog, policy, freeLibrary }));
    const emptyTargets = [...markup.matchAll(/<button[^>]*class="empty-slot-button"[^>]*>/g)].map(match => match[0]);
    assert.equal(emptyTargets.length, 5);
    for (const [index, button] of emptyTargets.entries()) {
      assert.match(button, /type="button"/);
      assert.ok(button.includes(`aria-label="为第 ${index + 1} 位选择角色"`));
      assert.doesNotMatch(button, /disabled/);
    }
    const actions = markup.match(/<div class="touch-team-actions" role="group" aria-label="手机配队操作">([\s\S]*?)<\/div>/)?.[1];
    assert.ok(actions);
    for (const label of ['更换角色', '调整站位', '移出角色']) assert.match(actions, new RegExp(`<button[^>]*disabled=""[^>]*>${label}<\\/button>`));
    assert.doesNotMatch(actions, /撤销移出/);
    const rosterTiles = [...markup.matchAll(/<div class="character-tile[^\"]*"[^>]*>/g)].map(match => match[0]);
    assert.ok(rosterTiles.length > 0);
    for (const tile of rosterTiles) assert.match(tile, /draggable="false"/);
    for (const className of ['mobile-mechanism-details', 'mobile-roster-details']) {
      const opening = markup.match(new RegExp(`<details class="${className}"[^>]*>`))?.[0];
      assert.ok(opening);
      assert.doesNotMatch(opening, /\bopen(?:=|\s|>)/);
    }
    assert.match(markup, /点击空位选人，点击队员编辑/);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
    await server.close();
  }
});

test('tapping an empty position opens targeted selection and adds its own gifted weapon without leaving stats or arcana', () => {
  const gift = freeLibrary.exclusiveWeapons.find(item => item.rarity === 'UR');
  assert.ok(gift);
  for (const page of ['stats', 'arcana']) {
    const original = createTeam();
    const session = phoneSession(original, page);
    session.invoke('chooseTeamPosition', 3);
    assert.equal(session.state.pickerIndex, 3);
    assert.equal(session.state.team, original, 'opening the picker does not edit the draft');
    session.invoke('chooseRosterCharacter', gift.characterId);
    assert.equal(session.state.selectedIndex, 3);
    assert.equal(session.state.pickerIndex, null);
    const member = session.state.team.members[3];
    assert.equal(member.characterId, gift.characterId);
    assert.equal(member.equipment[0].weaponOwnerCharacterId, gift.characterId);
    assert.equal(member.equipment[0].rarity, gift.rarity);
    assert.equal(member.equipment[0].level, gift.level);
    assert.equal(member.equipment[0].matchlessSacredTreasureLevel, 40);
    assert.equal(session.state.activePage, page);
    assert.deepEqual(session.pageChanges, []);
  }
});

test('touch replacement retains position rarity and equipment while existing characters swap or move without duplication', () => {
  const team = createTeam();
  team.members[0] = applyEquipmentPreset({ ...createMember(54), rarity: 'LR5' }, 'adaptive4', catalog, policy);
  team.members[0].equipment[0].legendSacredTreasureLevel = 10;
  team.members[0].equipment[0].runes[0] = { categoryId: 9, level: 10 };
  team.members[1] = createMember(124);
  const snapshot = JSON.stringify(team);
  const session = phoneSession(team, 'arcana');
  session.invoke('openCharacterPicker', 0);
  session.invoke('chooseRosterCharacter', 85);
  const replacement = session.state.team.members[0];
  assert.equal(replacement.characterId, 85);
  assert.equal(replacement.rarity, 'LR5');
  assert.deepEqual(replacement.equipment, team.members[0].equipment.map(gear => gear.slot === 1 ? { ...gear, weaponOwnerCharacterId: 85 } : gear));
  assert.equal(JSON.stringify(team), snapshot, 'original draft remains intact');
  session.invoke('openCharacterPicker', 0);
  session.invoke('chooseRosterCharacter', 124);
  assert.equal(session.state.team.members[0], team.members[1]);
  assert.equal(session.state.team.members[1], replacement);
  session.invoke('openCharacterPicker', 4);
  session.invoke('chooseRosterCharacter', 85);
  assert.equal(session.state.team.members[1], null);
  assert.equal(session.state.team.members[4], replacement);
  assert.equal(session.state.team.members.filter(member => member?.characterId === 85).length, 1);
  assert.equal(session.state.selectedIndex, 4);
  assert.equal(session.state.activePage, 'arcana');
  assert.deepEqual(session.pageChanges, []);
});

test('two-tap position adjustment moves whole member objects, supports empty destinations and preserves the current page', () => {
  const team = createTeam();
  team.members[0] = applyEquipmentPreset(createMember(54), 'adaptive4', catalog, policy);
  team.members[1] = createMember(124);
  const session = phoneSession(team, 'stats');
  session.invoke('chooseTeamPosition', 1);
  assert.equal(session.state.selectedIndex, 1, 'ordinary member taps only select that member');
  session.state.reorderMode = true;
  session.invoke('chooseTeamPosition', 4);
  assert.equal(session.state.swapFrom, null, 'an empty slot cannot be a move source');
  session.invoke('chooseTeamPosition', 0);
  assert.equal(session.state.swapFrom, 0);
  session.invoke('chooseTeamPosition', 0);
  assert.equal(session.state.swapFrom, null, 'tapping the source again clears the selection');
  session.invoke('chooseTeamPosition', 0);
  session.invoke('chooseTeamPosition', 1);
  assert.equal(session.state.team.members[0], team.members[1]);
  assert.equal(session.state.team.members[1], team.members[0]);
  assert.equal(session.state.selectedIndex, 0, 'editing continues on the originally selected member');
  assert.equal(session.state.reorderMode, false);
  session.state.reorderMode = true;
  session.invoke('chooseTeamPosition', 1);
  session.invoke('chooseTeamPosition', 4);
  assert.equal(session.state.team.members[1], null);
  assert.equal(session.state.team.members[4], team.members[0]);
  assert.equal(session.state.activePage, 'stats');
  assert.deepEqual(session.pageChanges, []);
});

test('touch removal can restore the complete previous draft and a later edit invalidates that undo', () => {
  const team = createTeam();
  team.members[0] = applyEquipmentPreset(createMember(54), 'adaptive4', catalog, policy);
  team.members[1] = createMember(124);
  const session = phoneSession(team, 'arcana');
  session.invoke('removeMember', 0);
  assert.equal(session.state.team.members[0], null);
  assert.equal(session.state.selectedIndex, 1);
  assert.equal(session.state.removedMember.team, team);
  session.invoke('undoRemoveMember');
  assert.equal(session.state.team, team);
  assert.equal(session.state.selectedIndex, 0);
  assert.equal(session.state.removedMember, null);
  session.invoke('removeMember', 0);
  const edited = { ...session.state.team, notes: '移出之后的新说明' };
  session.invoke('changeTeam', edited);
  session.invoke('undoRemoveMember');
  assert.equal(session.state.team, edited, 'undo must not discard a later equipment or plan edit');
  assert.equal(session.state.removedMember, null);
  assert.equal(session.state.activePage, 'arcana');
  assert.deepEqual(session.pageChanges, []);
});
