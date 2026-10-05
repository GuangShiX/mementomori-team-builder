import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTeam, createMember, cloneTeam } from '../src/domain.mjs';

test('builder renders standings above roster, tier selectors and the free exclusive weapon detail without a browser', async () => {
  const [catalog, policy, freeLibrary, nameAliases] = await Promise.all(['catalog', 'pricing-policy', 'free-library', 'name-aliases'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const original = globalThis.localStorage;
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const team = createTeam();
    team.members[0] = createMember(124);
    const weapon = team.members[0].equipment[0];
    Object.assign(weapon, { rarity: 'SSR', seriesId: 12, weaponKind: 'exclusive', level: 240 });
    weapon.runes[0] = { categoryId: 1, level: 11 };
    globalThis.localStorage = { getItem: () => JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team: cloneTeam(team) }) };
    const markup = renderToStaticMarkup(React.createElement(App, { catalog, policy, freeLibrary, nameAliases }));
    assert.ok(markup.indexOf('aria-label="当前五人配队"') < markup.indexOf('aria-label="角色目录"'));
    assert.ok(markup.indexOf('aria-label="角色目录"') < markup.indexOf('aria-label="当前角色装备配置"'));
    assert.match(markup, /draggable="true"/);
    assert.match(markup, /双击替换选中角色/);
    assert.match(markup, /<option value="11" selected="">Lv\.11<\/option>/);
    assert.match(markup, /<option value="10">Lv\.10<\/option>/);
    assert.match(markup, /Lv\.11 × 3、Lv\.10 × 3/);
    assert.match(markup, /aria-label="专武造价"/);
    assert.match(markup, /紫水晶等价 82\.5 个/);
    assert.match(markup, /免费库抵扣/);
    assert.doesNotMatch(markup, /NaN|undefined/);
    assert.doesNotMatch(markup, /已恢复可识别的草稿配置/, 'a current canonical draft must not repeatedly create migration backups');
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
    await server.close();
  }
});

test('restored weapon synchronization shows effective reinforcement limit, reserve pricing and every LR armor leaf cost', async () => {
  const [catalog, policy, freeLibrary, nameAliases] = await Promise.all(['catalog', 'pricing-policy', 'free-library', 'name-aliases'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const original = globalThis.localStorage;
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const team = createTeam();
    team.members[0] = createMember(85);
    team.members[0].rarity = 'LR5';
    Object.assign(team.members[0].equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, syncSlot: 1, reinforcementLevel: 420 });
    Object.assign(team.members[0].equipment[4], { rarity: 'LR', seriesId: 14, level: 450 });
    team.weaponSources = [8, 27].map(characterId => ({ characterId, characterRarity: 'LR5', rarity: 'UR', level: 450 }));
    globalThis.localStorage = { getItem: () => JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team }) };
    const markup = renderToStaticMarkup(React.createElement(App, { catalog, policy, freeLibrary, nameAliases }));
    assert.ok(markup.indexOf('aria-label="当前角色装备配置"') < markup.indexOf('aria-label="武器同步配置"'));
    assert.match(markup, /同步后 Lv\.450/);
    assert.match(markup, /aria-label="武器强化等级"[^>]*max="450"[^>]*value="420"/);
    assert.match(markup, /武器基础等级/);
    assert.match(markup, /aria-label="队外基准费用"/);
    assert.match(markup, /aria-label="叶子造价"/);
    assert.match(markup, /铠甲 LR/);
    assert.match(markup, /20,000 钻/);
    assert.match(markup, /基准武器等级/);
    assert.doesNotMatch(markup, /NaN|undefined/);
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
    await server.close();
  }
});

test('a reserve conflicting with a later team choice survives draft restore and offers an explicit repair', async () => {
  const [catalog, policy, freeLibrary, nameAliases] = await Promise.all(['catalog', 'pricing-policy', 'free-library', 'name-aliases'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const original = globalThis.localStorage;
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const team = createTeam();
    team.members[0] = createMember(8);
    Object.assign(team.members[0].equipment[0], { rarity: 'SSR', seriesId: 12, weaponKind: 'exclusive', weaponOwnerCharacterId: 8, level: 180 });
    team.weaponSources = [{ characterId: 8, characterRarity: 'LR5', rarity: 'UR', level: 320 }];
    globalThis.localStorage = { getItem: () => JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team }) };
    const markup = renderToStaticMarkup(React.createElement(App, { catalog, policy, freeLibrary, nameAliases }));
    assert.match(markup, /将队外专武装备给队员/);
    assert.match(markup, /该专武已在队伍中使用/);
    assert.match(markup, /佛罗伦斯基准武器等级/);
    assert.match(markup, /value="320" selected=""/);
    assert.doesNotMatch(markup, /NaN|undefined/);
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
    await server.close();
  }
});

test('borrowed free UR weapon survives a draft restore and clearly disables its own skill and self-funded sync', async () => {
  const [catalog, policy, freeLibrary, nameAliases] = await Promise.all(['catalog', 'pricing-policy', 'free-library', 'name-aliases'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const original = globalThis.localStorage;
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    const team = createTeam();
    team.members[0] = createMember(153);
    Object.assign(team.members[0].equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', weaponOwnerCharacterId: 27, level: 300 });
    globalThis.localStorage = { getItem: () => JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team }) };
    const markup = renderToStaticMarkup(React.createElement(App, { catalog, policy, freeLibrary, nameAliases }));
    assert.match(markup, /aria-label="专武所属角色"/);
    assert.match(markup, /<option value="27" selected="">科迪 · 免费 UR Lv\.300<\/option>/);
    assert.match(markup, /同职业借用/);
    assert.match(markup, /不提供当前角色的专武技能/);
    assert.doesNotMatch(markup, /aria-label="武器类型"/);
    assert.match(markup, /<option value="1" disabled="">同步位 1 · 需 2 把基准<\/option>/);
    assert.doesNotMatch(markup, /NaN|undefined/);
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
    await server.close();
  }
});
