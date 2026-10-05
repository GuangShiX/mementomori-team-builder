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
import { fillColumnEmptyRunes } from '../src/rune-interactions.mjs';

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

const arcanaCard = (markup, group) => markup.split(`aria-label="${group.name}"`)[1]?.split('</section>')[0];

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
  assert.match(markup, /aria-label="武器装备等级"[\s\S]*?<option value="450" selected="">Lv\. 450<\/option>/);
  assert.match(markup, /aria-label="武器强化等级"[^>]*max="450"[^>]*value="420"/);
  assert.match(markup, /aria-label="叶子造价"/);
  assert.match(markup, /衣服 LR/);
  const armor = cost.equipmentCosts.find(item => item.position === 1 && item.slot === 5);
  assert.ok(markup.includes(`<strong>${amount(armor.chargedResources.lifeTreeDew * policy.unitPrices.lifeTreeDew)} 钻</strong>`));
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
  assert.match(markup, /<option value="27" selected="">科迪 · 免费 UR Lv\.300<\/option>/);
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
  assert.match(markup, /aria-label="赐福机制"[\s\S]*?赐福·绯红恩泽/);
  assert.match(markup, /整队免费总额度 88,888 红水/);
  assert.doesNotMatch(markup, /额外免费 .* 红水|基础免费 0|基础 0 ＋|100,000 红水/);
  assert.match(markup, /class="resource-blessing-breakdown">整队免费总额度 88,888 红水/);
  const configuredPolicy = { ...policy, allowances: { ...policy.allowances, reinforcementMedicine: 62000 }, blessings: policy.blessings.map(blessing => blessing.resource === 'reinforcementMedicine' ? { ...blessing, name: '赐福·自定义额度', amount: 41000 } : blessing) };
  const configured = await renderDraft(cloneTeam(createTeam()), catalog, configuredPolicy);
  assert.equal(getResourceAllowance(configuredPolicy, 'reinforcementMedicine'), 103000);
  assert.match(configured, /赐福·自定义额度/);
  assert.match(configured, /额外免费 41,000 红水/);
  assert.match(configured, /基础免费 62,000 · 合计免费 103,000/);
  assert.match(configured, /class="resource-blessing-breakdown">基础 62,000 ＋ 赐福 41,000 ＝ 103,000/);
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
  assert.doesNotMatch(markup, /制作抵扣|赐福抵扣/);
  assert.ok(markup.includes(`<strong>${amount(cost.exclusiveWeaponCosts[0].diamonds)} 钻</strong>`));
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  const oldPolicy = { ...craftOnlyPolicy, blessings: craftOnlyPolicy.blessings.filter(item => item.effect !== 'freeEquipmentCrafting') };
  const oldCost = calculateTeam(team, catalog, oldPolicy, freeLibrary);
  const old = await renderDraft(cloneTeam(team), catalog, oldPolicy);
  assert.doesNotMatch(old, /普通 SSR 装备制作免费|crafting-blessing-summary|普通 SSR 制作赐福抵扣/);
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

test('four equipment shortcuts display their real compositions, preserve treasure and runes, and expose legal reinforcement values', async () => {
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
    assert.match(markup, /aria-label="武器第1孔符石等级"[^>]*value="11"/);
    assertAutomaticControls(markup);
  }
  assert.equal(JSON.stringify(member), previous, 'preset previews leave the original equipment intact');
  const lowerTeam = createTeam();
  lowerTeam.members[0] = createMember(124);
  const lower = await renderDraft(cloneTeam(lowerTeam));
  const lowerControls = lower.match(/<div class="equipment-presets"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.equal((lowerControls.match(/disabled=""/g) ?? []).length, 2);
  assert.match(lowerControls, /disabled="" title="2LR \+ 4SSR · 需要 LR5 角色">2LR/);
  assert.match(lowerControls, /disabled="" title="6LR · 需要 LR5 角色">6LR/);
});

