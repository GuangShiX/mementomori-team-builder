import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { calculateTeam, cloneTeam, createMember, createTeam, getBorrowableWeapons } from '../src/domain.mjs';

const [catalog, policy, freeLibrary] = await Promise.all(['catalog', 'pricing-policy', 'free-library'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
function nodes(element) {
  return React.isValidElement(element) ? [element, ...React.Children.toArray(element.props.children).flatMap(nodes)] : [];
}

test('picker admits N and R cards, identifies their origin and previews their catalog default rarity', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { CharacterPickerContents } = await server.ssrLoadModule('/src/CharacterPicker.jsx');
    const lowCards = [
      { id: 99001, name: '测试R角色', element: 'blue', baseRarity: 2, defaultRarity: 'LR5', allowedRarities: ['LR', 'LR5'], hasExclusiveWeapon: false },
      { id: 99002, name: '测试N角色', element: 'blue', baseRarity: 1, defaultRarity: 'N', allowedRarities: ['N'], hasExclusiveWeapon: false },
    ];
    const chosen = [];
    const tree = CharacterPickerContents({ catalog: { characters: lowCards }, team: createTeam(), targetIndex: 0, aliases: new Map(), elements: {}, freeCharacters: new Map([[99001, { rarity: 'LR5' }]]), search: '', element: 'all', onChoose: id => chosen.push(id), onSearch() {}, onElement() {}, onClose() {}, renderPortrait: (character, rarity) => React.createElement('span', { 'data-character': character.id, 'data-rarity': rarity }) });
    const markup = renderToStaticMarkup(tree);
    assert.match(markup, /R卡 · LR5 免费/);
    assert.match(markup, /N卡/);
    assert.match(markup, /data-character="99001" data-rarity="LR5"/);
    assert.match(markup, /data-character="99002" data-rarity="N"/);
    nodes(tree).filter(node => node.props.className === 'character-picker-tile').forEach(node => node.props.onClick());
    assert.deepEqual(chosen, [99001, 99002]);
  } finally { await server.close(); }
});

test('R card draft renders its allowed rarity list and one configured whole-team grace inside the net budget', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const original = globalThis.localStorage;
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const character = catalog.characters.find(item => item.baseRarity === 2);
    assert.ok(character);
    const team = createTeam();
    team.members[0] = createMember(character);
    globalThis.localStorage = { getItem: () => JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team: cloneTeam(team) }) };
    const cost = calculateTeam(team, catalog, policy, freeLibrary);
    const format = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
    const markup = renderToStaticMarkup(React.createElement(App, { catalog, policy, freeLibrary }));
    const rarityControl = markup.match(/<select aria-label="角色稀有度"[^>]*>([\s\S]*?)<\/select>/)?.[1];
    assert.ok(rarityControl);
    assert.deepEqual([...rarityControl.matchAll(/<option value="([^"]*)"/g)].map(match => match[1]), character.allowedRarities);
    assert.match(rarityControl, /value="LR5" selected=""/);
    const configured = policy.blessings.find(blessing => blessing.teamDiamondAllowance)?.teamDiamondAllowance.amount;
    assert.ok(markup.includes(`整队额外 ${format(configured)} 钻免费`));
    assert.ok(markup.includes('可用于任何费用 · 不随人数叠加'));
    assert.equal((markup.match(/aria-label="R和N卡整队免费钻石额度"/g) ?? []).length, 1);
    assert.ok(markup.includes(`已使用 ${format(cost.teamDiamondAllowanceCredit)} 钻`));
    assert.ok(markup.includes(`<strong>${format(cost.totalDiamonds)}</strong>`));
    assert.doesNotMatch(markup, /NaN|undefined|已恢复可识别的草稿配置/);
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
    await server.close();
  }
});

test('R and N weapon controls select real unclaimed same-job gifts and never manufacture an own exclusive weapon', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { EquipmentEditor } = await server.ssrLoadModule('/src/App.jsx');
    const gift = freeLibrary.exclusiveWeapons.filter(item => item.rarity === 'UR').sort((a, b) => b.level - a.level)[0];
    const giftOwner = catalog.characters.find(character => character.id === gift.characterId);
    for (const baseRarity of [1, 2]) {
      const character = { ...giftOwner, id: 99000 + baseRarity, name: `测试${baseRarity}角色`, baseRarity, hasExclusiveWeapon: false, exclusiveWeaponName: undefined, exclusiveWeaponIcon: undefined };
      const localCatalog = { ...catalog, characters: [...catalog.characters, character] };
      const member = createMember(character.id);
      member.rarity = 'LR5';
      const normalGear = { ...member.equipment[0], rarity: 'SSR', seriesId: 0, weaponKind: 'normal', weaponOwnerCharacterId: character.id, level: 450 };
      member.equipment[0] = normalGear;
      const team = createTeam();
      team.members[0] = member;
      const available = getBorrowableWeapons(team, 0, localCatalog, freeLibrary);
      assert.ok(available.length);
      const changed = [];
      const props = { gear: normalGear, index: 0, member, catalog: localCatalog, policy, freeLibrary, onChange: gear => changed.push(gear), errors: [], memberIndex: 0, inventory: [], borrowableWeapons: available, ownWeaponClaimed: false };
      const tree = EquipmentEditor(props);
      const types = nodes(tree).find(node => node.props['aria-label'] === '武器类型');
      assert.deepEqual(nodes(types).filter(node => node.type === 'option').map(node => node.props.value), ['normal']);
      nodes(tree).find(node => node.props['aria-label'] === '武器切换UR').props.onClick();
      const borrowed = changed.pop();
      assert.equal(borrowed.weaponOwnerCharacterId, available[0].characterId);
      assert.equal(borrowed.level, available[0].level);
      assert.equal(borrowed.weaponKind, 'exclusive');
      assert.equal(borrowed.rarity, 'UR');
      const borrowedTree = EquipmentEditor({ ...props, gear: borrowed });
      const ownerSelect = nodes(borrowedTree).find(node => node.props['aria-label'] === '专武所属角色');
      assert.ok(ownerSelect);
      assert.equal(nodes(ownerSelect).some(node => node.type === 'option' && Number(node.props.value) === character.id), false);
      nodes(borrowedTree).find(node => node.props['aria-label'] === '武器切换LR').props.onClick();
      assert.equal(changed.at(-1).rarity, 'LR');
      assert.equal(changed.at(-1).weaponOwnerCharacterId, available[0].characterId);
      const noAvailableTree = EquipmentEditor({ ...props, borrowableWeapons: [] });
      for (const rarity of ['UR', 'LR']) {
        const tier = nodes(noAvailableTree).find(node => node.props['aria-label'] === `武器切换${rarity}`);
        assert.equal(tier.props.disabled, true);
        const oldCount = changed.length;
        tier.props.onClick();
        assert.equal(changed.length, oldCount);
      }
      nodes(borrowedTree).find(node => node.props['aria-label'] === '武器切换SSR').props.onClick();
      assert.equal(changed.at(-1).weaponKind, 'normal');
      assert.equal(changed.at(-1).weaponOwnerCharacterId, character.id);
    }
  } finally { await server.close(); }
});
