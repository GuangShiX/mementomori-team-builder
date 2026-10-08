import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTeam, createMember, cloneTeam, calculateTeam, validateTeam, migrateLegacyWeaponConfiguration, selectEquipmentRarity, getArcanaState, setArcanaPurchased, getResourceAllowance } from '../src/domain.mjs';
import { placeRosterCharacter } from '../src/team-interactions.mjs';
import { getEquipmentPresetOptions, applyEquipmentPreset, changeMemberRarity } from '../src/equipment-presets.mjs';
import { calculateCharacterStats } from '../src/character-stats.mjs';
import { fillColumnEmptyRunes, updateColumnRune } from '../src/rune-interactions.mjs';

const [baseCatalog, policy, freeLibrary, nameAliases, arcana, equipmentBonuses, characterStats] = await Promise.all(['catalog', 'pricing-policy', 'free-library', 'name-aliases', 'arcana-catalog', 'equipment-bonuses', 'character-stats'].map(async name => JSON.parse(await readFile(new URL(`../public/data/${name}.json`, import.meta.url)))));
const catalog = { ...baseCatalog, arcana, equipmentBonuses, characterStats };
const amount = value => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);

async function renderDraft(team, displayedCatalog = catalog, displayedPolicy = policy) {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const original = globalThis.localStorage;
  const raw = JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team });
  try {
    globalThis.localStorage = { getItem: () => raw };
    const { default: App } = await server.ssrLoadModule('/src/App.jsx');
    return renderToStaticMarkup(React.createElement(App, { catalog: displayedCatalog, policy: displayedPolicy, freeLibrary, nameAliases }));
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
    await server.close();
  }
}

async function renderArcana(team) {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { ArcanaEditor } = await server.ssrLoadModule('/src/App.jsx');
    return renderToStaticMarkup(React.createElement(ArcanaEditor, { state: getArcanaState(team, catalog, policy, freeLibrary), catalog, onPurchase() {} }));
  } finally { await server.close(); }
}

async function renderStats(result) {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { CharacterStatsPanel } = await server.ssrLoadModule('/src/App.jsx');
    return renderToStaticMarkup(React.createElement(CharacterStatsPanel, { result, policy }));
  } finally { await server.close(); }
}

async function renderEquipmentEditors(team, part = 'B', displayedCatalog = catalog) {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  const original = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: () => JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team }) };
    const { EquipmentEditor, restoreDraft } = await server.ssrLoadModule('/src/App.jsx');
    const restored = restoreDraft(displayedCatalog, policy, freeLibrary).team;
    const member = restored.members.find(Boolean);
    const memberIndex = restored.members.indexOf(member);
    const validation = validateTeam(restored, displayedCatalog, policy, { freeLibrary });
    const inventory = validation.valid ? calculateTeam(restored, displayedCatalog, policy, freeLibrary).fixedRuneInventory : [];
    return renderToStaticMarkup(React.createElement(React.Fragment, null, member.equipment.map((gear, index) => React.createElement(EquipmentEditor, {
      key: gear.slot, part, gear, index, member, memberIndex, catalog: displayedCatalog, policy, freeLibrary,
      errors: validation.errors, inventory, borrowableWeapons: [], ownWeaponClaimed: false, onChange() {},
    }))));
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
    await server.close();
  }
}

const arcanaCard = (markup, group) => markup.split(`aria-label="${group.name}"`)[1]?.split('</section>')[0];

test('resource price help reflects policy unit prices and exchange rates rather than hardcoded quotes', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { ResourcePriceHelp } = await server.ssrLoadModule('/src/App.jsx');
    const render = displayedPolicy => renderToStaticMarkup(React.createElement(ResourcePriceHelp, { policy: displayedPolicy }));
    const current = render(policy);
    for (const price of [policy.unitPrices.characterCopy, policy.unitPrices.runeTickets, policy.unitPrices.reinforcementMedicine, policy.unitPrices.lifeTreeDew]) assert.ok(current.includes(`${amount(price)} 钻`));
    assert.ok(current.includes(`UR / LR 装备碎片</th><td>${amount(policy.unitPrices.urLrFragments * policy.conversions.urLrFragmentsPerExchange)} 钻<small>/ 50片</small>`));
    assert.ok(current.includes(`专武碎片</th><td>${amount(policy.unitPrices.exclusiveFragments * policy.conversions.exclusiveFragmentsPerExchange)} 钻<small>/ 10片</small>`));
    assert.ok(current.includes(`${amount(policy.conversions.relicMaterialPrice)} 钻`));
    assert.ok(current.includes(`${amount(policy.conversions.magicCrystalPrice)} 钻`));
    assert.match(current, /本次普通 SSR 制作免费/);
    const snapshot = JSON.stringify(policy);
    const changed = structuredClone(policy);
    changed.unitPrices.characterCopy = 13500;
    changed.unitPrices.urLrFragments = 125;
    changed.unitPrices.exclusiveFragments = 36;
    changed.conversions.relicMaterialsPerExchange = 5;
    changed.conversions.urLrFragmentsPerExchange = 40;
    changed.conversions.magicCrystalsPerExclusiveExchange = 4;
    changed.conversions.exclusiveFragmentsPerExchange = 12;
    changed.blessings = changed.blessings.filter(item => item.effect !== 'freeEquipmentCrafting');
    const configured = render(changed);
    assert.match(configured, /13,500 钻/);
    assert.match(configured, /圣遗物材料<\/th><td>1,000 钻/);
    assert.match(configured, /紫水晶<\/th><td>108 钻/);
    assert.match(configured, /UR \/ LR 装备碎片<\/th><td>5,000 钻<small>\/ 40片<\/small>/);
    assert.match(configured, /专武碎片<\/th><td>432 钻<small>\/ 12片<\/small>/);
    assert.match(configured, /5 个圣遗物材料 = 40 片 UR \/ LR 装备碎片/);
    assert.match(configured, /4 个紫水晶 = 12 片专武碎片/);
    assert.doesNotMatch(configured, /本次普通 SSR 制作免费/);
    assert.equal(JSON.stringify(policy), snapshot);
  } finally { await server.close(); }
});

function assertAutomaticControls(markup) {
  assert.doesNotMatch(markup, /aria-label="武器同步配置"|aria-label="武器同步位"|aria-label="队外基准费用"|添加队外基准|将队外专武装备给队员|基准武器等级/);
  assert.doesNotMatch(markup, /NaN|undefined/);
}

function divMarkup(markup, openingMarker) {
  const start = markup.indexOf(openingMarker);
  assert.ok(start >= 0, `missing ${openingMarker}`);
  let depth = 0;
  for (const token of markup.slice(start).matchAll(/<\/?div\b[^>]*>/g)) {
    depth += token[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return markup.slice(start, start + token.index + token[0].length);
  }
  assert.fail(`unclosed ${openingMarker}`);
}

function costFoldout(markup, label, className) {
  const match = markup.match(new RegExp(`<details(?=[^>]*class="cost-foldout ${className}")(?=[^>]*aria-label="${label}")([^>]*)>([\\s\\S]*?)<\\/details>`));
  assert.ok(match, `missing cost foldout ${label}`);
  assert.doesNotMatch(match[1], /\bopen(?:=|\s|$)/, `${label} starts collapsed`);
  const summary = match[2].match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1];
  assert.ok(summary, `missing cost summary ${label}`);
  const content = divMarkup(match[0], '<div class="cost-foldout-content"');
  return { markup: match[0], summary, content };
}

