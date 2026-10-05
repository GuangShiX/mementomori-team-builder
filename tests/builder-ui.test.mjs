import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTeam, createMember, cloneTeam, calculateTeam, migrateLegacyWeaponConfiguration, selectEquipmentRarity } from '../src/domain.mjs';
import { placeRosterCharacter } from '../src/team-interactions.mjs';

const [catalog, policy, freeLibrary, nameAliases] = await Promise.all(['catalog', 'pricing-policy', 'free-library', 'name-aliases'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
const amount = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);

async function renderDraft(team, displayedCatalog = catalog) {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const original = globalThis.localStorage;
  const raw = JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team });
  try {
    globalThis.localStorage = { getItem: () => raw };
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    return renderToStaticMarkup(React.createElement(App, { catalog: displayedCatalog, policy, freeLibrary, nameAliases }));
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
    await server.close();
  }
}

function assertAutomaticControls(markup) {
  assert.doesNotMatch(markup, /aria-label="武器同步配置"|aria-label="武器同步位"|aria-label="队外基准费用"|添加队外基准|将队外专武装备给队员|基准武器等级/);
  assert.doesNotMatch(markup, /NaN|undefined/);
}

test('builder displays a nameless framed team to the right of the selected character in the central header', async () => {
  const displayedCatalog = {
    ...catalog,
    elementIcons: Object.fromEntries(Object.keys(catalog.elementIcons).map(key => [key, `./custom-elements/${key}.png`])),
    teamFrame: './custom-elements/team-frame.png',
    iconArt: { ...catalog.iconArt, frames: Object.fromEntries(Object.keys(catalog.iconArt.frames).map(key => [key, `./custom-elements/frame-${key}.png`])) },
    characters: catalog.characters.map(character => character.id === 124 ? { ...character, name: '【SP】特殊标识角色', subtitle: '固定一行副标题' } : character.id === 85 ? { ...character, subtitle: '' } : character),
  };
  const team = createTeam();
  team.members[0] = createMember(124);
  team.members[0].rarity = 'LR5';
  team.members[1] = createMember(85);
  Object.assign(team.members[0].equipment[0], { rarity: 'SSR', seriesId: 12, weaponKind: 'exclusive', level: 240 });
  team.members[0].equipment[0].runes[0] = { categoryId: 1, level: 11 };
  const markup = await renderDraft(cloneTeam(team), displayedCatalog);
  const selection = markup.match(/<aside class="panel catalog-panel left-column" aria-label="选择角色">([\s\S]*?)<\/aside>/)?.[1];
  const lineup = markup.match(/<section class="team-panel" aria-label="当前五人配队">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(selection && lineup);
  assert.doesNotMatch(selection, /team-panel|我的配队/);
  assert.ok(markup.indexOf('aria-label="当前角色装备配置"') < markup.indexOf('aria-label="当前五人配队"'));
  assert.ok(markup.indexOf('class="selected-character-header"') < markup.indexOf('aria-label="当前五人配队"'));
  assert.ok(markup.indexOf('aria-label="当前五人配队"') < markup.indexOf('class="equip-grid"'));
  assert.doesNotMatch(selection, /class="panel team-panel"|class="member-actions"|title="前移"|title="后移"|title="移除角色"/);
  assert.match(selection, /将队员拖回此目录可移出配队/);
  assert.doesNotMatch(selection, /双击|单击加入/);
  assert.equal((lineup.match(/class="team-slot(?: |")/g) ?? []).length, 5);
  assert.equal((lineup.match(/class="member-rarity"/g) ?? []).length, 2);
  assert.equal((lineup.match(/class="member-level">Lv\.450/g) ?? []).length, 2);
  assert.equal((lineup.match(/class="member-equipment-item/g) ?? []).length, 12);
  assert.match(lineup, /class="member-matchless"[^>]*>魔装 0<\/span>/);
  assert.match(lineup, /class="member-matchless"[^>]*>未装备<\/span>/);
  assert.doesNotMatch(lineup, /class="member-name"|class="member-subtitle"/);
  assert.doesNotMatch(lineup.replace(/<[^>]*>/g, ''), /【SP】特殊标识角色|固定一行副标题/);
  assert.match(lineup, /aria-label="配置【SP】特殊标识角色 · 固定一行副标题，位置1" aria-pressed="true"/);
  assert.match(lineup, /--team-frame-image:url\(&quot;\.\/custom-elements\/team-frame\.png&quot;\)/);
  assert.equal((lineup.match(/background-image:url\(&quot;(?:data:image\/svg\+xml,|[^&]*team-seat\.svg)/g) ?? []).length, 5);
  assert.equal((selection.match(/class="tile-subtitle"/g) ?? []).length, catalog.characters.length);
  assert.equal((selection.match(/class="tile-free-cap"/g) ?? []).length, catalog.characters.length);
  for (const key of Object.keys(catalog.elementIcons)) {
    assert.ok(markup.includes(`class="element-badge" src="./custom-elements/${key}.png"`));
  }
  assert.equal((markup.match(/class="element-badge"/g) ?? []).length, catalog.characters.length + 3, 'roster, both occupied seats and selected portrait must use the catalog icons');
  assert.match(lineup, /class="game-icon-frame" data-rarity="LR5" data-frame="lr"/);
  assert.equal((markup.match(/class="rarity-stars"/g) ?? []).length, 2, 'the team and selected portrait use current LR5, while catalog portraits remain SR');
  assert.match(selection, /class="game-icon-frame" data-rarity="SR" data-frame="common"/);
  assert.match(markup, /border-image-source:url\(&quot;\.\/custom-elements\/frame-lr\.png&quot;\)/);
  assert.match(markup, /border-image-slice:26 25 25 25/);
  assert.doesNotMatch(markup, /class="equipment-art-fallback"/);
  assert.doesNotMatch(markup, /--element-color|<span class="element-badge"/);
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.tile-name\{height:14px;line-height:14px\}/);
  assert.match(css, /\.tile-subtitle\{height:11px;line-height:11px\}/);
  assert.match(css, /\.portrait-frame \.portrait-image\{[^}]*object-fit:cover/);
  assert.match(css, /\.portrait-frame \.element-badge\{[^}]*width:19px;[^}]*height:19px;object-fit:contain/);
  assert.match(css, /\.team-slot\{[^}]*aspect-ratio:100\/104/);
  assert.match(css, /\.portrait-frame\.has-rarity-frame\{overflow:visible/);
  assert.match(css, /\.rune-holes\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css, /\.rune-holes\{[^}]*grid-template-columns:1fr|\.rune-holes\{[^}]*repeat\(2/);
  assert.match(markup, /class="rune-number">第 1 孔<\/span>/);
  assert.equal((markup.match(/class="rune-level-label">等级/g) ?? []).length, 4);
  assert.equal((markup.match(/class="equipment-tier-button/g) ?? []).length, 18);
  assert.match(markup, /aria-label="武器切换LR" aria-pressed="false"/);
  assert.doesNotMatch(css, /\.portrait-frame img\{|--element-color|@media\([^{}]+\)\{\}/);
  assert.ok(markup.indexOf('aria-label="角色目录"') < markup.indexOf('aria-label="当前角色装备配置"'));
  assert.match(markup, /draggable="true"/);
  assert.match(markup, /<option value="11" selected="">Lv\.11<\/option>/);
  assert.match(markup, /<option value="10">Lv\.10<\/option>/);
  assert.match(markup, /Lv\.11 × 3、Lv\.10 × 3/);
  assert.match(markup, /aria-label="专武造价"/);
  assert.match(markup, /紫水晶等价 82\.5 个/);
  assert.match(markup, /免费库抵扣/);
  assert.doesNotMatch(markup, /已恢复可识别的草稿配置/, 'a current canonical draft must not repeatedly create migration backups');
  assertAutomaticControls(markup);
});

test('automatic third-weapon fabrication discount leaves all actual levels and reinforcement at 450', async () => {
  const team = createTeam();
  team.members = [85, 124, 96, 86, 100].map(characterId => {
    const member = createMember(characterId);
    member.rarity = 'LR5';
    Object.assign(member.equipment[0], { rarity: 'LR', seriesId: 14, weaponKind: 'exclusive', level: 450, reinforcementLevel: 420 });
    return member;
  });
  Object.assign(team.members[0].equipment[4], { rarity: 'LR', seriesId: 14, level: 450 });
  const cost = calculateTeam(team, catalog, policy, freeLibrary);
  const markup = await renderDraft(cloneTeam(team));
  assert.equal((markup.match(/class="automatic-weapon-credit"/g) ?? []).length, 1);
  assert.match(markup, /自动同步 · 制作材料按 Lv\.300 计算；强化与叶子按实际配置计费/);
  assert.match(markup, /aria-label="武器装备等级"[\s\S]*?<option value="450" selected="">Lv\. 450<\/option>/);
  assert.match(markup, /aria-label="武器强化等级"[^>]*max="450"[^>]*value="420"/);
  assert.match(markup, /aria-label="叶子造价"/);
  assert.match(markup, /铠甲 LR/);
  assert.match(markup, /20,000 钻/);
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  assertAutomaticControls(markup);
});

test('a new dragged member displays default magic level 40 and preserves zero or mixed levels from existing gear', async () => {
  const character = catalog.characters.find(item => item.id === 124);
  const team = placeRosterCharacter(createTeam(), character, 0, { catalog, freeLibrary }).team;
  const defaults = await renderDraft(cloneTeam(team));
  assert.match(defaults, /class="member-matchless"[^>]*>魔装 40<\/span>/);
  assert.match(defaults, /aria-label="武器魔装等级"[^>]*value="40"/);
  assert.match(defaults, /aria-label="武器切换LR，需要LR5角色" aria-pressed="false" disabled=""/);
  assert.match(defaults, /新装备默认魔装 40，可按实际配置调整/);
  team.members[0].equipment[1] = { ...selectEquipmentRarity(team.members[0].equipment[1], 'SSR'), matchlessSacredTreasureLevel: 0 };
  team.members[0].equipment[3] = { ...selectEquipmentRarity(team.members[0].equipment[3], 'SSR'), matchlessSacredTreasureLevel: 17 };
  const previous = JSON.stringify(team);
  const mixed = await renderDraft(cloneTeam(team));
  assert.match(mixed, /class="member-matchless"[^>]*>魔装 0–40<\/span>/);
  assert.match(mixed, /aria-label="饰品 SSR 魔装0"/);
  assert.match(mixed, /aria-label="头盔 SSR 魔装17"/);
  assert.match(mixed, /aria-label="饰品魔装等级"[^>]*value="0"/);
  assert.match(mixed, /aria-label="头盔魔装等级"[^>]*value="17"/);
  assert.equal(JSON.stringify(team), previous, 'existing zero and mixed magic values are never overwritten on rendering');
  assertAutomaticControls(mixed);
});

test('legacy synchronized draft preserves the effective weapon level and removes outside source charges', async () => {
  const team = createTeam();
  team.members[0] = createMember(85);
  team.members[0].rarity = 'LR5';
  Object.assign(team.members[0].equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, syncSlot: 1, reinforcementLevel: 420 });
  team.weaponSources = [8, 27].map(characterId => ({ characterId, characterRarity: 'LR5', rarity: 'UR', level: 450 }));
  const migrated = migrateLegacyWeaponConfiguration(team, catalog, policy, freeLibrary);
  const cost = calculateTeam(migrated.team, catalog, policy, freeLibrary);
  const original = JSON.stringify(team);
  const markup = await renderDraft(team);
  assert.match(markup, /已按当前规则恢复旧版武器等级，原草稿会另存备份/);
  assert.match(markup, /队外同步配置已移除，全部费用按当前配队重新计算/);
  assert.match(markup, /aria-label="武器强化等级"[^>]*max="450"[^>]*value="420"/);
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  assert.equal(cost.characterCosts.length, 1);
  assert.equal(cost.exclusiveWeaponCosts.length, 1);
  assert.equal(JSON.stringify(team), original, 'migration must not mutate the original backup contents');
  assertAutomaticControls(markup);
});

test('unsafe legacy synchronization does not become a hidden uneditable charge', async () => {
  const team = createTeam();
  team.members[0] = createMember(85);
  Object.assign(team.members[0].equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 300, syncSlot: 2 });
  team.weaponSources = [];
  const markup = await renderDraft(team);
  assert.match(markup, /原草稿无法完整恢复，已保留原始内容并尝试另存备份/);
  assert.match(markup, /从一名角色开始/);
  assertAutomaticControls(markup);
});

test('borrowed free UR weapon keeps its ownership warning without manual synchronization controls', async () => {
  const team = createTeam();
  team.members[0] = createMember(153);
  Object.assign(team.members[0].equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', weaponOwnerCharacterId: 27, level: 300 });
  const markup = await renderDraft(cloneTeam(team));
  assert.match(markup, /aria-label="专武所属角色"/);
  assert.match(markup, /<option value="27" selected="">科迪 · 免费 UR Lv\.300<\/option>/);
  assert.match(markup, /同职业借用/);
  assert.match(markup, /不提供当前角色的专武技能/);
  assert.doesNotMatch(markup, /aria-label="武器类型"/);
  const owner = catalog.characters.find(item => item.id === 27);
  assert.ok(markup.includes(`class="equipment-art-image" src="${owner.exclusiveWeaponIcon}"`), 'borrowed equipment icons show the weapon owner');
  assertAutomaticControls(markup);
});