test('equipment DOM keeps slot order 1..6 while the desktop grid fills the left column before the right', async () => {
  const team = createTeam();
  team.members[0] = applyEquipmentPreset(createMember(124), 'adaptive4', catalog, policy);
  const markup = await renderDraft(cloneTeam(team));
  const titles = [...markup.matchAll(/<section class="equipment-card[^"]*" aria-label="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(titles, ['武器', '项链', '手套', '头盔', '衣服', '脚']);
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.equip-grid\{grid-template-rows:repeat\(3,auto\);grid-auto-flow:column\}/);
  assert.match(css, /@media\(max-width:430px\)\{\.equip-grid\{grid-template-rows:none;grid-auto-flow:row\}\}/);
  const controls = markup.match(/<div class="equipment-presets"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.match(controls, /title="4UR \+ 2SSR">4UR<\/button>/);
  assert.doesNotMatch(controls, />4LR<\/button>/);
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
  assert.match(controls, /title="4UR \+ 2SSR">4UR<\/button>/);
  assert.doesNotMatch(controls, />4LR<\/button>/);
  assert.match(markup, /aria-label="角色稀有度"[\s\S]*?<option value="LR" selected="">LR<\/option>/);
  for (const slotName of ['武器', '项链', '手套', '头盔', '衣服', '脚']) assert.match(markup, new RegExp(`aria-label="${slotName}稀有度"[\\s\\S]*?<option value="UR" selected=""`));
  assert.match(markup, /aria-label="武器魔装等级"[^>]*value="17"/);
  assert.match(markup, /aria-label="武器圣装等级"[^>]*value="7"/);
  assert.match(markup, /aria-label="武器第1孔符石等级"[^>]*value="11"/);
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
  assert.match(higherControls, /title="4LR \+ 2SSR">4LR<\/button>/);
  assert.doesNotMatch(higherControls, />4UR<\/button>/);
});

test('exclusive UR240 fabrication baseline and shared leaf budget display actual allocated investments', async () => {
  const team = createTeam();
  team.members = [54, 85, 124, 96, 100].map(characterId => applyEquipmentPreset({ ...createMember(characterId), rarity: 'LR5' }, 'lr6', catalog, policy));
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
  for (const exclusive of cost.exclusiveWeaponCosts) {
    assert.ok(markup.includes(`紫水晶等价 ${amount(exclusive.magicCrystals)} 个 · 实际投入 ${amount(exclusive.chargedFragmentDiamonds)} 钻`));
    assert.ok(markup.includes(`叶子 ${amount(exclusive.lifeTreeDew)} 个 · 实际投入 ${amount(exclusive.chargedLifeTreeDewDiamonds)} 钻`));
  }
  assert.match(markup, /共享免费额度按队伍顺序使用；以下投入已计入总额/);
  for (const member of cost.memberCosts) {
    assert.ok(markup.includes(`<strong>${amount(member.totalDiamonds)} 钻</strong>`));
    assert.ok(markup.includes(`本体 ${amount(member.characterDiamonds)} · 装备与养成 ${amount(member.equipmentDiamonds)} 钻`));
  }
  assert.match(markup, /50 碎片 = 2 个圣遗物材料/);
  for (const ordinary of cost.equipmentCosts.filter(item => item.weaponKind === 'normal')) {
    assert.ok(markup.includes(`圣遗物等价 ${amount(ordinary.equivalentArtifactMaterials)} 个 · ${amount(ordinary.fragments)} 碎片`));
    assert.ok(markup.includes(`<strong>${amount(ordinary.craftingDiamonds)} 钻</strong>`));
  }
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  assert.doesNotMatch(markup, /抵扣|紫水晶免费 80,000|额外免费 60,000 叶子|NaN|undefined/);
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
  for (const [index, slotName] of ['武器', '项链', '手套', '头盔', '衣服', '脚'].entries()) assert.match(markup, new RegExp(`aria-label="${slotName}满打磨属性"[\\s\\S]*?<option value="${choices[index]}" selected=""`));
  assert.match(markup, /满打磨：所选属性 60%，其余均分；不计费用/);
  assert.match(markup, /四维均分，不定向打磨；不计费用/);
  assert.match(markup, /<option value="energy">战技<\/option>/);
  assert.match(markup, /<option value="health">耐力<\/option>/);
  assert.doesNotMatch(markup, /已恢复可识别的草稿配置|不打磨，不计费用/);
  const old = JSON.parse(JSON.stringify(team));
  delete old.members[0].equipment[0].polishAttribute;
  const restored = await renderDraft(old);
  assert.match(restored, /已恢复可识别的草稿配置，原始草稿会另存备份/);
  assert.match(restored, /aria-label="武器满打磨属性"[\s\S]*?<option value="main" selected=""/);
  assert.match(restored, /aria-label="项链满打磨属性"[\s\S]*?<option value="none" selected=""/);
  old.members[0].equipment[2].polishAttribute = 'unknown-polish';
  const repaired = await renderDraft(old);
  assert.match(repaired, /已恢复可识别的草稿配置，原始草稿会另存备份/);
  assert.match(repaired, /aria-label="手套满打磨属性"[\s\S]*?<option value="main" selected=""/);
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
  assert.match(await renderStats(null), /将角色拖入队伍位置，再查看角色属性/);
});

test('automatic same-column rune installation shows its exact shared stock and preserves later per-hole levels', async () => {
  const team = createTeam();
  team.members[0] = applyEquipmentPreset(createMember(54), 'ur2-ssr4', catalog, policy);
  const category = catalog.runeCategories.find(item => item.slots.includes(1) && !policy.runes.fixedStock.excludedCategoryIds.includes(item.id));
  const filled = fillColumnEmptyRunes(team, 0, 1, 0, { categoryId: category.id, level: 11 }, catalog, policy);
  const markup = await renderDraft(filled);
  assert.match(markup, /首次新增会填入同列对应空孔，已有符石保留；库存允许时同步，后续独立调整/);
  for (const name of ['武器', '项链', '手套']) assert.match(markup, new RegExp(`aria-label="${name}第1孔固定符石等级"[^>]*>[\\s\\S]*?<option value="11" selected=""`));
  assert.ok(markup.includes(`${category.name} · Lv.11</span><span>已用 3 / 3</span><strong>余 0</strong>`));
  const tuned = fillColumnEmptyRunes(filled, 0, 2, 0, { level: 10 }, catalog, policy);
  const independent = await renderDraft(tuned);
  assert.match(independent, /aria-label="项链第1孔固定符石等级"[^>]*>[\s\S]*?<option value="10" selected=""/);
  for (const name of ['武器', '手套']) assert.match(independent, new RegExp(`aria-label="${name}第1孔固定符石等级"[^>]*>[\\s\\S]*?<option value="11" selected=""`));
  assert.ok(independent.includes(`${category.name} · Lv.11</span><span>已用 2 / 3</span><strong>余 1</strong>`));
  assert.ok(independent.includes(`${category.name} · Lv.10</span><span>已用 1 / 3</span><strong>余 2</strong>`));
  assert.equal(validateTeam(tuned, catalog, policy, { freeLibrary }).valid, true);
  const source = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /onRuneChange=\{\(runeIndex, nextRune\) => updateRune\(slot, runeIndex, nextRune\)\}/);
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
  assert.match(markup, /共享免费额度按队伍顺序使用；以下投入已计入总额/);
  const offTeamSection = markup.split('aria-label="秘仪队外投入"')[1].split('</section>')[0];
  for (const item of cost.offTeamCharacterCosts.filter(row => row.diamonds > 0)) assert.ok(offTeamSection.includes(`<span>${item.characterName}</span><strong>${amount(item.diamonds)} 钻</strong>`));
  assert.ok(markup.includes(`<strong>${amount(cost.totalDiamonds)}</strong>`));
  assert.doesNotMatch(markup, /抵扣|NaN|undefined/);
});