test('builder displays a nameless framed team to the right of the selected character in the central header', async () => {
  const displayedCatalog = {
    ...catalog,
    elementIcons: Object.fromEntries(Object.keys(catalog.elementIcons).map(key => [key, `./custom-elements/${key}.png`])),
    jobIcons: Object.fromEntries([1, 2, 4].map(key => [key, `./custom-jobs/${key}.png`])),
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
  const sticky = divMarkup(markup, '<div class="workbench-sticky"');
  const overview = divMarkup(markup, '<div id="team-equipment-overview"');
  const heading = divMarkup(markup, '<div class="workbench-heading"');
  assert.ok(selection && lineup);
  const stickyStart = markup.indexOf(sticky);
  const stickyEnd = stickyStart + sticky.length;
  assert.match(overview, /^<div[^>]*class="team-equipment-overview"[^>]*hidden=""/);
  assert.match(sticky, /<button(?=[^>]*aria-expanded="false")(?=[^>]*aria-controls="team-equipment-overview")[^>]*>展开概览<\/button>/);
  assert.match(sticky, /class="character-overview-controls"/);
  assert.match(sticky, /class="selected-character-header"/);
  assert.ok(sticky.includes(lineup));
  assert.doesNotMatch(sticky, /member-equipment-summary|member-matchless|member-equipment-item|workbench-heading|gear-panel-heading|team-header-controls|新建方案|我的配队|team-note|workspace-tabs/);
  assert.match(heading, /角色与装备/);
  assert.match(heading, /我的配队/);
  assert.match(heading, /新建方案/);
  assert.ok(markup.indexOf(heading) + heading.length <= stickyStart);
  assert.ok(markup.indexOf(overview) >= stickyEnd, 'the hidden equipment overview stays outside the sticky identity and lineup');
  assert.ok(markup.indexOf('class="workspace-tabs"') >= stickyEnd, 'tabs scroll with their page content');
  assert.match(markup, /新建方案/);
  assert.equal((overview.match(/class="team-equipment-position"/g) ?? []).length, 5);
  assert.equal((overview.match(/class="member-equipment-summary"/g) ?? []).length, 2);
  for (const position of [1, 2]) assert.ok(overview.includes(`aria-label="位置${position}装备与魔装"`));
  assert.doesNotMatch(selection, /team-panel|<h[23]>我的配队/);
  assert.match(selection, /<section class="plan-panel" aria-label="方案信息">/);
  assert.ok(selection.indexOf('aria-label="方案信息"') > selection.indexOf('class="catalog-help"'));
  assert.ok(markup.indexOf('aria-label="当前角色装备配置"') < markup.indexOf('aria-label="当前五人配队"'));
  assert.ok(markup.indexOf('class="selected-character-header"') < markup.indexOf('aria-label="当前五人配队"'));
  assert.ok(markup.indexOf('aria-label="当前五人配队"') < markup.indexOf('class="equip-grid"'));
  assert.doesNotMatch(selection, /class="panel team-panel"|class="member-actions"|title="前移"|title="后移"|title="移除角色"/);
  assert.match(selection, /将队员拖回此目录可移出配队/);
  assert.doesNotMatch(selection, /双击|单击加入/);
  assert.equal((lineup.match(/class="team-slot(?: |")/g) ?? []).length, 5);
  assert.doesNotMatch(lineup, /class="member-rarity"|class="member-level"/);
  assert.equal((lineup.match(/class="member-speed"/g) ?? []).length, 2);
  const owned = getArcanaState(team, displayedCatalog, policy, freeLibrary);
  for (const member of team.members.filter(Boolean)) {
    const speed = calculateCharacterStats(member, displayedCatalog, policy, owned).rows.find(row => row.key === 'Speed').displayValue;
    assert.ok(lineup.includes(`>速度 ${speed}</span>`));
  }
  assert.equal((overview.match(/class="member-equipment-item/g) ?? []).length, 12);
  assert.match(overview, /class="member-matchless"[^>]*>魔装 0<\/span>/);
  assert.match(overview, /class="member-matchless"[^>]*>未装备<\/span>/);
  assert.doesNotMatch(lineup, /member-equipment-summary|member-matchless|member-equipment-item/);
  assert.equal((lineup.match(/<div class="team-slot[^\"]*"[^>]*draggable="true"/g) ?? []).length, 2);
  assert.equal((lineup.match(/<div class="team-slot[^\"]*"[^>]*draggable="false"/g) ?? []).length, 3);
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
  for (const [job, name] of [[1, '战士'], [2, '射手'], [4, '法师']]) {
    assert.ok(markup.includes(`class="job-badge" src="./custom-jobs/${job}.png" alt="${name}" title="${name}"`));
  }
  assert.equal((markup.match(/class="job-badge"/g) ?? []).length, catalog.characters.length + 3, 'profession icons follow the catalog in roster, seats and selected portrait');
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
  assert.match(css, /\.portrait-frame \.element-badge,\.portrait-frame \.job-badge\{[^}]*width:24%;height:24%;object-fit:contain/);
  assert.doesNotMatch(css, /[^{}]*\.(?:element|job)-badge[^{}]*\{[^}]*(?:width|height):[\d.]+px/);
  assert.match(css, /\.team-slot\{[^}]*aspect-ratio:100\/104/);
  assert.match(css, /\.portrait-frame\.has-rarity-frame\{overflow:visible/);
  assert.match(css, /\.rune-holes\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(css, /\.rune-holes\{[^}]*grid-template-columns:1fr|\.rune-holes\{[^}]*repeat\(2/);
  assert.doesNotMatch(markup, /class="rune-number"|class="rune-level-label"|aria-label="武器满打磨属性"/);
  assert.equal((markup.match(/class="equipment-tier-button/g) ?? []).length, 18);
  assert.match(markup, /aria-label="武器切换LR" aria-pressed="false"/);
  assert.doesNotMatch(css, /\.portrait-frame img\{|--element-color|@media\([^{}]+\)\{\}/);
  assert.ok(markup.indexOf('aria-label="角色目录"') < markup.indexOf('aria-label="当前角色装备配置"'));
  assert.match(markup, /draggable="true"/);
  const equipmentB = await renderEquipmentEditors(team, 'B', displayedCatalog);
  assert.match(equipmentB, /class="rune-number">第 1 孔<\/span>/);
  assert.equal((equipmentB.match(/class="rune-level-label">等级/g) ?? []).length, 4);
  assert.match(equipmentB, /<option value="11" selected="">Lv\.11<\/option>/);
  assert.match(equipmentB, /<option value="10">Lv\.10<\/option>/);
  assert.match(markup, /Lv\.11 × 3、Lv\.10 × 3/);
  assert.match(markup, /aria-label="专武造价"/);
  assert.match(markup, /紫水晶等价 82\.5 个/);
  assert.match(markup, /aria-label="队员实际投入"/);
  assert.doesNotMatch(markup, /免费库抵扣/);
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
  assert.match(markup, /<input aria-label="武器装备等级"[^>]*type="number"[^>]*min="240"[^>]*max="450"[^>]*step="1"[^>]*value="450"/);
  assert.match(markup, /aria-label="武器强化等级"[^>]*max="450"[^>]*value="420"/);
  assert.doesNotMatch(markup, /aria-label="叶子造价"/);
  const relics = costFoldout(markup, 'UR和LR圣遗物装备明细', 'relic-crafting-costs');
  assert.match(relics.content, /衣服 LR/);
  const armor = cost.equipmentCosts.find(item => item.position === 1 && item.slot === 5);
  assert.ok(relics.content.includes(`<strong>${amount(armor.chargedResourceDiamonds.urLrFragments)} 钻</strong>`));
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
  assert.match(mixed, /aria-label="项链 SSR 魔装0"/);
  assert.match(mixed, /aria-label="头盔 SSR 魔装17"/);
  assert.match(mixed, /aria-label="项链魔装等级"[^>]*value="0"/);
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
  assert.match(markup, /<option value="153"[^>]*>小安<\/option>/);
  assert.match(markup, /<option value="27" selected="">科迪 · Jack &amp; Pot · 免费 UR Lv\.300<\/option>/);
  assert.match(markup, /同职业借用/);
  assert.match(markup, /不提供当前角色的专武技能/);
  assert.doesNotMatch(markup, /aria-label="武器类型"/);
  const owner = catalog.characters.find(item => item.id === 27);
  assert.ok(markup.includes(`class="equipment-art-image" src="${owner.exclusiveWeaponIcon}"`), 'borrowed equipment icons show the weapon owner');
  assertAutomaticControls(markup);
});

test('equipment composition displays the verified normal, holy, dark and combined plates below the original foreground and frame', async () => {
  const team = createTeam();
  team.members[0] = createMember(124);
  for (const gear of team.members[0].equipment.slice(1, 5)) Object.assign(gear, { rarity: 'SSR', seriesId: 12, level: 450 });
  team.members[0].equipment[2].legendSacredTreasureLevel = 1;
  team.members[0].equipment[3].matchlessSacredTreasureLevel = 17;
  Object.assign(team.members[0].equipment[4], { legendSacredTreasureLevel: 1, matchlessSacredTreasureLevel: 40 });
  const before = JSON.stringify(team);
  const markup = await renderDraft(cloneTeam(team));
  for (const kind of ['normal', 'holy', 'dark', 'both']) {
    assert.match(markup, new RegExp(`class="equipment-art-plate" data-plate="${kind}"`));
    assert.ok(markup.includes(catalog.iconArt.equipmentComposition.plate.palettes[kind].colors[0]));
  }
  assert.match(markup, /left:4\.6875%;top:4\.6875%;width:90\.625%;height:90\.625%/);
  assert.match(markup, /class="equipment-art-image"[^>]*style="left:7\.8125%;top:7\.8125%;width:84\.375%;height:84\.375%;object-fit:contain;filter:url\(#equipment-shadow-/);
  assert.match(markup, /<feDropShadow[^>]*flood-opacity="0\.5"/);
  assert.match(markup, /<feMergeNode in="SourceGraphic"/);
  const character = catalog.characters.find(item => item.id === 124);
  for (const slot of [2, 3, 4, 5]) assert.ok(markup.includes(`src="${catalog.iconArt.equipmentIcons[character.job].SSR[slot]}"`));
  assert.equal(JSON.stringify(team), before, 'visual treasure backgrounds never change the configured magic or holy levels');
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.equipment-art-plate\{position:absolute;z-index:0/);
  assert.match(css, /\.equipment-art-image\{position:absolute;z-index:1/);
  assert.match(css, /\.game-icon-frame\{[^}]*z-index:3/);
});

test('arcana shows actual owned LR5 bonuses, free R portraits and disabled unpublished groups without adding R to the team roster', async () => {
  const team = createTeam();
  const state = getArcanaState(team, catalog, policy, freeLibrary);
  const markup = await renderArcana(team);
  const lr5 = state.groups.find(group => group.unlocked && group.bonusTierLabel === 'LR5');
  assert.ok(lr5);
  const activeCard = arcanaCard(markup, lr5);
  assert.match(activeCard, /常驻已解锁 · LR5/);
  assert.match(activeCard, /LR5 档加成 · 已生效/);
  for (const bonus of lr5.bonuses) assert.ok(activeCard.includes(bonus.displayValue));
  assert.match(markup, /只读持有表/);
  assert.match(markup, /5830 中的战斗属性接入将在后续完成/);
  assert.match(markup, /卡片价格是当前补齐差额，不能直接相加/);
  assert.doesNotMatch(markup, /赠最高档|全阶赠送|购买 LR5|购买 SSR|NaN|undefined/);
  for (const support of catalog.arcana.supportCharacters) assert.ok(markup.includes(`src="${support.portrait}"`), `R support ${support.id} retains its verified portrait`);
  const unpublished = state.groups.find(group => group.published === false);
  const unpublishedCard = arcanaCard(markup, unpublished);
  assert.match(unpublishedCard, /class="arcana-unpublished-placeholder">未开放/);
  assert.match(unpublishedCard, /disabled=""[^>]*>暂不可购买/);
  assert.doesNotMatch(unpublishedCard, /取消购买|补齐 .* 钻/);
  const app = await renderDraft(cloneTeam(team));
  const roster = app.match(/<aside class="panel catalog-panel left-column" aria-label="选择角色">([\s\S]*?)<\/aside>/)[1];
  assert.equal((roster.match(/class="tile-name"/g) ?? []).length, catalog.characters.length);
  for (const support of catalog.arcana.supportCharacters) assert.ok(!roster.includes(`src="${support.portrait}"`), 'R holdings stay outside the selectable SR team catalog');
});

test('arcana purchases render marginal LR prices, one shared character fee and cancellation that preserves the configured team', async () => {
  const team = createTeam();
  team.members[0] = createMember(54);
  const first = 12;
  const second = 98;
  const before = getArcanaState(team, catalog, policy, freeLibrary);
  const beforeMarkup = await renderArcana(team);
  const firstGroup = before.groups.find(group => group.id === first);
  assert.match(arcanaCard(beforeMarkup, firstGroup), /LR 档加成 · 补齐后生效/);
  assert.ok(arcanaCard(beforeMarkup, firstGroup).includes(`补齐 ${amount(firstGroup.currentPurchaseDiamonds)} 钻`));
  let purchased = setArcanaPurchased(team, first, true, catalog, policy, freeLibrary);
  const next = getArcanaState(purchased, catalog, policy, freeLibrary);
  const nextGroup = next.groups.find(group => group.id === second);
  assert.ok(nextGroup.currentPurchaseDiamonds < before.groups.find(group => group.id === second).currentPurchaseDiamonds);
  const nextMarkup = await renderArcana(purchased);
  assert.ok(arcanaCard(nextMarkup, nextGroup).includes(`补齐 ${amount(nextGroup.currentPurchaseDiamonds)} 钻`));
  assert.match(arcanaCard(nextMarkup, next.groups.find(group => group.id === first)), /aria-label="取消购买大犬座的长啸"/);
  purchased = setArcanaPurchased(purchased, second, true, catalog, policy, freeLibrary);
  const cost = calculateTeam(purchased, catalog, policy, freeLibrary);
  assert.equal(cost.characterCosts.filter(item => item.characterId === 54).length, 1);
  const app = await renderDraft(cloneTeam(purchased));
  assert.ok(app.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  assert.match(app, /配队与秘仪按角色最高持有稀有度合并，同一角色只计一次本体费用/);
  assert.match(app, /小白 · LR · 8 本体（免费至 SR） · 秘仪持有/);
  assert.match(app, /aria-label="角色稀有度"[\s\S]*?<option value="LR" selected="">LR<\/option>/);
  assert.match(app, /aria-label="角色稀有度"[^>]*><option value="SR" disabled="">SR<\/option>/);
  assert.match(app, /已购秘仪至少需 LR/);
  assert.doesNotMatch(app, /已恢复可识别的草稿配置|NaN|undefined/);
  const canceled = setArcanaPurchased(purchased, first, false, catalog, policy, freeLibrary);
  assert.equal(canceled.members[0].rarity, 'LR');
  const canceledState = getArcanaState(canceled, catalog, policy, freeLibrary);
  const canceledMarkup = await renderArcana(canceled);
  assert.doesNotMatch(arcanaCard(canceledMarkup, canceledState.groups.find(group => group.id === first)), /取消购买/);
  assert.match(canceledMarkup, /取消购买不会降低已配置队员的稀有度/);
});

test('draft purchases recover associated SR to LR while malformed IDs trigger a recoverable original backup', async () => {
  const team = cloneTeam(createTeam());
  team.members[0] = createMember(54);
  team.purchasedArcanaIds = [12];
  const raw = JSON.stringify(team);
  const repaired = await renderDraft(team);
  assert.match(repaired, /已恢复可识别的草稿配置，原始草稿会另存备份/);
  assert.match(repaired, /aria-label="角色稀有度"[\s\S]*?<option value="LR" selected="">LR<\/option>/);
  assert.doesNotMatch(repaired, /已购买 LR 秘仪的队内角色必须至少为 LR|待修正|NaN/);
  assert.equal(JSON.stringify(team), raw, 'recovery retains the original SR draft for backup');
  const canonical = setArcanaPurchased(team, 12, true, catalog, policy, freeLibrary);
  const markup = await renderDraft(cloneTeam(canonical));
  assert.doesNotMatch(markup, /已恢复可识别的草稿配置/);
  canonical.members[0].rarity = 'LR5';
  const higher = await renderDraft(cloneTeam(canonical));
  assert.match(higher, /aria-label="角色稀有度"[\s\S]*?<option value="LR5" selected="">LR5<\/option>/);
  assert.doesNotMatch(higher, /已恢复可识别的草稿配置/);
  const malformed = { ...canonical, purchasedArcanaIds: [12, 12, 101, '98', 999999] };
  const sanitized = await renderDraft(malformed);
  assert.match(sanitized, /已恢复可识别的草稿配置，原始草稿会另存备份/);
  assert.doesNotMatch(sanitized, /秘仪编号未知、重复|原草稿无法完整恢复/);
  const expected = calculateTeam(canonical, catalog, policy, freeLibrary);
  assert.ok(sanitized.includes(`<strong>${amount(expected.totalDiamonds)}</strong>`));
});

test('the blessing header and resource budget consume dynamic base plus blessing allowances', async () => {
  const markup = await renderDraft(cloneTeam(createTeam()));
  const mechanisms = [...markup.matchAll(/<aside class="intro-note blessing-note" aria-label="恩泽机制"><strong>([^<]+)<\/strong>/g)];
  assert.deepEqual(mechanisms.map(match => match[1]), policy.blessings.map(blessing => blessing.name));
  assert.ok(mechanisms.every(match => match[1].startsWith('恩泽·')));
  assert.doesNotMatch(markup, /赐福/);
  assert.match(markup, /整队免费总额度 88,888 红水/);
  assert.doesNotMatch(markup, /额外免费 .* 红水|基础免费 0|基础 0 ＋|100,000 红水/);
  assert.match(markup, /class="resource-blessing-breakdown">整队免费总额度 88,888 红水/);
  const configuredPolicy = { ...policy, allowances: { ...policy.allowances, reinforcementMedicine: 62000 }, blessings: policy.blessings.map(blessing => blessing.resource === 'reinforcementMedicine' ? { ...blessing, name: '恩泽·自定义额度', amount: 41000 } : blessing) };
  const configured = await renderDraft(cloneTeam(createTeam()), catalog, configuredPolicy);
  assert.equal(getResourceAllowance(configuredPolicy, 'reinforcementMedicine'), 103000);
  assert.match(configured, /恩泽·自定义额度/);
  assert.match(configured, /额外免费 41,000 红水/);
  assert.match(configured, /基础免费 62,000 · 合计免费 103,000/);
  assert.match(configured, /class="resource-blessing-breakdown">基础 62,000 ＋ 恩泽 41,000 ＝ 103,000/);
});

test('SSR crafting blessing shows free ordinary fabrication while exclusive SSR weapons and old policies keep their own pricing', async () => {
  const team = createTeam();
  team.members[0] = createMember(54);
  team.members[0].equipment = team.members[0].equipment.map(gear => ({ ...selectEquipmentRarity(gear, 'SSR'), weaponKind: gear.slot === 1 ? 'exclusive' : 'normal', level: gear.slot === 1 ? 240 : 450, weaponOwnerCharacterId: gear.slot === 1 ? 54 : null }));
  const craftOnlyPolicy = { ...policy, blessings: policy.blessings.filter(item => !['resourceDiamondAllowance', 'freeExclusiveFragmentBaseline'].includes(item.effect)) };
  const cost = calculateTeam(team, catalog, craftOnlyPolicy, freeLibrary);
  assert.ok(cost.exclusiveWeaponCosts[0].diamonds > 0, 'the crafting blessing does not waive an exclusive weapon, independently of diamond allowances');
  const markup = await renderDraft(cloneTeam(team), catalog, craftOnlyPolicy);
  const blessing = policy.blessings.find(item => item.effect === 'freeEquipmentCrafting');
  assert.ok(markup.includes(blessing.name));
  assert.match(markup, /普通 SSR 装备制作免费/);
  assert.match(markup, /SSR 专武按原规则计价/);
  const credit = cost.resources.ssrFragments;
  assert.ok(credit.craftingBlessingCredit > 0);
  assert.match(markup, /aria-label="普通装备制作"/);
  assert.match(markup, /SSR 制作碎片/);
  assert.ok(cost.equipmentCosts.filter(item => item.weaponKind === 'normal').every(item => item.craftingDiamonds === 0));
  assert.doesNotMatch(markup, /制作抵扣|恩泽抵扣/);
  assert.ok(markup.includes(`<strong>${amount(cost.exclusiveWeaponCosts[0].diamonds)} 钻</strong>`));
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  const oldPolicy = { ...craftOnlyPolicy, blessings: craftOnlyPolicy.blessings.filter(item => item.effect !== 'freeEquipmentCrafting') };
  const oldCost = calculateTeam(team, catalog, oldPolicy, freeLibrary);
  const old = await renderDraft(cloneTeam(team), catalog, oldPolicy);
  assert.doesNotMatch(old, /普通 SSR 装备制作免费|crafting-blessing-summary|普通 SSR 制作恩泽抵扣/);
  assert.ok(old.includes(`<strong>${amount(oldCost.totalDiamonds)}</strong>`));
  assert.ok(oldCost.totalDiamonds > cost.totalDiamonds);
  assert.match(old, /整队免费总额度 88,888 红水/);
});

test('the treasure level labels show exact published per-slot bonuses and never clamp invalid values', async () => {
  const team = createTeam();
  team.members[0] = createMember(54);
  team.members[0].equipment = team.members[0].equipment.map(gear => ({ ...selectEquipmentRarity(gear, 'SSR'), weaponKind: gear.slot === 1 ? 'exclusive' : 'normal', level: gear.slot === 1 ? 240 : 450, weaponOwnerCharacterId: gear.slot === 1 ? 54 : null, legendSacredTreasureLevel: 40, matchlessSacredTreasureLevel: 40 }));
  const before = JSON.stringify(team);
  const markup = await renderDraft(cloneTeam(team));
  assert.equal((markup.match(/class="sacred-bonus"/g) ?? []).length, 12);
  for (const kind of ['legend', 'matchless']) for (const bonus of Object.values(equipmentBonuses.kinds[kind].slots)) {
    assert.ok(markup.includes(`${bonus.label} +${amount(bonus.values[40])}${bonus.unit === 'percent' ? '%' : ''}`));
  }
  assert.match(markup, /攻击力 · 比例加成；仅显示此装备的附加属性/);
  assert.match(markup, /加算百分点；仅显示此装备的附加属性/);
  assert.match(markup, /固定数值；仅显示此装备的附加属性/);
  assert.equal(JSON.stringify(team), before);
  for (const gear of team.members[0].equipment) Object.assign(gear, { legendSacredTreasureLevel: 0, matchlessSacredTreasureLevel: 0 });
  const zero = await renderDraft(cloneTeam(team));
  assert.equal((zero.match(/class="sacred-bonus"[^>]*>未附加/g) ?? []).length, 12);
  team.members[0].equipment[0].legendSacredTreasureLevel = 41;
  team.members[0].equipment[0].matchlessSacredTreasureLevel = '';
  team.members[0].equipment[5] = selectEquipmentRarity(team.members[0].equipment[5], 'NONE');
  const invalid = await renderDraft(cloneTeam(team));
  assert.equal((invalid.match(/class="sacred-bonus"[^>]*>—/g) ?? []).length, 2);
  assert.equal((invalid.match(/class="sacred-bonus"/g) ?? []).length, 10, 'an unequipped slot does not fabricate treasure effects');
  assert.doesNotMatch(invalid, /攻击力 \+60%|攻击力 \+105,000|NaN|undefined/);
});

test('three adaptive equipment shortcuts display their real compositions, preserve treasure and runes, and expose legal reinforcement values', async () => {
  const member = createMember(124);
  member.rarity = 'LR5';
  Object.assign(member.equipment[0], { rarity: 'UR', seriesId: 13, weaponKind: 'exclusive', level: 240, legendSacredTreasureLevel: 1, matchlessSacredTreasureLevel: 17 });
  member.equipment[0].runes[0] = { categoryId: 5, level: 11 };
  const previous = JSON.stringify(member);
  for (const preset of getEquipmentPresetOptions(member)) {
    const team = createTeam();
    team.members[0] = applyEquipmentPreset(member, preset.id, catalog, policy);
    const markup = await renderDraft(cloneTeam(team));
    const controls = markup.match(/<div class="equipment-presets"[^>]*>([\s\S]*?)<\/div>/)[1];
    for (const choice of getEquipmentPresetOptions(member)) assert.ok(controls.includes(`title="${choice.composition}">${choice.label}</button>`));
    assert.doesNotMatch(controls, /disabled=""/);
    for (const [index, slotName] of ['武器', '项链', '手套', '头盔', '衣服', '脚'].entries()) {
      const gear = team.members[0].equipment[index];
      assert.match(markup, new RegExp(`aria-label="${slotName}强化等级"[^>]*max="${gear.level}"[^>]*value="${gear.reinforcementLevel}"`));
      assert.match(markup, new RegExp(`aria-label="${slotName}稀有度"[\\s\\S]*?<option value="${gear.rarity}" selected=""`));
    }
    assert.match(markup, /aria-label="项链强化等级"[^>]*value="60"/);
    assert.match(markup, /aria-label="武器魔装等级"[^>]*value="17"/);
    assert.match(markup, /aria-label="项链魔装等级"[^>]*value="40"/);
    assert.match(markup, /魔装 17–40/);
    assert.match(await renderEquipmentEditors(team), /aria-label="武器第1孔符石等级"[^>]*value="11"/);
    assertAutomaticControls(markup);
  }
  assert.equal(JSON.stringify(member), previous, 'preset previews leave the original equipment intact');
  const lowerTeam = createTeam();
  lowerTeam.members[0] = createMember(124);
  const lower = await renderDraft(cloneTeam(lowerTeam));
  const lowerControls = lower.match(/<div class="equipment-presets"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.equal((lowerControls.match(/<button /g) ?? []).length, 3);
  assert.doesNotMatch(lowerControls, /disabled=""/);
  for (const label of ['2UR + 4SSR', '4UR + 2SSR', '6UR']) assert.ok(lowerControls.includes(`>${label}</button>`));
});

test('equipment DOM keeps slot order 1..6 while the desktop grid fills the left column before the right', async () => {
  const team = createTeam();
  team.members[0] = applyEquipmentPreset(createMember(124), 'adaptive4', catalog, policy);
  const markup = await renderDraft(cloneTeam(team));
  const titles = [...markup.matchAll(/<section class="equipment-card[^"]*" aria-label="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(titles, ['武器', '项链', '手套', '头盔', '衣服', '脚']);
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.equip-grid\{[^}]*grid-template-rows:repeat\(15,auto\)/);
  assert.match(css, /\.equipment-card\{[^}]*grid-template-rows:subgrid/);
  assert.match(css, /\.equipment-card\{[^}]*grid-row:span 5/);
  assert.match(css, /\.equipment-card:nth-child\(-n\+3\)\{[^}]*grid-column:1/);
  assert.match(css, /\.equipment-card:nth-child\(n\+4\)\{[^}]*grid-column:2/);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [position, row] of [[1, 1], [2, 6], [3, 11], [4, 1], [5, 6], [6, 11]]) {
    const declaration = rules.find(rule => rule[1].split(',').map(selector => selector.trim()).includes(`.equipment-card:nth-child(${position})`))?.[2];
    assert.ok(declaration, `card ${position} has a shared row declaration`);
    assert.match(declaration, new RegExp(`grid-row:${row}\\s*\\/\\s*span 5`));
  }
  assert.match(css, /@media\(max-width:430px\)\{[\s\S]*?\.equip-grid\{[^}]*grid-template-rows:none/);
  const controls = markup.match(/<div class="equipment-presets"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.match(controls, /title="4UR \+ 2SSR">4UR \+ 2SSR<\/button>/);
  assert.doesNotMatch(controls, />4LR \+ 2SSR<\/button>/);
});

test('LR5 to LR changes LR gear to UR and switches the adaptive shortcut without losing existing upgrades or ownership', async () => {
  const member = { ...createMember(124), rarity: 'LR5' };
  const high = applyEquipmentPreset(member, 'lr6', catalog, policy);
  high.equipment[0].matchlessSacredTreasureLevel = 17;
  high.equipment[0].legendSacredTreasureLevel = 7;
  high.equipment[0].runes[0] = { categoryId: 5, level: 11 };
  const previous = JSON.stringify(high);
  const lowered = changeMemberRarity(high, 'LR', catalog);
  const team = createTeam();
  team.members[0] = lowered;
  const markup = await renderDraft(cloneTeam(team));
  const controls = markup.match(/<div class="equipment-presets"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.match(controls, /title="4UR \+ 2SSR">4UR \+ 2SSR<\/button>/);
  assert.doesNotMatch(controls, />4LR \+ 2SSR<\/button>/);
  assert.match(markup, /aria-label="角色稀有度"[\s\S]*?<option value="LR" selected="">LR<\/option>/);
  for (const slotName of ['武器', '项链', '手套', '头盔', '衣服', '脚']) assert.match(markup, new RegExp(`aria-label="${slotName}稀有度"[\\s\\S]*?<option value="UR" selected=""`));
  assert.match(markup, /aria-label="武器魔装等级"[^>]*value="17"/);
  assert.match(markup, /aria-label="武器圣装等级"[^>]*value="7"/);
  assert.match(await renderEquipmentEditors(team), /aria-label="武器第1孔符石等级"[^>]*value="11"/);
  assert.doesNotMatch(markup, /请修正配置后查看准确费用|已恢复可识别的草稿配置/);
  for (let index = 0; index < 6; index++) {
    const before = high.equipment[index];
    const after = lowered.equipment[index];
    for (const key of ['level', 'reinforcementLevel', 'legendSacredTreasureLevel', 'matchlessSacredTreasureLevel', 'weaponOwnerCharacterId']) assert.equal(after[key], before[key]);
    assert.deepEqual(after.runes, before.runes);
  }
  assert.equal(JSON.stringify(high), previous);
  const higherTeam = createTeam(); higherTeam.members[0] = high;
  const higher = await renderDraft(cloneTeam(higherTeam));
  const higherControls = higher.match(/<div class="equipment-presets"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.match(higherControls, /title="4LR \+ 2SSR">4LR \+ 2SSR<\/button>/);
  assert.doesNotMatch(higherControls, />4UR \+ 2SSR<\/button>/);
});

test('LR to LR5 updates equipped UR gear, adaptive controls and displayed costs while SSR and empty slots remain unchanged', async () => {
  const member = applyEquipmentPreset({ ...createMember(124), rarity: 'LR' }, 'lr6', catalog, policy);
  Object.assign(member.equipment[0], { matchlessSacredTreasureLevel: 17, legendSacredTreasureLevel: 7, polishAttribute: 'muscle' });
  member.equipment[0].runes[0] = { categoryId: 5, level: 11 };
  const previous = JSON.stringify(member);
  const promoted = changeMemberRarity(member, 'LR5', catalog);
  const team = createTeam();
  team.members[0] = promoted;
  const cost = calculateTeam(team, catalog, policy, freeLibrary);
  const markup = await renderDraft(cloneTeam(team));
  const controls = markup.match(/<div class="equipment-presets"[^>]*>([\s\S]*?)<\/div>/)[1];
  for (const label of ['2LR + 4SSR', '4LR + 2SSR', '6LR']) assert.ok(controls.includes(`title="${label}">${label}</button>`));
  assert.doesNotMatch(controls, />4UR \+ 2SSR<\/button>|disabled=""/);
  assert.match(markup, /aria-label="角色稀有度"[\s\S]*?<option value="LR5" selected="">LR5<\/option>/);
  for (const slotName of ['武器', '项链', '手套', '头盔', '衣服', '脚']) assert.match(markup, new RegExp(`aria-label="${slotName}稀有度"[\\s\\S]*?<option value="LR" selected=""`));
  assert.match(markup, /aria-label="武器魔装等级"[^>]*value="17"/);
  assert.match(markup, /aria-label="武器圣装等级"[^>]*value="7"/);
  assert.match(await renderEquipmentEditors(team), /aria-label="武器第1孔符石等级"[^>]*value="11"/);
  costFoldout(markup, 'UR和LR圣遗物装备明细', 'relic-crafting-costs');
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`), 'the total uses the promoted character and LR equipment costs');
  assert.doesNotMatch(markup, /请修正配置后查看准确费用|已恢复可识别的草稿配置/);
  for (let index = 0; index < 6; index++) {
    const before = member.equipment[index];
    const after = promoted.equipment[index];
    assert.equal(after.rarity, 'LR');
    assert.equal(after.seriesId, 14);
    for (const key of ['level', 'reinforcementLevel', 'legendSacredTreasureLevel', 'matchlessSacredTreasureLevel', 'polishAttribute', 'weaponKind', 'weaponOwnerCharacterId']) assert.equal(after[key], before[key]);
    assert.deepEqual(after.runes, before.runes);
  }
  assert.equal(JSON.stringify(member), previous);
  const mixed = structuredClone(member);
  mixed.equipment[4] = selectEquipmentRarity(mixed.equipment[4], 'SSR');
  mixed.equipment[5] = selectEquipmentRarity(mixed.equipment[5], 'NONE');
  const mixedTeam = createTeam();
  mixedTeam.members[0] = changeMemberRarity(mixed, 'LR5', catalog);
  const mixedMarkup = await renderDraft(cloneTeam(mixedTeam));
  assert.match(mixedMarkup, /aria-label="衣服稀有度"[\s\S]*?<option value="SSR" selected=""/);
  assert.match(mixedMarkup, /aria-label="脚稀有度"[\s\S]*?<option value="NONE" selected=""/);
  assert.deepEqual(mixedTeam.members[0].equipment.slice(4), mixed.equipment.slice(4));
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /aria-label="角色稀有度"[^>]*onChange=\{event => chooseMemberRarity\(event\.target\.value\)\}/);
  assert.match(source, /function chooseMemberRarity\(rarity\)\s*\{\s*try \{ updateMember\(changeMemberRarity\(selectedMember, rarity, catalog\)\);/);
});

test('exclusive UR240 fabrication baseline and shared leaf budget display actual allocated investments', async () => {
  const team = createTeam();
  team.members = [54, 85, 124, 96, 100].map(characterId => applyEquipmentPreset({ ...createMember(characterId), rarity: 'LR5' }, 'lr6', catalog, policy));
  team.members[0].equipment[1] = selectEquipmentRarity(team.members[0].equipment[1], 'UR');
  const cost = calculateTeam(team, catalog, policy, freeLibrary);
  const markup = await renderDraft(cloneTeam(team));
  assert.match(markup, /叶子免费 60,000 钻/);
  assert.match(markup, /每把专武紫水晶制作免费至 UR Lv\.240/);
  assert.match(markup, /更高等级只收基础以上差额/);
  assert.match(markup, /aria-label="材料免费钻石预算"/);
  const leaf = cost.resources.lifeTreeDew;
  assert.ok(markup.includes(`${amount(leaf.diamondAllowance)} 钻免费`));
  assert.ok(markup.includes(`已使用 ${amount(leaf.diamondAllowanceCredit)} 钻`));
  assert.ok(markup.includes(`剩余 ${amount(leaf.remainingDiamondAllowance)} 钻`));
  assert.equal(cost.resources.exclusiveFragments.diamondAllowance, 0);
  const weapons = costFoldout(markup, '专武造价', 'weapon-costs');
  const weaponDiamonds = cost.exclusiveWeaponCosts.reduce((sum, item) => sum + item.diamonds, 0);
  assert.ok(weapons.summary.includes(`<strong>${amount(weaponDiamonds)} 钻</strong>`));
  for (const exclusive of cost.exclusiveWeaponCosts) {
    assert.ok(weapons.content.includes(`紫水晶等价 ${amount(exclusive.magicCrystals)} 个 · 实际投入 ${amount(exclusive.chargedFragmentDiamonds)} 钻`));
    assert.ok(weapons.content.includes(`叶子 ${amount(exclusive.lifeTreeDew)} 个 · 实际投入 ${amount(exclusive.chargedLifeTreeDewDiamonds)} 钻`));
  }
  const members = costFoldout(markup, '队员实际投入', 'member-investments');
  const memberDiamonds = cost.memberCosts.reduce((sum, item) => sum + item.totalDiamonds, 0);
  assert.ok(members.summary.includes(`<strong>${amount(memberDiamonds)} 钻</strong>`));
  assert.match(members.content, /共享免费额度按队伍顺序使用；各项投入已计入总额/);
  for (const member of cost.memberCosts) {
    assert.ok(members.content.includes(`<strong>${amount(member.totalDiamonds)} 钻</strong>`));
    assert.ok(members.content.includes(`本体 ${amount(member.characterDiamonds)} · 装备与养成 ${amount(member.equipmentDiamonds)} 钻`));
  }
  assert.match(markup, /50 碎片 = 2 个圣遗物材料/);
  for (const ordinary of cost.equipmentCosts.filter(item => item.weaponKind === 'normal' && item.rarity === 'SSR')) {
    assert.ok(markup.includes(`SSR 制作碎片 ${amount(ordinary.fragments)} 片`));
    assert.ok(markup.includes(`<strong>${amount(ordinary.craftingDiamonds)} 钻</strong>`));
  }
  for (const relic of cost.equipmentCosts.filter(item => item.sourceKind === 'team' && ['UR', 'LR'].includes(item.rarity) && item.fragmentResource === 'urLrFragments')) {
    assert.ok(markup.includes(`投入 ${amount(relic.fragments)} 片 · 圣遗物等价 ${amount(relic.equivalentArtifactMaterials)} 个`));
  }
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  assert.doesNotMatch(markup, /aria-label="叶子造价"|抵扣|紫水晶免费 80,000|额外免费 60,000 叶子|NaN|undefined/);
  const configuredPolicy = { ...policy, conversions: { ...policy.conversions, urLrFragmentsPerExchange: 25, relicMaterialsPerExchange: 1 }, blessings: policy.blessings.map(blessing => blessing.effect === 'resourceDiamondAllowance' ? { ...blessing, amount: 1234 } : blessing.effect === 'freeExclusiveFragmentBaseline' ? { ...blessing, level: 300 } : blessing) };
  const configuredCost = calculateTeam(team, catalog, configuredPolicy, freeLibrary);
  const configured = await renderDraft(cloneTeam(team), catalog, configuredPolicy);
  assert.match(configured, /叶子免费 1,234 钻/);
  assert.match(configured, /每把专武紫水晶制作免费至 UR Lv\.300/);
  assert.match(configured, /25 碎片 = 1 个圣遗物材料/);
  assert.ok(configured.includes(`<strong>${amount(configuredCost.totalDiamonds)}</strong>`));
  const oldPolicy = { ...policy, blessings: policy.blessings.filter(blessing => !['resourceDiamondAllowance', 'freeExclusiveFragmentBaseline'].includes(blessing.effect)) };
  const old = await renderDraft(cloneTeam(team), catalog, oldPolicy);
  assert.doesNotMatch(old, /aria-label="材料免费钻石预算"|每把专武紫水晶制作免费至|抵扣/);
});

test('polish selections retain all six preferences in draft restoration and preserve explicit even distribution', async () => {
  const team = createTeam();
  team.members[0] = createMember(54);
  const choices = ['main', 'none', 'muscle', 'energy', 'health', 'intelligence'];
  team.members[0].equipment = team.members[0].equipment.map((gear, index) => ({ ...selectEquipmentRarity(gear, 'SSR'), weaponKind: gear.slot === 1 ? 'exclusive' : 'normal', level: gear.slot === 1 ? 240 : 450, weaponOwnerCharacterId: gear.slot === 1 ? 54 : null, polishAttribute: choices[index] }));
  const markup = await renderDraft(cloneTeam(team));
  const equipmentB = await renderEquipmentEditors(team);
  for (const [index, slotName] of ['武器', '项链', '手套', '头盔', '衣服', '脚'].entries()) assert.match(equipmentB, new RegExp(`aria-label="${slotName}满打磨属性"[\\s\\S]*?<option value="${choices[index]}" selected=""`));
  assert.match(equipmentB, /满打磨：所选属性 60%，其余均分；不计费用/);
  assert.match(equipmentB, /四维均分，不定向打磨；不计费用/);
  assert.match(equipmentB, /<option value="energy">战技<\/option>/);
  assert.match(equipmentB, /<option value="health">耐力<\/option>/);
  assert.doesNotMatch(markup, /已恢复可识别的草稿配置|不打磨，不计费用/);
  const old = JSON.parse(JSON.stringify(team));
  delete old.members[0].equipment[0].polishAttribute;
  const restored = await renderDraft(old);
  assert.match(restored, /已恢复可识别的草稿配置，原始草稿会另存备份/);
  const restoredB = await renderEquipmentEditors(old);
  assert.match(restoredB, /aria-label="武器满打磨属性"[\s\S]*?<option value="main" selected=""/);
  assert.match(restoredB, /aria-label="项链满打磨属性"[\s\S]*?<option value="none" selected=""/);
  old.members[0].equipment[2].polishAttribute = 'unknown-polish';
  const repaired = await renderDraft(old);
  assert.match(repaired, /已恢复可识别的草稿配置，原始草稿会另存备份/);
  assert.match(await renderEquipmentEditors(old), /aria-label="手套满打磨属性"[\s\S]*?<option value="main" selected=""/);
});

test('real character stats render published totals and parts, while global stock errors suppress the entire panel', async () => {
  const team = createTeam();
  team.members[0] = applyEquipmentPreset({ ...createMember(54), rarity: 'LR5' }, 'lr6', catalog, policy);
  const state = getArcanaState(team, catalog, policy, freeLibrary);
  const result = calculateCharacterStats(team.members[0], catalog, policy, state);
  assert.equal(result.valid, true);
  const markup = await renderStats(result);
  assert.match(markup, /id="stats-page" role="tabpanel" aria-labelledby="stats-tab"/);
  assert.match(markup, /玩家等级 560 · 战斗技能增益不计入/);
  for (const label of ['主要属性', '四维属性', '进阶属性']) assert.ok(markup.includes(`aria-label="${label}"`));
  for (const row of result.rows) {
    assert.ok(markup.includes(`<span>${row.label}</span><strong>${row.displayValue}</strong>`));
    for (const part of row.parts ?? []) assert.ok(markup.includes(`<dt>${part.label}</dt><dd>${part.displayValue}</dd>`));
  }
  const broken = cloneTeam(team);
  for (const gear of broken.members[0].equipment.slice(0, 3)) gear.runes[0] = { categoryId: 3, level: 11 };
  broken.members[1] = createMember(8);
  Object.assign(broken.members[1].equipment[0], { rarity: 'SSR', seriesId: 12, weaponKind: 'exclusive', level: 180 });
  broken.members[1].equipment[0].runes[0] = { categoryId: 3, level: 11 };
  const validation = validateTeam(broken, catalog, policy, { freeLibrary });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(issue => issue.code === 'FIXED_RUNE_STOCK_EXCEEDED'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { getCharacterStatsResult, CharacterStatsPanel } = await server.ssrLoadModule('/src/App.jsx');
    const gated = getCharacterStatsResult(broken.members[0], catalog, policy, state, validation.errors);
    assert.equal(gated.valid, false);
    assert.deepEqual(gated.rows, []);
    const invalid = renderToStaticMarkup(React.createElement(CharacterStatsPanel, { result: gated, policy }));
    assert.match(invalid, /role="alert"/);
    assert.ok(invalid.includes(validation.errors[0].message));
    assert.doesNotMatch(invalid, /class="character-stat-row"/);
    assert.equal(getCharacterStatsResult(null, catalog, policy, state, []), null);
  } finally { await server.close(); }
  const invalidDraft = await renderDraft(broken);
  assert.equal((invalidDraft.match(/>速度 —<\/span>/g) ?? []).length, 2, 'team speed must not show plausible totals while the shared inventory is invalid');
  assert.match(await renderStats(null), /将角色拖入队伍位置，再查看角色属性/);
});

test('automatic same-column rune installation shows its exact shared stock and preserves later per-hole levels', async () => {
  const team = createTeam();
  team.members[0] = applyEquipmentPreset(createMember(54), 'ur2-ssr4', catalog, policy);
  const category = catalog.runeCategories.find(item => item.slots.includes(1) && !policy.runes.fixedStock.excludedCategoryIds.includes(item.id));
  const filled = fillColumnEmptyRunes(team, 0, 1, 0, { categoryId: category.id, level: 11 }, catalog, policy);
  const markup = await renderDraft(filled);
  const equipmentB = await renderEquipmentEditors(filled);
  assert.match(equipmentB, /四个孔均可填入同列对应空孔，首次等级一起同步；离开等级框后独立调整，已有符石保留/);
  for (const name of ['武器', '项链', '手套']) assert.match(equipmentB, new RegExp(`aria-label="${name}第1孔固定符石等级"[^>]*>[\\s\\S]*?<option value="11" selected=""`));
  assert.ok(markup.includes(`${category.name} · Lv.11</span><span>已用 3 / 3</span><strong>余 0</strong>`));
  const tuned = fillColumnEmptyRunes(filled, 0, 2, 0, { level: 10 }, catalog, policy);
  const independent = await renderDraft(tuned);
  const independentB = await renderEquipmentEditors(tuned);
  assert.match(independentB, /aria-label="项链第1孔固定符石等级"[^>]*>[\s\S]*?<option value="10" selected=""/);
  for (const name of ['武器', '手套']) assert.match(independentB, new RegExp(`aria-label="${name}第1孔固定符石等级"[^>]*>[\\s\\S]*?<option value="11" selected=""`));
  assert.ok(independent.includes(`${category.name} · Lv.11</span><span>已用 2 / 3</span><strong>余 1</strong>`));
  assert.ok(independent.includes(`${category.name} · Lv.10</span><span>已用 1 / 3</span><strong>余 2</strong>`));
  assert.equal(validateTeam(tuned, catalog, policy, { freeLibrary }).valid, true);
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /onRuneChange=\{\(runeIndex, nextRune, kind\) => updateRune\(slot, runeIndex, nextRune, kind\)\}/);
});

test('the real category and level controls synchronize a new speed batch through typing and commit it on Enter', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { EquipmentEditor } = await server.ssrLoadModule('/src/App.jsx');
    const team = createTeam();
    team.members[0] = applyEquipmentPreset(createMember(54), 'ur2-ssr4', catalog, policy);
    let state = { team, batch: null };
    const speed = catalog.runeCategories.find(category => category.name === '速度');
    assert.ok(speed);
    function control(label) {
      const member = state.team.members[0];
      const tree = EquipmentEditor({
        part: 'B', gear: member.equipment[0], index: 0, member, memberIndex: 0, catalog, policy, freeLibrary,
        errors: [], inventory: [], borrowableWeapons: [], ownWeaponClaimed: false,
        batchSourceRuneIndex: state.batch?.slot === 1 ? state.batch.runeIndex : null,
        onRuneChange(index, rune, kind) { state = updateColumnRune(state.team, 0, 1, index, rune, catalog, policy, { batch: state.batch, kind }); },
        onRuneCommit(index) { if (state.batch?.slot === 1 && state.batch.runeIndex === index) state.batch = null; },
      });
      function find(node) {
        if (!React.isValidElement(node)) return null;
        if (node.props['aria-label'] === label) return node;
        for (const child of React.Children.toArray(node.props.children)) {
          const found = find(child);
          if (found) return found;
        }
        return null;
      }
      const result = find(tree);
      assert.ok(result, `control exists: ${label}`);
      return result;
    }
    const levels = () => state.team.members[0].equipment.slice(0, 3).map(gear => gear.runes[0].level);
    control('武器第1孔符石类别').props.onChange({ target: { value: String(speed.id) } });
    assert.deepEqual(levels(), [1, 1, 1]);
    control('武器第1孔符石等级').props.onChange({ target: { value: '' } });
    assert.equal(control('武器第1孔符石等级').props.disabled, false, 'clearing the initial numeric value must not disable the editor');
    assert.equal(control('武器第1孔符石等级').props.value, '');
    for (const value of ['1', '10']) control('武器第1孔符石等级').props.onChange({ target: { value } });
    assert.deepEqual(levels(), [10, 10, 10]);
    assert.equal(validateTeam(state.team, catalog, policy, { freeLibrary }).valid, true);
    const markup = await renderEquipmentEditors(state.team);
    for (const name of ['武器', '项链', '手套']) assert.match(markup, new RegExp(`aria-label="${name}第1孔符石等级"[^>]*value="10"`));
    const levelControl = control('武器第1孔符石等级');
    levelControl.props.onKeyDown({ key: 'Enter', currentTarget: { blur() { levelControl.props.onBlur(); } } });
    assert.equal(state.batch, null);
    control('武器第1孔符石等级').props.onChange({ target: { value: '12' } });
    assert.deepEqual(levels(), [12, 10, 10], 'after committing, later adjustments are per hole');
    state = { team, batch: null };
    control('武器第1孔符石类别').props.onChange({ target: { value: String(speed.id) } });
    assert.ok(state.batch);
    control('武器第1孔符石类别').props.onChange({ target: { value: '' } });
    assert.equal(state.batch, null, 'selecting an empty hole cancels the batch rather than looking like unfinished number input');
    assert.deepEqual(levels(), [0, 1, 1]);
    assert.equal(control('武器第1孔符石等级').props.disabled, true);
  } finally { await server.close(); }
});

test('Lily second-hole magic uses the tier that can fill her column and reports partial stock without overwriting other characters', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom' });
  try {
    const { EquipmentEditor } = await server.ssrLoadModule('/src/App.jsx');
    const team = createTeam();
    team.members[0] = applyEquipmentPreset(createMember(141), 'ur2-ssr4', catalog, policy);
    team.members[1] = applyEquipmentPreset(createMember(8), 'ur2-ssr4', catalog, policy);
    for (const gear of team.members[1].equipment.slice(0, 2)) gear.runes[0] = { categoryId: 3, level: 11 };
    let state = { team, batch: null };
    function editor() {
      const member = state.team.members[0];
      return EquipmentEditor({
        part: 'B', gear: member.equipment[0], index: 0, member, memberIndex: 0, catalog, policy, freeLibrary,
        errors: [], inventory: calculateTeam(state.team, catalog, policy, freeLibrary).fixedRuneInventory,
        borrowableWeapons: [], ownWeaponClaimed: false, runeFillReport: state.fillReport,
        batchSourceRuneIndex: state.batch?.slot === 1 ? state.batch.runeIndex : null,
        onRuneChange(index, rune, kind) { state = updateColumnRune(state.team, 0, 1, index, rune, catalog, policy, { batch: state.batch, kind }); },
      });
    }
    function control(label) {
      const find = node => React.isValidElement(node)
        ? node.props['aria-label'] === label ? node : React.Children.toArray(node.props.children).map(find).find(Boolean)
        : null;
      const found = find(editor());
      assert.ok(found, label);
      return found;
    }
    control('武器第1孔符石类别').props.onChange({ target: { value: '9' } });
    control('武器第2孔符石类别').props.onChange({ target: { value: '3' } });
    assert.deepEqual(state.team.members[0].equipment.slice(0, 3).map(gear => gear.runes[1]), Array.from({ length: 3 }, () => ({ categoryId: 3, level: 10 })));
    assert.deepEqual(state.team.members[1].equipment.slice(0, 2).map(gear => gear.runes[0].level), [11, 11]);
    assert.match(renderToStaticMarkup(editor()), /第 2 孔 魔力：项链／手套已同步/);
    const speed = calculateCharacterStats(state.team.members[0], catalog, policy, getArcanaState(state.team, catalog, policy, freeLibrary)).rows.find(row => row.key === 'Speed').displayValue;
    assert.ok((await renderDraft(state.team)).includes(`>速度 ${speed}</span>`));
    state = { team: cloneTeam(team), batch: null };
    state.team.members[2] = applyEquipmentPreset(createMember(27), 'ur2-ssr4', catalog, policy);
    for (const gear of state.team.members[2].equipment.slice(0, 2)) gear.runes[0] = { categoryId: 3, level: 10 };
    control('武器第2孔符石类别').props.onChange({ target: { value: '3' } });
    assert.deepEqual(state.team.members[0].equipment.slice(0, 3).map(gear => gear.runes[1].level), [11, 0, 0]);
    assert.match(renderToStaticMarkup(editor()), /项链对应等级库存不足；手套对应等级库存不足/);
    assert.equal(validateTeam(state.team, catalog, policy, { freeLibrary }).valid, true);
  } finally { await server.close(); }
});

test('team actual investments and off-team arcana characters remain separate and included once in the budget', async () => {
  const group = getArcanaState(createTeam(), catalog, policy, freeLibrary).groups.find(item => item.published && !item.unlocked && item.missingCharacters.length > 1);
  assert.ok(group);
  const original = createTeam();
  original.members[0] = createMember(group.missingCharacters[0].characterId);
  const team = setArcanaPurchased(original, group.id, true, catalog, policy, freeLibrary);
  const cost = calculateTeam(team, catalog, policy, freeLibrary);
  assert.ok(cost.offTeamCharacterCosts.length > 0);
  const markup = await renderDraft(team);
  assert.match(markup, /aria-label="队员实际投入"/);
  assert.match(markup, /aria-label="秘仪队外投入"/);
  assert.match(markup, /配队与秘仪按角色最高持有稀有度合并，同一角色只计一次本体费用/);
  assert.match(markup, /共享免费额度按队伍顺序使用；各项投入已计入总额/);
  const members = costFoldout(markup, '队员实际投入', 'member-investments');
  assert.ok(members.summary.includes(`<strong>${amount(cost.memberCosts.reduce((sum, item) => sum + item.totalDiamonds, 0))} 钻</strong>`));
  const offTeam = costFoldout(markup, '秘仪队外投入', 'off-team-investments');
  const chargedOffTeam = cost.offTeamCharacterCosts.filter(row => row.diamonds > 0);
  assert.ok(offTeam.summary.includes(`<strong>${amount(chargedOffTeam.reduce((sum, item) => sum + item.diamonds, 0))} 钻</strong>`));
  for (const item of chargedOffTeam) assert.ok(offTeam.content.includes(`<span>${item.characterName}</span><strong>${amount(item.diamonds)} 钻</strong>`));
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  assert.doesNotMatch(markup, /抵扣|NaN|undefined/);
});

test('member clicks and drag placement select the new member without leaving any current tab', async () => {
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const selectBody = source.match(/  function selectMember\(index\) \{([\s\S]*?)\n  \}/)?.[1];
  const placementBody = source.match(/  function applyPlacement\(result\) \{([\s\S]*?)\n  \}/)?.[1];
  assert.ok(selectBody && placementBody, 'exercise the production event handlers without introducing a DOM test runtime');
  for (const page of ['team', 'equipment-b', 'stats', 'arcana']) {
    const team = createTeam();
    team.members[0] = createMember(54);
    team.members[1] = createMember(124);
    const state = { activePage: page, selectedIndex: 0, team };
    const pageChanges = [];
    const setters = {
      setSelectedIndex(index) { state.selectedIndex = index; },
      setActivePage(next) { pageChanges.push(next); state.activePage = next; },
      changeTeam(next) { state.team = next; },
    };
    const selectMember = new Function('setSelectedIndex', 'setActivePage', `return function(index) {${selectBody}\n};`)(setters.setSelectedIndex, setters.setActivePage);
    selectMember(1);
    assert.equal(state.activePage, page);
    assert.equal(state.team.members[state.selectedIndex].characterId, 124);
    const applyPlacement = new Function('changeTeam', 'setSelectedIndex', 'setActivePage', `return function(result) {${placementBody}\n};`)(setters.changeTeam, setters.setSelectedIndex, setters.setActivePage);
    const placement = placeRosterCharacter(team, catalog.characters.find(character => character.id === 85), 2, { catalog, freeLibrary });
    applyPlacement(placement);
    assert.equal(state.team, placement.team);
    assert.equal(state.team.members[state.selectedIndex].characterId, 85);
    assert.equal(state.activePage, page);
    assert.deepEqual(pageChanges, [], 'only an explicit tab click should change pages');
  }
});

test('the curse shows dynamic original and current copy prices without applying its displayed saving a second time', async () => {
  const team = createTeam();
  team.members[0] = { ...createMember(54), rarity: 'LR5' };
  const markup = await renderDraft(team);
  const card = markup.match(/<aside class="intro-note curse-note" aria-label="诅咒机制">([\s\S]*?)<\/aside>/)?.[1];
  assert.ok(card);
  assert.match(card, /class="curse-character-price">每个角色本体 17,000 → 12,000 钻<\/p>/);
  assert.match(card, /class="curse-character-saving">受诅咒影响，每个本体减少 5,000 钻<\/span>/);
  assert.ok(markup.includes(`<strong>${amount(calculateTeam(team, catalog, policy, freeLibrary).totalDiamonds)}</strong>`));
  const configuredPolicy = { ...policy, baseline: { ...policy.baseline, curse: { ...policy.baseline.curse, characterCopyOriginalPrice: 22500 } }, unitPrices: { ...policy.unitPrices, characterCopy: 15000 } };
  const configured = await renderDraft(team, catalog, configuredPolicy);
  const configuredCard = configured.match(/aria-label="诅咒机制">([\s\S]*?)<\/aside>/)[1];
  assert.match(configuredCard, /每个角色本体 22,500 → 15,000 钻/);
  assert.match(configuredCard, /每个本体减少 7,500 钻/);
  assert.ok(configured.includes(`<strong>${amount(calculateTeam(team, catalog, configuredPolicy, freeLibrary).totalDiamonds)}</strong>`));
  const legacyPolicy = structuredClone(configuredPolicy);
  delete legacyPolicy.baseline.curse.characterCopyOriginalPrice;
  const legacy = await renderDraft(team, catalog, legacyPolicy);
  const legacyCard = legacy.match(/aria-label="诅咒机制">([\s\S]*?)<\/aside>/)[1];
  assert.match(legacyCard, /每个角色本体 15,000 钻/);
  assert.doesNotMatch(legacyCard, /curse-character-saving|减少|→|22,500|17,000/);
  assert.ok(legacy.includes(`<strong>${amount(calculateTeam(team, catalog, legacyPolicy, freeLibrary).totalDiamonds)}</strong>`));
});

test('collapsed UR and LR relic costs merge their net subtotal while retaining equipment details and excluding weapons, SSR and leaves', async () => {
  const team = createTeam();
  team.members[0] = applyEquipmentPreset({ ...createMember(54), rarity: 'LR5' }, 'lr6', catalog, policy);
  team.members[1] = applyEquipmentPreset({ ...createMember(85), rarity: 'LR5' }, 'lr6', catalog, policy);
  team.members[2] = applyEquipmentPreset(createMember(124), 'ur2-ssr4', catalog, policy);
  const snapshot = JSON.stringify(team);
  const cost = calculateTeam(team, catalog, policy, freeLibrary);
  const relicArmor = cost.equipmentCosts.filter(item => item.sourceKind === 'team' && ['UR', 'LR'].includes(item.rarity) && item.fragmentResource === 'urLrFragments');
  assert.equal(relicArmor.filter(item => item.rarity === 'LR').length, 10);
  assert.ok(relicArmor.some(item => item.rarity === 'UR'), 'the merged subtotal also includes ordinary UR armor');
  assert.ok(cost.equipmentCosts.some(item => item.rarity === 'LR' && item.fragmentResource === 'exclusiveFragments'), 'the fixture includes LR exclusive weapons that must be excluded');
  assert.ok(cost.equipmentCosts.some(item => item.rarity === 'LR' && item.chargedResourceDiamonds.lifeTreeDew > 0), 'the fixture includes paid leaves that must be excluded');
  const markup = await renderDraft(team);
  const relics = costFoldout(markup, 'UR和LR圣遗物装备明细', 'relic-crafting-costs');
  assert.equal((markup.match(/aria-label="UR和LR圣遗物装备明细"/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /aria-label="LR装备碎片成本"|class="[^\"]*lr-crafting-costs|aria-label="叶子造价"/);
  const fragmentTotal = relicArmor.reduce((sum, item) => sum + item.fragments, 0);
  const materialTotal = fragmentTotal * policy.conversions.relicMaterialsPerExchange / policy.conversions.urLrFragmentsPerExchange;
  const diamondTotal = relicArmor.reduce((sum, item) => sum + item.chargedResourceDiamonds.urLrFragments, 0);
  assert.match(relics.summary, /UR \/ LR 圣遗物装备碎片/);
  assert.ok(relics.summary.includes(`<strong>${amount(diamondTotal)} 钻</strong>`));
  assert.ok(relics.summary.includes(`累计投入 ${amount(fragmentTotal)} 片 · 圣遗物等价 ${amount(materialTotal)} 个`));
  assert.doesNotMatch(relics.summary, /leaf-cost-row|data-position|data-slot|叶子|专武|紫水晶|\bSSR\b/);
  for (const member of cost.memberCosts) assert.ok(!relics.summary.includes(member.characterName), 'individual equipment stays hidden inside the disclosure');
  assert.equal((relics.content.match(/class="leaf-cost-row"/g) ?? []).length, relicArmor.length);
  for (const item of relicArmor) {
    assert.ok(relics.content.includes(`投入 ${amount(item.fragments)} 片 · 圣遗物等价 ${amount(item.equivalentArtifactMaterials)} 个`));
    assert.ok(relics.content.includes(`<strong>${amount(item.chargedResourceDiamonds.urLrFragments)} 钻</strong>`));
  }
  assert.doesNotMatch(relics.content, /叶子|专武|紫水晶| SSR<small>|武器 LR/);
  const ordinary = costFoldout(markup, '普通装备制作', 'ordinary-crafting-costs');
  const ssrCosts = cost.equipmentCosts.filter(item => item.weaponKind === 'normal' && item.rarity === 'SSR');
  assert.match(ordinary.summary, /普通 SSR 装备制作/);
  assert.ok(ordinary.summary.includes(`<strong>${amount(ssrCosts.reduce((sum, item) => sum + item.craftingDiamonds, 0))} 钻</strong>`));
  assert.equal((ordinary.content.match(/class="leaf-cost-row"/g) ?? []).length, ssrCosts.length);
  for (const item of ssrCosts) assert.ok(ordinary.content.includes(`SSR 制作碎片 ${amount(item.fragments)} 片`));
  assert.doesNotMatch(ordinary.content, / UR<small>| LR<small>/);
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`), 'disclosure subtotals must not add any cost to the team quote again');
  assert.equal(JSON.stringify(team), snapshot);

  const urFirst = cloneTeam(team);
  [urFirst.members[0], urFirst.members[2]] = [urFirst.members[2], urFirst.members[0]];
  const orderedCost = calculateTeam(urFirst, catalog, policy, freeLibrary);
  const urFragments = orderedCost.equipmentCosts.filter(item => item.rarity === 'UR' && item.fragmentResource === 'urLrFragments').reduce((sum, item) => sum + item.fragments, 0);
  const firstLR = orderedCost.equipmentCosts.find(item => item.rarity === 'LR' && item.fragmentResource === 'urLrFragments');
  const configuredPolicy = { ...policy, allowances: { ...policy.allowances, urLrFragments: urFragments + firstLR.fragments / 2 } };
  const allocatedCost = calculateTeam(urFirst, catalog, configuredPolicy, freeLibrary);
  const allocatedArmor = allocatedCost.equipmentCosts.filter(item => item.sourceKind === 'team' && ['UR', 'LR'].includes(item.rarity) && item.fragmentResource === 'urLrFragments');
  assert.ok(allocatedCost.equipmentCosts.filter(item => item.rarity === 'UR' && item.fragmentResource === 'urLrFragments').every(item => item.chargedResourceDiamonds.urLrFragments === 0), 'earlier UR armor consumes the shared fragment allowance first');
  assert.ok(allocatedArmor.some(item => item.chargedResourceDiamonds.urLrFragments > 0 && item.chargedResourceDiamonds.urLrFragments < item.fragments * configuredPolicy.unitPrices.urLrFragments));
  const allocated = await renderDraft(urFirst, catalog, configuredPolicy);
  const allocatedSection = costFoldout(allocated, 'UR和LR圣遗物装备明细', 'relic-crafting-costs');
  const allocatedDiamonds = allocatedArmor.reduce((sum, item) => sum + item.chargedResourceDiamonds.urLrFragments, 0);
  assert.ok(allocatedSection.summary.includes(`累计投入 ${amount(fragmentTotal)} 片 · 圣遗物等价 ${amount(materialTotal)} 个`));
  assert.ok(allocatedSection.summary.includes(`<strong>${amount(allocatedDiamonds)} 钻</strong>`), 'the subtotal uses domain allocations rather than deducting the fragment allowance twice');
  assert.ok(allocated.includes(`<strong>${amount(allocatedCost.totalDiamonds)}</strong>`));

  const lower = createTeam();
  lower.members[0] = applyEquipmentPreset(createMember(54), 'lr6', catalog, policy);
  const lowerMarkup = await renderDraft(lower);
  costFoldout(lowerMarkup, 'UR和LR圣遗物装备明细', 'relic-crafting-costs');
  assert.doesNotMatch(lowerMarkup, /aria-label="LR装备碎片成本"|class="[^\"]*lr-crafting-costs/);
  const exclusiveOnly = createTeam();
  exclusiveOnly.members[0] = applyEquipmentPreset({ ...createMember(54), rarity: 'LR5' }, 'lr6', catalog, policy);
  exclusiveOnly.members[0].equipment = [exclusiveOnly.members[0].equipment[0], ...createMember(54).equipment.slice(1)];
  const exclusiveMarkup = await renderDraft(exclusiveOnly);
  assert.match(exclusiveMarkup, /aria-label="专武造价"/);
  assert.doesNotMatch(exclusiveMarkup, /aria-label="LR装备碎片成本"|aria-label="UR和LR圣遗物装备明细"|class="[^\"]*lr-crafting-costs/);
});
