import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  createTeam, createMember, selectEquipmentRarity, calculateTeam, validateTeam,
  createExport, parseImport, cloneTeam, migrateLegacyWeaponConfiguration, getBorrowableWeapons, isWeaponOwnerClaimed, EQUIPMENT_SLOTS, RESOURCE_KEYS,
  getArcanaState, setArcanaPurchased, getArcanaRequiredRarity, getResourceAllowance,
  POLISH_ATTRIBUTES as VALID_POLISH_ATTRIBUTES,
} from './domain.mjs';
import { placeRosterCharacter, swapTeamPositions } from './team-interactions.mjs';
import { getEquipmentPresetOptions, applyEquipmentPreset, changeMemberRarity } from './equipment-presets.mjs';
import { calculateCharacterStats } from './character-stats.mjs';
import { updateColumnRune, chooseInitialColumnRuneLevel } from './rune-interactions.mjs';
import teamSeat from './assets/team-seat.svg';

const DRAFT_KEY = 'mementomori-team-builder:draft:v1';
const ELEMENTS = {
  blue: { name: '蓝' },
  red: { name: '红' },
  green: { name: '绿' },
  yellow: { name: '黄' },
  light: { name: '光' },
  dark: { name: '暗' },
};
const SLOT_NAMES = { 1: '武器', 2: '项链', 3: '手套', 4: '头盔', 5: '衣服', 6: '脚' };
const JOB_NAMES = { 1: '战士', 2: '射手', 4: '法师' };
const RESOURCE_NAMES = {
  runeTickets: '饼干 · 符石兑换券', reinforcementMedicine: '红水 · 强化秘药',
  unidentifiedRune7: '7 级未鉴定符石', holySteel: '圣装经验等价',
  ssrFragments: 'SSR 装备碎片（禁忌）', forbiddenFragments: '禁忌武具碎片',
  urLrFragments: 'UR / LR 圣遗物碎片', exclusiveFragments: '专属武器碎片',
  lifeTreeDew: '叶子 · 生命树之露',
};
const DIAMOND_RESOURCE_NAMES = { lifeTreeDew: '叶子', exclusiveFragments: '紫水晶' };
const RARITY_SERIES = { SSR: 12, UR: 13, LR: 14 };
const characterLabel = character => character?.subtitle ? `${character.name} · ${character.subtitle}` : character?.name ?? '';
const FORMATTER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const amount = value => Number.isFinite(value) ? FORMATTER.format(value) : '—';
const numeric = value => value === '' ? '' : Number(value);
const runeSlots = category => category.slots ?? category.allowedSlots ?? category.equipmentSlots ?? [];
const fixedRuneTiers = policy => policy.runes?.fixedStock?.tiers ?? (policy.runes?.fixedStock ? [{ level: policy.runes.fixedStock.level, perCategory: policy.runes.fixedStock.perCategory }] : []);
const fixedRuneCaption = policy => fixedRuneTiers(policy).map(tier => `Lv.${tier.level} × ${tier.perCategory}`).join('、');
const TEAM_DRAG_TYPE = 'application/x-mementomori-team';
const POLISH_ATTRIBUTES = [['main', '主属性'], ['muscle', '力量'], ['energy', '战技'], ['health', '耐力'], ['intelligence', '魔力'], ['none', '四维均分']];

export function restoreDraft(catalog, policy, freeLibrary) {
  const empty = { ...createTeam(), level: policy.characterLevel };
  let originalRaw;
  try {
    originalRaw = localStorage.getItem(DRAFT_KEY);
    if (!originalRaw) return { team: empty, originalRaw: null, needsBackup: false, notice: null };
    const stored = JSON.parse(originalRaw);
    if (stored?.schemaVersion !== 1 || !stored?.team || !Array.isArray(stored.team.members)) throw new Error('草稿格式无法识别');
    const previous = stored.team;
    const knownCharacters = new Map(catalog.characters.map(character => [character.id, character]));
    const seen = new Set();
    const sourceSeen = new Set();
    const knownArcana = new Set((catalog.arcana?.groups ?? []).filter(group => group.published !== false).map(group => group.id));
    const purchasedArcanaIds = [];
    let repaired = previous.members.length !== 5 || previous.level !== policy.characterLevel;
    if (previous.purchasedArcanaIds != null && !Array.isArray(previous.purchasedArcanaIds)) repaired = true;
    for (const id of Array.isArray(previous.purchasedArcanaIds) ? previous.purchasedArcanaIds : []) {
      if (!Number.isSafeInteger(id) || !knownArcana.has(id) || purchasedArcanaIds.includes(id)) { repaired = true; continue; }
      purchasedArcanaIds.push(id);
    }
    const readableNumber = (value, fallback) => typeof value === 'number' || value === '' ? value : fallback;
    let recovered = {
      ...empty,
      name: typeof previous.name === 'string' ? previous.name : empty.name,
      author: typeof previous.author === 'string' ? previous.author : '',
      notes: typeof previous.notes === 'string' ? previous.notes : '',
      purchasedArcanaIds,
      members: empty.members.map((_, index) => {
        const source = previous.members[index];
        if (!source) return null;
        const character = knownCharacters.get(source.characterId);
        if (!character || seen.has(source.characterId)) { repaired = true; return null; }
        seen.add(source.characterId);
        const member = createMember(character);
        if (['SR', 'LR', 'LR5'].includes(source.rarity)) member.rarity = source.rarity;
        else repaired = true;
        if (!Array.isArray(source.equipment)) { repaired = true; return member; }
        member.equipment = member.equipment.map((emptyGear, gearIndex) => {
          const saved = source.equipment.find(gear => gear?.slot === emptyGear.slot) ?? source.equipment[gearIndex];
          if (!saved || !['NONE', 'SSR', 'UR', 'LR'].includes(saved.rarity)) { repaired = true; return emptyGear; }
          const savedPolish = saved.polishAttribute === undefined ? 'main' : saved.polishAttribute;
          const polishAttribute = VALID_POLISH_ATTRIBUTES.includes(savedPolish) ? savedPolish : 'main';
          if (polishAttribute !== savedPolish) repaired = true;
          if (saved.rarity === 'NONE') return { ...emptyGear, polishAttribute };
          if (!Array.isArray(saved.runes) || saved.runes.length !== 4) repaired = true;
          return {
            ...emptyGear, rarity: saved.rarity, polishAttribute, seriesId: saved.seriesId ?? RARITY_SERIES[saved.rarity],
            weaponKind: ['normal', 'exclusive'].includes(saved.weaponKind) ? saved.weaponKind : 'normal',
            syncSlot: emptyGear.slot === 1 ? readableNumber(saved.syncSlot, 0) : 0,
            weaponOwnerCharacterId: emptyGear.slot === 1 ? Number.isSafeInteger(saved.weaponOwnerCharacterId) ? saved.weaponOwnerCharacterId : character.id : null,
            level: readableNumber(saved.level, policy.characterLevel),
            reinforcementLevel: readableNumber(saved.reinforcementLevel, 0),
            legendSacredTreasureLevel: readableNumber(saved.legendSacredTreasureLevel, 0),
            matchlessSacredTreasureLevel: readableNumber(saved.matchlessSacredTreasureLevel, 0),
            runes: emptyGear.runes.map((emptyRune, runeIndex) => {
              const rune = saved.runes?.[runeIndex];
              if (!rune || !catalog.runeCategories.some(category => category.id === rune.categoryId)) { repaired = true; return emptyRune; }
              return { categoryId: rune.categoryId, level: readableNumber(rune.level, 0) };
            }),
          };
        });
        return member;
      }),
      weaponSources: (Array.isArray(previous.weaponSources) ? previous.weaponSources : []).flatMap(source => {
        if (!source || !knownCharacters.has(source.characterId) || sourceSeen.has(source.characterId)
          || !['SR', 'LR', 'LR5'].includes(source.characterRarity) || !['UR', 'LR'].includes(source.rarity)) { repaired = true; return []; }
        sourceSeen.add(source.characterId);
        return [{ characterId: source.characterId, characterRarity: source.characterRarity, rarity: source.rarity, level: readableNumber(source.level, 300) }];
      }),
    };
    for (const id of purchasedArcanaIds) {
      const purchased = setArcanaPurchased(recovered, id, true, catalog, policy, freeLibrary);
      if (purchased.members.some((member, index) => member?.rarity !== recovered.members[index]?.rarity)) repaired = true;
      recovered = purchased;
    }
    for (const source of recovered.weaponSources) {
      const actor = recovered.members.find(member => member?.characterId === source.characterId);
      if (actor && source.characterRarity !== actor.rarity) { source.characterRarity = actor.rarity; repaired = true; }
    }
    const migration = migrateLegacyWeaponConfiguration(recovered, catalog, policy, freeLibrary);
    recovered = migration.team;
    repaired ||= migration.changed;
    const versionChanged = stored.catalogVersion !== catalog.version;
    const needsBackup = repaired || versionChanged || JSON.stringify(cloneTeam(recovered)) !== JSON.stringify(previous);
    const notice = needsBackup ? {
      kind: 'info',
      text: migration.changed
        ? '已按当前规则恢复旧版武器等级，原草稿会另存备份。队外同步配置已移除，全部费用按当前配队重新计算。'
        : versionChanged
        ? '角色目录已更新，已迁移仍可用的角色和装备。原草稿会另存备份，请检查当前规则下的配置提示。'
        : '已恢复可识别的草稿配置，原始草稿会另存备份。请检查未恢复或需要调整的项目。',
    } : null;
    return { team: recovered, originalRaw, needsBackup, notice };
  } catch {
    return {
      team: empty, originalRaw, needsBackup: Boolean(originalRaw),
      notice: originalRaw ? { kind: 'error', text: '原草稿无法完整恢复，已保留原始内容并尝试另存备份。你可以新建方案；备份失败时会暂停自动保存。' } : null,
    };
  }
}

function fixedRuneInventory(team, catalog, policy, calculated) {
  if (Array.isArray(calculated?.fixedRuneInventory)) return calculated.fixedRuneInventory;
  const stock = policy.runes?.fixedStock;
  if (!stock) return [];
  const categories = catalog.runeCategories.filter(category => !stock.excludedCategoryIds.includes(category.id));
  const used = new Map(categories.flatMap(category => fixedRuneTiers(policy).map(tier => [`${category.id}:${tier.level}`, 0])));
  for (const member of team.members) {
    if (!member) continue;
    for (const gear of member.equipment) {
      if (gear.rarity === 'NONE') continue;
      for (const rune of gear.runes) {
        const key = `${rune.categoryId}:${rune.level}`;
        if (rune.level > 0 && used.has(key)) used.set(key, used.get(key) + 1);
      }
    }
  }
  return categories.flatMap(category => fixedRuneTiers(policy).map(tier => {
    const count = used.get(`${category.id}:${tier.level}`);
    return { categoryId: category.id, name: category.name, level: tier.level, used: count, available: tier.perCategory, remaining: tier.perCategory - count };
  }));
}

function Icon({ name, size = 16, ...props }) {
  const paths = {
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
    download: <><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4" /></>,
    upload: <><path d="M12 16V4m-4 4 4-4 4 4M4 17v4h16v-4" /></>,
    left: <path d="m14 6-6 6 6 6" />,
    right: <path d="m10 6 6 6-6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    gear: <><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z" /><circle cx="12" cy="12" r="3" /></>,
    sword: <><path d="m5 19 13-13 2-3-3 2L4 18m1-5 6 6m-7-2-2 2 3 3 2-2" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="M12 7v10" /></>,
    sparkle: <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] ?? paths.gear}</svg>;
}

function GameIconFrame({ iconArt, rarity, type = 'character' }) {
  const filterId = `icon-tint-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const variant = (type === 'character' ? iconArt?.characterRarities : iconArt?.equipmentRarities)?.[rarity];
  const geometry = type === 'character' ? iconArt?.characterGeometry : iconArt?.equipmentGeometry;
  const source = iconArt?.frames?.[variant?.frame];
  if (!source || !geometry) return null;
  const { sourceInsets, targetInsets, canvasSize } = geometry;
  const stars = iconArt.characterStars;
  const edges = ['top', 'right', 'bottom', 'left'];
  const style = {
    borderImageSource: `url("${source}")`,
    borderImageSlice: edges.map(edge => sourceInsets[edge]).join(' '),
    borderImageWidth: edges.map(edge => `${targetInsets[edge] / canvasSize * 100}%`).join(' '),
    inset: `${-(geometry.outward ?? 0) / canvasSize * 100}%`,
    ...(variant.tintMatrix ? { filter: `url(#${filterId})` } : {}),
  };
  return <>
    {variant.tintMatrix && <svg className="icon-filter-defs" width="0" height="0" aria-hidden="true"><defs><filter id={filterId} colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values={variant.tintMatrix} /></filter></defs></svg>}
    <span className="game-icon-frame" data-rarity={rarity} data-frame={variant.frame} style={style} aria-hidden="true" />
    {variant.starCount > 0 && iconArt.goldStar && stars && <span className="rarity-stars" aria-hidden="true">{Array.from({ length: variant.starCount }, (_, index) => <img key={index} src={iconArt.goldStar} alt="" draggable={false} style={{ left: `${(stars.x + index * stars.step) / stars.canvasSize * 100}%`, top: `${stars.y / stars.canvasSize * 100}%`, width: `${stars.width / stars.canvasSize * 100}%`, height: `${stars.height / stars.canvasSize * 100}%` }} />)}</span>}
  </>;
}

function Portrait({ character, elementIcons, jobIcons, iconArt, rarity = 'SR', badge = true }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [character?.id, character?.portrait]);
  const element = ELEMENTS[character?.element];
  const elementIcon = elementIcons?.[character?.element];
  const jobName = JOB_NAMES[character?.job];
  const jobIcon = jobIcons?.[character?.job];
  return <div className={`portrait-frame${iconArt?.characterRarities?.[rarity] ? ' has-rarity-frame' : ''}`}>
    {character?.portrait && !failed
      ? <img className="portrait-image" src={character.portrait} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
      : <span className="portrait-fallback" aria-hidden="true">{character?.name?.slice(0, 1) ?? '✧'}</span>}
    <GameIconFrame iconArt={iconArt} rarity={rarity} />
    {badge && element && elementIcon && <img className="element-badge" src={elementIcon} alt={`${element.name}属性`} title={`${element.name}属性`} draggable={false} />}
    {badge && jobName && jobIcon && <img className="job-badge" src={jobIcon} alt={jobName} title={jobName} draggable={false} />}
  </div>;
}

function Field({ label, path, errors, children, full = false }) {
  const issue = errors?.find(item => item.path === path);
  return <label className={`field${full ? ' full' : ''}`}>
    <span className="field-label">{label}</span>
    {children}
    {issue && <span className="input-error" role="alert">{issue.message}</span>}
  </label>;
}

function SacredBonus({ kind, level, slot, catalog }) {
  const bonus = catalog.equipmentBonuses?.kinds?.[kind]?.slots?.[slot];
  const value = Number.isSafeInteger(level) && level >= 0 ? bonus?.values?.[level] : undefined;
  const operation = { percentIncrease: '比例加成', addRate: '加算百分点', addValue: '固定数值' }[bonus?.operation];
  const text = level === 0 ? '未附加' : Number.isFinite(value) ? `${bonus.label} +${amount(value)}${bonus.unit === 'percent' ? '%' : ''}` : '—';
  return <span className="sacred-bonus" data-kind={kind} title={operation ? `${bonus.label} · ${operation}；仅显示此装备的附加属性` : undefined}>{text}</span>;
}

function equipmentLevels(catalog, rarity, weaponKind) {
  if (rarity === 'NONE') return [];
  const tableKey = weaponKind === 'exclusive' ? `exclusive${rarity}` : rarity;
  const table = catalog.equipmentCosts?.fragments?.[tableKey];
  if (table) return Object.keys(table).map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b);
  return catalog.equipmentCosts?.allowedLevels?.[rarity] ?? [];
}

export function EquipmentArt({ gear, member, catalog, rarity = gear.rarity, detail = false }) {
  const shadowId = `equipment-shadow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const character = catalog.characters.find(item => item.id === member.characterId);
  const owner = catalog.characters.find(item => item.id === (gear.weaponOwnerCharacterId ?? member.characterId));
  const source = gear.slot === 1 && gear.weaponKind === 'exclusive'
    ? owner?.exclusiveWeaponIcon
    : catalog.iconArt?.equipmentIcons?.[character?.job]?.[rarity]?.[gear.slot];
  const composition = catalog.iconArt?.equipmentComposition;
  const hasHoly = gear.legendSacredTreasureLevel > 0;
  const hasDark = gear.matchlessSacredTreasureLevel > 0;
  const plateKind = hasHoly ? hasDark ? 'both' : 'holy' : hasDark ? 'dark' : 'normal';
  const palette = composition?.plate.palettes[plateKind];
  const rectStyle = rect => ({ left: `${rect.x / composition.canvasSize * 100}%`, top: `${rect.y / composition.canvasSize * 100}%`, width: `${rect.width / composition.canvasSize * 100}%`, height: `${rect.height / composition.canvasSize * 100}%` });
  const lightGradient = light => `radial-gradient(circle at ${light.cx * 100}% ${light.cy * 100}%, color-mix(in srgb, ${light.color} ${light.opacity * 100}%, transparent), transparent ${light.radius * 100}%)`;
  const plateStyle = composition && palette ? { ...rectStyle(composition.plate), borderRadius: `${composition.plate.radius / composition.plate.width * 100}%`, backgroundImage: [lightGradient(composition.plate.light), lightGradient(composition.plate.glow), `linear-gradient(180deg,${palette.colors[0]},${palette.colors[1]} ${palette.middleOffset * 100}%,${palette.colors[2]})`].join(',') } : undefined;
  const shadows = Object.entries(composition?.foreground.shadow ?? {});
  const foregroundStyle = composition ? { ...rectStyle(composition.foreground), objectFit: composition.foreground.fit, ...(shadows.length ? { filter: `url(#${shadowId})` } : {}) } : undefined;
  return <span className={`equipment-art${detail ? ' is-detailed' : ''}`} data-rarity={rarity}>
    {shadows.length > 0 && <svg className="icon-filter-defs" width="0" height="0" aria-hidden="true"><defs><filter id={shadowId} x="-20%" y="-20%" width="140%" height="160%" primitiveUnits="objectBoundingBox" colorInterpolationFilters="sRGB">{shadows.map(([name, shadow]) => <feDropShadow key={name} in="SourceGraphic" dx={shadow.dx / composition.foreground.width} dy={shadow.dy / composition.foreground.height} stdDeviation={shadow.blur / composition.foreground.width} floodColor={shadow.color} floodOpacity={shadow.opacity} result={`shadow-${name}`} />)}<feMerge>{shadows.map(([name]) => <feMergeNode key={name} in={`shadow-${name}`} />)}<feMergeNode in="SourceGraphic" /></feMerge></filter></defs></svg>}
    {plateStyle && <span className="equipment-art-plate" data-plate={plateKind} style={plateStyle} aria-hidden="true" />}
    {source ? <img className="equipment-art-image" src={source} alt="" loading="lazy" draggable={false} style={foregroundStyle} /> : <span className="equipment-art-fallback" aria-hidden="true">{rarity}</span>}
    <GameIconFrame iconArt={catalog.iconArt} rarity={rarity} type="equipment" />
    {detail && <span className="equipment-art-details">
      <span className="equipment-art-level" aria-label={`装备上限等级${gear.level}`}>Lv.{Number.isSafeInteger(gear.level) ? gear.level : '—'}</span>
      {Number.isSafeInteger(gear.legendSacredTreasureLevel) && gear.legendSacredTreasureLevel > 0 && gear.legendSacredTreasureLevel <= (catalog.limits?.sacredTreasureLevel ?? 40) && <span className="equipment-art-holy" aria-label={`圣装加${gear.legendSacredTreasureLevel}`}>+{gear.legendSacredTreasureLevel}</span>}
      <span className="equipment-art-reinforcement" aria-label={`强化等级${gear.reinforcementLevel}`}>+{Number.isSafeInteger(gear.reinforcementLevel) ? gear.reinforcementLevel : '—'}</span>
      <span className="equipment-art-runes" aria-label="已装符石">{gear.runes.map((rune, index) => {
        const category = catalog.runeCategories.find(item => item.id === rune.categoryId);
        const active = Number.isSafeInteger(rune.level) && rune.level > 0;
        const icon = catalog.runeIcons?.[rune.categoryId];
        return <span className={`equipment-art-rune${active ? ' is-filled' : ''}`} key={index} title={`第${index + 1}孔：${active ? `${category?.name ?? '符石'} Lv.${rune.level}` : '空孔'}`}>
          {active && icon && <img src={icon} alt={category?.name ?? '符石'} draggable={false} />}
          {active && <small>{rune.level}</small>}
        </span>;
      })}</span>
    </span>}
  </span>;
}

function MemberEquipmentSummary({ member, position, catalog }) {
  const equipped = member.equipment.filter(gear => gear.rarity !== 'NONE');
  const levels = equipped.map(gear => gear.matchlessSacredTreasureLevel);
  const validLevels = levels.every(level => Number.isFinite(level));
  const minimum = Math.min(...levels);
  const maximum = Math.max(...levels);
  const caption = !equipped.length ? '未装备' : !validLevels ? '魔装待确认' : minimum === maximum ? `魔装 ${minimum}` : `魔装 ${minimum}–${maximum}`;
  const details = member.equipment.map(gear => `${SLOT_NAMES[gear.slot]}：${gear.rarity === 'NONE' ? '未装备' : `${gear.rarity} · 魔装 ${gear.matchlessSacredTreasureLevel}`}`).join('；');
  return <div className="member-equipment-summary" aria-label={`位置${position}装备与魔装`}>
    <div className="member-equipment-icons">{member.equipment.map(gear => <span key={gear.slot} className={`member-equipment-item${gear.rarity === 'NONE' ? ' is-empty' : ''}`} title={`${SLOT_NAMES[gear.slot]}：${gear.rarity === 'NONE' ? '未装备' : `${gear.rarity} · 魔装 ${gear.matchlessSacredTreasureLevel}`}`} aria-label={`${SLOT_NAMES[gear.slot]} ${gear.rarity === 'NONE' ? '未装备' : `${gear.rarity} 魔装${gear.matchlessSacredTreasureLevel}`}`}>
      {gear.rarity === 'NONE' ? <span aria-hidden="true">−</span> : <EquipmentArt gear={gear} member={member} catalog={catalog} />}
    </span>)}</div>
    <span className="member-matchless" title={details}>{caption}</span>
  </div>;
}

export function EquipmentEditor({ gear, index, member, catalog, policy, freeLibrary, onChange, onRuneChange, onRuneCommit, batchSourceRuneIndex, runeFillReport, errors, memberIndex, inventory, borrowableWeapons, ownWeaponClaimed, part = 'A' }) {
  const prefix = `members[${memberIndex}].equipment[${index}]`;
  const availableRunes = catalog.runeCategories.filter(category => runeSlots(category).includes(gear.slot));
  const levels = equipmentLevels(catalog, gear.rarity, gear.weaponKind).filter(level => level <= policy.characterLevel);
  const series = (catalog.equipmentSeries ?? catalog.series ?? []).find(item => item.id === gear.seriesId);
  const maximumSacred = catalog.limits?.sacredTreasureLevel ?? policy.limits?.sacredTreasureLevel ?? 40;
  const maximumRune = catalog.limits?.runeLevel ?? policy.limits?.runeLevel ?? 15;
  const fixedStock = policy.runes?.fixedStock;
  const stockTiers = fixedRuneTiers(policy);
  const isFixedCategory = categoryId => fixedStock && !fixedStock.excludedCategoryIds.includes(categoryId);
  const ownerId = gear.weaponOwnerCharacterId ?? member.characterId;
  const ownerCharacter = catalog.characters.find(character => character.id === ownerId);
  const actor = catalog.characters.find(character => character.id === member.characterId);
  const ownWeaponName = actor?.exclusiveWeaponName ?? `${actor?.name ?? '角色'}专武`;
  const ownerWeaponName = ownerCharacter?.exclusiveWeaponName ?? `${ownerCharacter?.name ?? '角色'}专武`;
  const borrowed = ownerId !== member.characterId;
  const compatibleOwners = (freeLibrary?.exclusiveWeapons ?? []).filter(weapon => weapon.rarity === 'UR' && weapon.characterId !== member.characterId && catalog.characters.find(character => character.id === weapon.characterId)?.job === actor?.job);
  function updateGearLevel(level) {
    onChange({ ...gear, level, reinforcementLevel: levels.includes(level) ? Math.min(Number(gear.reinforcementLevel) || 0, level) : gear.reinforcementLevel });
  }
  function selectRarity(rarity) {
    if (rarity === 'NONE') { onChange(selectEquipmentRarity(gear, rarity)); return; }
    const updated = {
      ...selectEquipmentRarity(gear, rarity), weaponKind: gear.slot === 1 ? 'exclusive' : gear.weaponKind,
      weaponOwnerCharacterId: gear.slot === 1 ? (gear.rarity === 'NONE' || rarity === 'SSR' ? member.characterId : ownerId) : null,
      runes: gear.runes.map((rune, index) => rune.level === 0
        ? { ...rune, categoryId: availableRunes[index]?.id ?? availableRunes[0]?.id ?? rune.categoryId }
        : rune),
    };
    const allowed = equipmentLevels(catalog, rarity, updated.weaponKind).filter(level => level <= policy.characterLevel);
    if (!allowed.includes(updated.level)) updated.level = gear.slot === 1 && gear.rarity === 'NONE' ? allowed[0] ?? 180 : allowed.at(-1) ?? policy.characterLevel;
    if (Number.isFinite(updated.reinforcementLevel)) updated.reinforcementLevel = Math.min(updated.reinforcementLevel, updated.level);
    onChange(updated);
  }
  function setWeaponKind(weaponKind) {
    const updated = { ...gear, weaponKind, weaponOwnerCharacterId: weaponKind === 'normal' ? member.characterId : ownerId };
    const allowed = equipmentLevels(catalog, gear.rarity, weaponKind).filter(level => level <= policy.characterLevel);
    if (!allowed.includes(updated.level)) updated.level = allowed.at(-1) ?? policy.characterLevel;
    if (Number.isFinite(updated.reinforcementLevel)) updated.reinforcementLevel = Math.min(updated.reinforcementLevel, updated.level);
    onChange(updated);
  }
  function chooseWeaponOwner(nextOwnerId) {
    const gift = freeLibrary?.exclusiveWeapons.find(weapon => weapon.characterId === nextOwnerId);
    const rarity = gift?.rarity ?? 'SSR';
    const level = gift?.level ?? 180;
    onChange({ ...gear, weaponKind: 'exclusive', weaponOwnerCharacterId: nextOwnerId, rarity, seriesId: RARITY_SERIES[rarity], level, reinforcementLevel: Math.min(Number(gear.reinforcementLevel) || 0, level) });
  }
  function setRune(runeIndex, updates, kind = Object.hasOwn(updates, 'categoryId') ? 'category' : 'level') {
    const nextRune = { ...gear.runes[runeIndex], ...updates };
    if (onRuneChange) onRuneChange(runeIndex, nextRune, kind);
    else onChange({ ...gear, runes: gear.runes.map((rune, i) => i === runeIndex ? nextRune : rune) });
  }
  return <section className={`equipment-card equipment-part-${part.toLowerCase()}${gear.rarity === 'NONE' ? ' empty-equipment' : ''}`} aria-label={SLOT_NAMES[gear.slot]}>
    <div className="equipment-card-header">
      <h3 className="equipment-name"><Icon name={gear.slot <= 3 ? 'sword' : 'shield'} size={15} />{SLOT_NAMES[gear.slot]}</h3>
      <select className="equipment-rarity" aria-label={`${SLOT_NAMES[gear.slot]}稀有度`} value={gear.rarity} onChange={event => selectRarity(event.target.value)}>
        <option value="NONE">未装备</option><option value="SSR">SSR</option><option value="UR">UR</option>
        <option value="LR" disabled={member.rarity !== 'LR5'}>LR{member.rarity !== 'LR5' ? ' · 需 LR5' : ''}</option>
      </select>
    </div>
    <div className="equipment-visual-row">
      <div className="equipment-current-art">{gear.rarity === 'NONE' ? <span className="equipment-preview-empty">未装备</span> : <EquipmentArt gear={gear} member={member} catalog={catalog} detail />}</div>
      <div className="equipment-tier-options" role="group" aria-label={`${SLOT_NAMES[gear.slot]}装备档位`}>
      {['SSR', 'UR', 'LR'].map(rarity => <button key={rarity} className={`equipment-tier-button${gear.rarity === rarity ? ' active' : ''}`} type="button" aria-label={`${SLOT_NAMES[gear.slot]}切换${rarity}${rarity === 'LR' && member.rarity !== 'LR5' ? '，需要LR5角色' : ''}`} aria-pressed={gear.rarity === rarity} disabled={rarity === 'LR' && member.rarity !== 'LR5'} onClick={() => selectRarity(rarity)}>
        <EquipmentArt gear={{ ...gear, weaponKind: gear.slot === 1 ? 'exclusive' : gear.weaponKind, weaponOwnerCharacterId: rarity === 'SSR' ? member.characterId : ownerId }} member={member} catalog={catalog} rarity={rarity} />
        <span>{rarity}</span>
      </button>)}
      </div>
    </div>
    <div className="fixed-series">{gear.rarity === 'NONE' ? '选择档位以装备' : <>{gear.weaponKind === 'exclusive' ? `${borrowed ? '借用 ' : ''}${ownerWeaponName}` : series?.name ?? gear.rarity}{gear.rarity === 'LR' ? ' · 需 LR5 角色' : ''}</>}</div>
    {gear.rarity === 'NONE' ? <><div className="equipment-source-band" /><p className="empty-equipment-note">选择装备后设置养成与符石</p></> : part === 'A' ? <>
      <div className="equipment-source-band equipment-fields">
        {gear.slot === 1 && gear.weaponKind === 'normal' && ['UR', 'LR'].includes(gear.rarity) && <p className="input-error">UR / LR 武器需使用专武。<button className="rune-repair" onClick={() => setWeaponKind('exclusive')}>改为专属武器</button></p>}
        {gear.slot === 1 && gear.weaponKind === 'exclusive' && <Field label="专武来源" path={`${prefix}.weaponOwnerCharacterId`} errors={errors} full>
          <select aria-label="专武所属角色" value={ownerId} onChange={event => chooseWeaponOwner(Number(event.target.value))}>
            <option value={member.characterId} disabled={ownWeaponClaimed && ownerId !== member.characterId}>{ownWeaponName}{ownWeaponClaimed ? ' · 已使用' : ''}</option>
            {borrowed && !compatibleOwners.some(weapon => weapon.characterId === ownerId) && <option value={ownerId}>{ownerCharacter?.name} · {ownerWeaponName} · 不可借用</option>}
            {compatibleOwners.map(weapon => { const character = catalog.characters.find(item => item.id === weapon.characterId); const weaponName = character?.exclusiveWeaponName ?? `${character?.name ?? '角色'}专武`; return <option key={weapon.characterId} value={weapon.characterId} disabled={ownerId !== weapon.characterId && !borrowableWeapons.some(item => item.characterId === weapon.characterId)}>{character?.name} · {weaponName} · 免费 UR Lv.{weapon.level}{!borrowableWeapons.some(item => item.characterId === weapon.characterId) && ownerId !== weapon.characterId ? ' · 已使用' : ''}</option>; })}
          </select>
          {borrowed && <span className="borrowed-weapon-note">同职业借用 · 此武器不提供当前角色的专武技能，每把免费专武仅能装备给一人。</span>}
        </Field>}
        {gear.slot === 1 && gear.rarity === 'SSR' && <Field label="武器类型" path={`${prefix}.weaponKind`} errors={errors} full>
          <select aria-label="武器类型" value={gear.weaponKind} onChange={event => setWeaponKind(event.target.value)}><option value="exclusive">专属武器</option><option value="normal">SSR 通用武器</option></select>
        </Field>}
      </div>
      <div className="equipment-fields equipment-level-fields">
        <Field label="装备等级" path={`${prefix}.level`} errors={errors}>
          <input aria-label={`${SLOT_NAMES[gear.slot]}装备等级`} type="number" min={levels[0] ?? 1} max={levels.at(-1) ?? policy.characterLevel} step="1" title={`可用装备等级：${levels.join('、')}`} value={gear.level} onChange={event => updateGearLevel(numeric(event.target.value))} />
        </Field>
        <Field label="强化等级" path={`${prefix}.reinforcementLevel`} errors={errors}>
          <input aria-label={`${SLOT_NAMES[gear.slot]}强化等级`} type="number" min="0" max={gear.level} step="1" value={gear.reinforcementLevel} onChange={event => onChange({ ...gear, reinforcementLevel: numeric(event.target.value) })} />
        </Field>
        <Field label={<><span>圣装等级</span><SacredBonus kind="legend" level={gear.legendSacredTreasureLevel} slot={gear.slot} catalog={catalog} /></>} path={`${prefix}.legendSacredTreasureLevel`} errors={errors}>
          <input aria-label={`${SLOT_NAMES[gear.slot]}圣装等级`} type="number" min="0" max={maximumSacred} step="1" value={gear.legendSacredTreasureLevel} onChange={event => onChange({ ...gear, legendSacredTreasureLevel: numeric(event.target.value) })} />
        </Field>
        <Field label={<><span>魔装等级</span><SacredBonus kind="matchless" level={gear.matchlessSacredTreasureLevel} slot={gear.slot} catalog={catalog} /></>} path={`${prefix}.matchlessSacredTreasureLevel`} errors={errors}>
          <input aria-label={`${SLOT_NAMES[gear.slot]}魔装等级`} type="number" min="0" max={maximumSacred} step="1" value={gear.matchlessSacredTreasureLevel} onChange={event => onChange({ ...gear, matchlessSacredTreasureLevel: numeric(event.target.value) })} />
        </Field>
      </div>
    </> : <>
      <div className="equipment-fields equipment-polish-fields">
        <Field label="满打磨属性" path={`${prefix}.polishAttribute`} errors={errors} full>
          <select aria-label={`${SLOT_NAMES[gear.slot]}满打磨属性`} value={gear.polishAttribute ?? 'main'} onChange={event => onChange({ ...gear, polishAttribute: event.target.value })}>{POLISH_ATTRIBUTES.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select>
          <span className="polish-note">{gear.polishAttribute === 'none' ? '四维均分，不定向打磨；不计费用。' : '满打磨：所选属性 60%，其余均分；不计费用。'}</span>
        </Field>
      </div>
      <div className="rune-section">
        <div className="rune-heading"><span>符石孔</span><span>{gear.slot <= 3 ? '攻击类' : '防御类'} · 同类不可重复</span></div>
        <p className="rune-auto-note">四个孔均可填入同列对应空孔，首次等级一起同步；离开等级框后独立调整，已有符石保留。</p>
        {runeFillReport && <p className="rune-auto-note" role="status">第 {runeFillReport.runeIndex + 1} 孔 {catalog.runeCategories.find(category => category.id === runeFillReport.categoryId)?.name}：{runeFillReport.filledSlots.length ? `${runeFillReport.filledSlots.map(slot => SLOT_NAMES[slot]).join('／')}已同步` : '本孔已更新'}{runeFillReport.skippedSlots.map(item => `；${SLOT_NAMES[item.slot]}${{ unequipped: '未装备', incompatible: '不支持此符石', occupied: '已有符石，已保留', duplicate: '其它孔已有同类符石', stock: '对应等级库存不足' }[item.reason]}`).join('')}。</p>}
        <div className="rune-holes">{gear.runes.map((rune, runeIndex) => {
          const active = rune.level !== 0 || batchSourceRuneIndex === runeIndex;
          const fixedLevel = active && isFixedCategory(rune.categoryId);
          const issue = errors.find(item => item.path.startsWith(`${prefix}.runes[${runeIndex}]`));
          return <div className="rune-column" key={runeIndex}>
            <div className="rune-row">
              <span className="rune-number">第 {runeIndex + 1} 孔</span>
              <select aria-label={`${SLOT_NAMES[gear.slot]}第${runeIndex + 1}孔符石类别`} value={active ? rune.categoryId : ''} onChange={event => {
                if (event.target.value === '') { setRune(runeIndex, { level: 0 }, 'category'); return; }
                const categoryId = Number(event.target.value);
                setRune(runeIndex, { categoryId, level: chooseInitialColumnRuneLevel(member, gear.slot, runeIndex, categoryId, catalog, policy, inventory) });
              }}>
                <option value="">空孔</option>
                {availableRunes.map(category => {
                  const categoryStock = inventory.filter(item => item.categoryId === category.id);
                  const remaining = categoryStock.reduce((sum, item) => sum + Math.max(0, item.remaining), 0);
                  const alreadyHere = active && rune.categoryId === category.id;
                  const unavailable = categoryStock.length > 0 && remaining <= 0 && !alreadyHere;
                  return <option key={category.id} value={category.id} disabled={unavailable || gear.runes.some((other, i) => i !== runeIndex && other.level > 0 && other.categoryId === category.id)}>{category.name.replace(/符石$/, '')}{categoryStock.length > 0 ? ` · 余${remaining}` : ''}</option>;
                })}
              </select>
              <span className="rune-level-label">等级</span>
              {fixedLevel
                ? <select aria-label={`${SLOT_NAMES[gear.slot]}第${runeIndex + 1}孔固定符石等级`} className="fixed-rune-level" value={rune.level} onChange={event => setRune(runeIndex, { level: Number(event.target.value) })} onBlur={() => onRuneCommit?.(runeIndex)}>
                  {!stockTiers.some(tier => tier.level === rune.level) && <option value={rune.level}>Lv.{rune.level} · 不可用</option>}
                  {stockTiers.map(tier => {
                    const stock = inventory.find(item => item.categoryId === rune.categoryId && item.level === tier.level);
                    return <option key={tier.level} value={tier.level} disabled={rune.level !== tier.level && stock?.remaining <= 0}>Lv.{tier.level}</option>;
                  })}
                </select>
                : <input aria-label={`${SLOT_NAMES[gear.slot]}第${runeIndex + 1}孔符石等级`} type="number" min="0" max={maximumRune} step="1" disabled={!active} value={rune.level !== 0 ? rune.level : ''} placeholder="—" onChange={event => setRune(runeIndex, { level: numeric(event.target.value) })} onBlur={() => onRuneCommit?.(runeIndex)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />}
            </div>
            {fixedLevel && !stockTiers.some(tier => tier.level === rune.level) && <button className="rune-repair" onClick={() => setRune(runeIndex, { level: stockTiers[0].level })}>调整为 Lv.{stockTiers[0].level}</button>}
            {issue && <p className="input-error" role="alert">{issue.message}</p>}
          </div>;
        })}</div>
      </div>
    </>}
  </section>;
}

export function ArcanaEditor({ state, catalog, onPurchase }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const characters = new Map([...catalog.characters, ...(catalog.arcana?.supportCharacters ?? [])].map(character => [character.id, character]));
  const ledger = new Map((state.ledger ?? []).map(item => [item.characterId, item]));
  const groups = state.groups.filter(group => (filter === 'all' || filter === 'unlocked' && group.unlocked || filter === 'available' && !group.unlocked)
    && `${group.name} ${group.characterIds.map(id => characterLabel(characters.get(id))).join(' ')}`.includes(search.trim()));
  const held = (state.ledger ?? []).filter(item => ['LR', 'LR5'].includes(item.rarity));
  const bonuses = state.bonusRows ?? state.lrBonuses;
  const bonusValue = bonus => bonus.displayValue ?? `${bonus.value}${bonus.unit ?? ''}`;
  const sourceNames = { team: '配队', arcana: '秘仪购买', freeLibrary: '免费库', permanent: '常驻免费' };
  return <div className="arcana-page" id="arcana-page" role="tabpanel" aria-labelledby="arcana-tab">
    {state.errors.length > 0 && <div className="notice error" role="alert">{state.errors.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}
    <div className="arcana-intro"><h2>秘仪 · LR 档</h2><p>购买后获得全部关联角色的 LR 持有资格。配队与多个秘仪共享角色，同一角色按最高稀有度计费。</p><p>加成随关联角色实际持有档位自动解锁，购买只补齐 LR 档。卡片价格是当前补齐差额，不能直接相加；总费用请以右侧预算为准。</p></div>
    <section className="arcana-bonus-summary" aria-label="秘仪加成汇总"><h3>当前秘仪加成汇总</h3><div className="arcana-bonus-list">{bonuses.length ? bonuses.map((bonus, index) => <span key={index}>{bonus.label}<strong>{bonusValue(bonus)}</strong></span>) : <p>当前尚无已解锁加成。</p>}</div><p>此处汇总构筑加成；5830 中的战斗属性接入将在后续完成。</p></section>
    <details className="arcana-held"><summary>持有 LR 及以上角色 <span>{held.length} 位</span></summary><p>只读持有表。免费库、配队和秘仪合并计算，取消购买不会降低已配置队员的稀有度。</p><div>{held.map(item => <span key={item.characterId}><strong>{characterLabel(characters.get(item.characterId))}</strong><small>{item.rarity} · {(item.sourceKinds ?? []).map(source => sourceNames[source] ?? '共享持有').join('、')}</small></span>)}</div></details>
    <div className="arcana-toolbar"><label className="search"><Icon name="search" size={14} /><input aria-label="搜索秘仪或关联角色" placeholder="搜索秘仪或关联角色" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="filter-row" role="group" aria-label="秘仪状态筛选">{[['all', '全部'], ['unlocked', '已解锁'], ['available', '待补齐']].map(([id, label]) => <button key={id} className={`filter-button${filter === id ? ' active' : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div></div>
    <div className="arcana-groups">{groups.map(group => <section className={`arcana-card${group.unlocked ? ' unlocked' : ''}`} key={group.id} aria-label={group.name}>
      <div className="arcana-card-header"><h3>{group.name}</h3><span>{group.published === false ? '未开放' : group.permanent && group.unlocked ? '常驻已解锁' : group.purchased ? '已购买' : group.unlocked ? '持有角色已满足' : '待补齐'}{group.unlocked && group.bonusTierLabel ? ` · ${group.bonusTierLabel}` : ''}</span></div>
      <div className="arcana-members">{group.characterIds.map(id => {
        const character = characters.get(id);
        const owned = ledger.get(id);
        const hasLR = ['LR', 'LR5'].includes(owned?.rarity);
        if (!character) return <div className="arcana-member unpublished" key={id}><span className="arcana-unpublished-placeholder">未开放</span><small>暂不可获取</small></div>;
        return <div className="arcana-member" key={id}><Portrait character={character} elementIcons={catalog.elementIcons} jobIcons={catalog.jobIcons} iconArt={catalog.iconArt} rarity={owned?.rarity ?? 'SR'} /><span title={characterLabel(character)}>{character?.name}</span><small>{hasLR ? `持有 ${owned.rarity}` : '购买获得 LR'}</small></div>;
      })}</div>
      <p className="arcana-bonus-tier">{group.unlocked ? `${group.bonusTierLabel} 档加成 · 已生效` : group.published === false ? 'LR 档加成 · 暂未开放' : 'LR 档加成 · 补齐后生效'}</p>
      <div className="arcana-card-bonuses">{group.bonuses.map((bonus, index) => <span key={index}>{bonus.label}<strong>{bonusValue(bonus)}</strong></span>)}</div>
      {group.missingCharacters.length > 0 && <p className="arcana-missing" title={group.missingCharacters.map(item => `${item.characterName} ${item.fromRarity ?? '未持有'} → LR：${amount(item.diamonds)} 钻`).join('；')}>补齐 {group.missingCharacters.length} 名角色的 LR</p>}
      <div className="arcana-purchase"><strong>{group.published === false ? '尚未开放' : group.unlocked ? '已解锁' : `补齐 ${amount(group.currentPurchaseDiamonds)} 钻`}</strong>{group.purchased ? <button className="button" onClick={() => onPurchase(group.id, false)} aria-label={`取消购买${group.name}`}>取消购买</button> : <button className="button gold" disabled={group.published === false || group.unlocked} onClick={() => onPurchase(group.id, true)} aria-label={`购买${group.name}LR档`}>{group.published === false ? '暂不可购买' : group.permanent && group.unlocked ? '常驻已解锁' : group.unlocked ? '已解锁' : '购买 LR 档'}</button>}</div>
    </section>)}{groups.length === 0 && <p className="no-results">没有找到符合条件的秘仪</p>}</div>
  </div>;
}

export function ResourcePriceHelp({ policy }) {
  const prices = policy.unitPrices ?? {};
  const conversions = policy.conversions ?? {};
  const relicMaterials = conversions.relicMaterialsPerExchange ?? 2;
  const relicFragments = conversions.urLrFragmentsPerExchange ?? 50;
  const crystals = conversions.magicCrystalsPerExclusiveExchange ?? 3;
  const exclusiveFragments = conversions.exclusiveFragmentsPerExchange ?? 10;
  const ssrFragments = conversions.ssrFragmentsPerProduct ?? 15;
  const forgeFree = policy.blessings?.some(item => item.effect === 'freeEquipmentCrafting' && item.rarity === 'SSR' && item.weaponKind === 'normal');
  const rows = [
    ['角色本体', prices.characterCopy, '个本体', '受诅咒影响的本次单价'],
    ['饼干 · 符石兑换券', prices.runeTickets, '张', '超出免费额度后计价'],
    ['红水 · 强化秘药', prices.reinforcementMedicine, '个', '超出免费额度后计价'],
    ['圣装经验等价', prices.holySteel * (policy.holySteelPerExperience ?? 1), '份', '每份为一级圣装经验'],
    ['叶子 · 生命树之露', prices.lifeTreeDew, '个'],
    ['圣遗物材料', relicMaterials > 0 ? prices.urLrFragments * relicFragments / relicMaterials : null, '个'],
    ['UR / LR 装备碎片', prices.urLrFragments * relicFragments, `${amount(relicFragments)}片`],
    ['紫水晶', crystals > 0 ? prices.exclusiveFragments * exclusiveFragments / crystals : null, '个'],
    ['专武碎片', prices.exclusiveFragments * exclusiveFragments, `${amount(exclusiveFragments)}片`],
    ['禁忌武具材料', prices.ssrFragments * ssrFragments, '个', forgeFree ? '本次普通 SSR 制作免费' : '普通 SSR 制作参考价'],
    ['SSR 装备碎片', prices.ssrFragments, '片', forgeFree ? '本次普通 SSR 制作免费' : '普通 SSR 制作参考价'],
  ];
  return <details className="resource-price-help">
    <summary title="点击查看资源价格" aria-label="查看资源等价钻石价格"><Icon name="sparkle" size={18} /></summary>
    <section className="resource-price-card" aria-label="资源等价钻石价格">
      <h3>资源等价钻石</h3>
      <p className="resource-price-note">基础参考单价；免费库与恩泽沿用当前规则。实际投入以配队报价为准。</p>
      <table>
        <thead><tr><th scope="col">资源</th><th scope="col">单价</th></tr></thead>
        <tbody>{rows.map(([name, price, unit, note]) => <tr key={name}><th scope="row">{name}{note && <small>{note}</small>}</th><td>{amount(price)} 钻<small>/ {unit}</small></td></tr>)}</tbody>
      </table>
      <div className="resource-price-rules">
        <p>{amount(relicMaterials)} 个圣遗物材料 = {amount(relicFragments)} 片 UR / LR 装备碎片</p>
        <p>{amount(crystals)} 个紫水晶 = {amount(exclusiveFragments)} 片专武碎片</p>
        <p>1 个禁忌武具材料 = {amount(ssrFragments)} 片 SSR 装备碎片</p>
        {policy.runes?.fixedStock && <p>普通符石每类免费 {fixedRuneCaption(policy)}，不开放购买；穿透、速度按兑换券计价。</p>}
        <p>魔装经验、金币、强化水、精炼钢与打磨暂不计价。</p>
        <p>单价换算保留原始精度，合计后保留 {policy.rounding?.precision ?? 2} 位小数。</p>
      </div>
    </section>
  </details>;
}

function CostFoldout({ label, ariaLabel = label, className, diamonds, caption, children }) {
  return <details className={`cost-foldout ${className}`} aria-label={ariaLabel}>
    <summary><span className="cost-foldout-title">{label}</span><strong>{amount(diamonds)} 钻</strong>{caption && <small>{caption}</small>}</summary>
    <div className="cost-foldout-content">{children}</div>
  </details>;
}

function CostSummary({ cost, errors, policy, catalog, canExport, onExport, memberCount, inventory, arcanaState }) {
  const displayedResources = ['runeTickets', 'reinforcementMedicine', 'holySteel'];
  const steelRatio = policy.holySteelPerExperience || 1;
  const captionByResource = {
    runeTickets: '穿透、速度符石折算', reinforcementMedicine: '含武器与其余五件装备',
    holySteel: '按各部位累计经验合计',
  };
  const resourceLabel = key => RESOURCE_NAMES[key] ?? key;
  const scaled = (key, value) => key === 'holySteel' ? value / steelRatio : value;
  const costKey = item => `${item.sourceKind ?? 'team'}-${item.characterId}-${item.sourceIndex ?? item.position}-${item.slot ?? 'weapon'}`;
  const catalogCharacter = id => catalog.characters.find(character => character.id === id);
  const ordinaryCosts = cost?.equipmentCosts?.filter(item => item.weaponKind === 'normal' && item.rarity === 'SSR') ?? [];
  const relicFragmentCosts = cost?.equipmentCosts?.filter(item => item.sourceKind === 'team' && ['UR', 'LR'].includes(item.rarity) && item.fragmentResource === 'urLrFragments') ?? [];
  const relicFragments = relicFragmentCosts.reduce((sum, item) => sum + item.fragments, 0);
  const relicMaterialsPerExchange = policy.conversions?.relicMaterialsPerExchange ?? 2;
  const urLrFragmentsPerExchange = policy.conversions?.urLrFragmentsPerExchange ?? 50;
  const relicMaterials = urLrFragmentsPerExchange > 0 ? relicFragments * relicMaterialsPerExchange / urLrFragmentsPerExchange : 0;
  const relicFragmentDiamonds = relicFragmentCosts.reduce((sum, item) => sum + (item.chargedResourceDiamonds?.urLrFragments ?? 0), 0);
  const memberRelicCosts = new Map();
  for (const item of relicFragmentCosts) {
    const key = `${item.position ?? ''}:${item.characterId}`;
    const entries = memberRelicCosts.get(key) ?? [];
    entries.push(item);
    memberRelicCosts.set(key, entries);
  }
  const offTeamCosts = cost?.offTeamCharacterCosts?.filter(item => item.diamonds > 0) ?? [];
  const diamondResourceNames = DIAMOND_RESOURCE_NAMES;
  const diamondBudgetResources = Object.keys(diamondResourceNames).filter(key => policy.blessings?.some(blessing => blessing.effect === 'resourceDiamondAllowance' && blessing.resource === key));
  return <aside className="panel summary-panel" aria-label="资源与费用摘要">
    <div className="panel-header"><div className="panel-heading"><span className="section-index">03</span><h2>资源预算</h2></div><ResourcePriceHelp policy={policy} /></div>
    <p className="summary-top-note">全队统一额度 · 即时计算等价钻石</p>
    <div className="total-block">
      <div className="total-label">当前配队等价费用</div>
      <div className="total-value"><strong>{amount(cost?.totalDiamonds)}</strong><span>钻石</span></div>
      <p className="total-caption">{errors.length ? '请修正配置后查看准确费用' : `${memberCount} / 5 名角色 · 包含本体与超额材料`}</p>
    </div>
    <div className="resource-section-title"><span>已投入等价量</span><span>免费额度</span></div>
    <div className="resource-list">{displayedResources.map(key => {
      const resource = cost?.resources?.[key];
      const consumed = resource ? scaled(key, resource.consumed) : null;
      const free = scaled(key, resource?.freeAllowance ?? getResourceAllowance(policy, key));
      const charged = resource ? scaled(key, resource.charged) : null;
      const ratio = consumed == null ? 0 : free > 0 ? Math.min(1, consumed / free) : consumed > 0 ? 1 : 0;
      return <div className="resource-item" key={key}>
        <div className="resource-item-top"><span>{resourceLabel(key)}</span><strong>{amount(consumed)}</strong></div>
        <div className="resource-caption"><span>{captionByResource[key]}</span><span>{amount(free)} 免费</span></div>
        {(resource?.blessingAllowance ?? 0) > 0 && <p className="resource-blessing-breakdown">{resource.baseAllowance > 0 ? <>基础 {amount(scaled(key, resource.baseAllowance))} ＋ 恩泽 {amount(scaled(key, resource.blessingAllowance))} ＝ {amount(free)}</> : <>整队免费总额度 {amount(free)} {resourceLabel(key).split(' · ')[0]}</>}</p>}
        <div className={`resource-bar${charged > 0 ? ' exceeded' : ''}`}><span style={{ width: `${ratio * 100}%` }} /></div>
        {charged > 0 && <p className="resource-extra">超出 {amount(charged)} · +{amount(resource.diamonds)} 钻</p>}
      </div>;
    })}</div>
    {diamondBudgetResources.length > 0 && <section className="diamond-budget-list" aria-label="材料免费钻石预算"><div className="resource-section-title"><span>材料免费预算</span><span>整队共享</span></div>{diamondBudgetResources.map(key => {
      const resource = cost?.resources?.[key];
      const ratio = resource?.diamondAllowance > 0 ? Math.min(1, (resource.diamondAllowanceCredit ?? 0) / resource.diamondAllowance) : 0;
      return <div className="resource-item" key={key}><div className="resource-item-top"><span>{diamondResourceNames[key]}</span><strong>{amount(resource?.diamondAllowance)} 钻免费</strong></div><div className="resource-caption"><span>已使用 {amount(resource?.diamondAllowanceCredit)} 钻</span><span>剩余 {amount(resource?.remainingDiamondAllowance)} 钻</span></div><div className="resource-bar"><span style={{ width: `${ratio * 100}%` }} /></div>{resource?.diamonds > 0 && <p className="resource-extra">本项应付 {amount(resource.diamonds)} 钻</p>}</div>})}</section>}
    {inventory.length > 0 && <details className="inventory-details" open={inventory.some(item => item.remaining < 0)}>
      <summary>普通符石库存 <span>{fixedRuneCaption(policy)} / 类</span></summary>
      <p className="inventory-caption">两套库存按类别与等级分别共享，可选择 11 级或 10 级。穿透、速度使用兑换券。</p>
      <div className="inventory-list">{inventory.map(item => <div key={`${item.categoryId}-${item.level}`} className={`inventory-row${item.remaining < 0 ? ' exceeded' : ''}`}>
        <span>{item.name.replace(/符石$/, '')} · Lv.{item.level}</span><span>已用 {item.used} / {item.available}</span><strong>{item.remaining < 0 ? `超出 ${-item.remaining}` : `余 ${item.remaining}`}</strong>
      </div>)}</div>
    </details>}
    <div className="summary-divider" />
    <div className="price-breakdown">
      <div className="price-line"><span>角色本体</span><strong>{amount(cost?.characterDiamonds)} 钻</strong></div>
      <div className="price-line"><span>超额材料</span><strong>{amount(cost?.resourceDiamonds)} 钻</strong></div>
    </div>
    {(cost?.characterCosts?.some(item => item.sourceKind === 'arcana') || arcanaState?.groups?.some(group => group.purchased)) && <p className="shared-ownership-note">配队与秘仪按角色最高持有稀有度合并，同一角色只计一次本体费用。</p>}
    {relicFragmentCosts.length > 0 && <CostFoldout label="UR / LR 圣遗物装备碎片" ariaLabel="UR和LR圣遗物装备明细" className="relic-crafting-costs" diamonds={relicFragmentDiamonds} caption={`累计投入 ${amount(relicFragments)} 片 · 圣遗物等价 ${amount(relicMaterials)} 个`}>
      <p className="inventory-caption">{amount(urLrFragmentsPerExchange)} 碎片 = {amount(relicMaterialsPerExchange)} 个圣遗物材料；费用已计入总额。</p>
      {relicFragmentCosts.map(item => <div className="leaf-cost-row" key={costKey(item)}><span>{characterLabel(catalogCharacter(item.characterId))} · {SLOT_NAMES[item.slot]} {item.rarity}<small>投入 {amount(item.fragments)} 片 · 圣遗物等价 {amount(item.equivalentArtifactMaterials)} 个</small></span><strong>{amount(item.chargedResourceDiamonds?.urLrFragments ?? 0)} 钻</strong></div>)}
    </CostFoldout>}
    {cost?.memberCosts?.length > 0 && <CostFoldout label="队员实际投入" className="member-investments" diamonds={cost.memberCosts.reduce((sum, item) => sum + item.totalDiamonds, 0)}>
      <p className="inventory-caption">共享免费额度按队伍顺序使用；各项投入已计入总额。</p>{cost.memberCosts.map(item => { const memberRelics = memberRelicCosts.get(`${item.position ?? ''}:${item.characterId}`) ?? []; const memberRelicFragments = memberRelics.reduce((sum, relic) => sum + relic.fragments, 0); const memberRelicMaterials = urLrFragmentsPerExchange > 0 ? memberRelicFragments * relicMaterialsPerExchange / urLrFragmentsPerExchange : 0; return <div className="member-investment-row" key={item.characterId}><div><span title={characterLabel(catalogCharacter(item.characterId))}>{item.position}. {characterLabel(catalogCharacter(item.characterId)) || item.characterName}</span><strong>{amount(item.totalDiamonds)} 钻</strong></div><p>本体 {amount(item.characterDiamonds)} · 装备与养成 {amount(item.equipmentDiamonds)} 钻</p>{memberRelics.length > 0 && <p className="member-relic-fragments">圣遗物装备碎片 {amount(memberRelicFragments)} 片 · 圣遗物等价 {amount(memberRelicMaterials)} 个</p>}</div>; })}
    </CostFoldout>}
    {offTeamCosts.length > 0 && <CostFoldout label="秘仪队外投入" className="off-team-investments" diamonds={offTeamCosts.reduce((sum, item) => sum + item.diamonds, 0)}>{offTeamCosts.map(item => <div className="member-investment-row" key={item.characterId}><div><span>{item.characterName}</span><strong>{amount(item.diamonds)} 钻</strong></div></div>)}</CostFoldout>}
    {cost?.exclusiveWeaponCosts?.length > 0 && <CostFoldout label="专武造价" className="weapon-costs" diamonds={cost.exclusiveWeaponCosts.reduce((sum, item) => sum + item.diamonds, 0)}>
      {cost.exclusiveWeaponCosts.map(item => { const weaponOwner = catalogCharacter(item.weaponOwnerCharacterId ?? item.characterId); const weaponName = weaponOwner?.exclusiveWeaponName ?? `${weaponOwner?.name ?? item.characterName}专武`; return <div className="weapon-cost-item" key={costKey(item)}>
        <div className="weapon-cost-heading"><span>{item.characterName} · {weaponName} · {item.rarity} Lv.{item.level}</span><strong>{amount(item.diamonds)} 钻</strong></div>
        {item.borrowed && <p className="borrowed-weapon-note">借用 {item.weaponOwnerCharacterName} 的 {weaponName} · 不提供当前角色的专武技能</p>}
        {item.discounted && <p className="automatic-weapon-credit">自动同步 · 制作材料按 Lv.{item.billedLevel} 计算；强化与叶子按实际配置计费。</p>}
        <p>紫水晶等价 {amount(item.magicCrystals)} 个 · 实际投入 {amount(item.chargedFragmentDiamonds ?? item.chargedMagicCrystals * item.magicCrystalUnitPrice)} 钻</p>
        {item.lifeTreeDew > 0 && <p>叶子 {amount(item.lifeTreeDew)} 个 · 实际投入 {amount(item.chargedLifeTreeDewDiamonds ?? item.chargedLifeTreeDew * (policy.unitPrices?.lifeTreeDew ?? 0))} 钻</p>}
      </div>; })}
    </CostFoldout>}
    {ordinaryCosts.length > 0 && <CostFoldout label="普通 SSR 装备制作" ariaLabel="普通装备制作" className="ordinary-crafting-costs" diamonds={ordinaryCosts.reduce((sum, item) => sum + item.craftingDiamonds, 0)}>{ordinaryCosts.map(item => <div className="leaf-cost-row" key={costKey(item)}><span>{characterLabel(catalogCharacter(item.characterId))} · {SLOT_NAMES[item.slot]} {item.rarity}<small>SSR 制作碎片 {amount(item.fragments)} 片</small></span><strong>{amount(item.craftingDiamonds)} 钻</strong></div>)}</CostFoldout>}
    <details className="price-details"><summary>查看费用细目与规则</summary><div className="cost-detail-content">
      <dl>{cost?.characterCosts?.map(item => <React.Fragment key={costKey(item)}><dt>{item.characterName} · {item.rarity} · {item.copies} 本体{item.freeRarity ? `（免费至 ${item.freeRarity}）` : ''}{item.sourceKind === 'arcana' ? ' · 秘仪持有' : ''}</dt><dd>{amount(item.diamonds)} 钻</dd></React.Fragment>)}
        {RESOURCE_KEYS.filter(key => key !== 'unidentifiedRune7').map(key => {
          const resource = cost?.resources?.[key];
          if (!resource || resource.consumed === 0) return null;
          return <React.Fragment key={key}><dt>{RESOURCE_NAMES[key] ?? key} · {amount(resource.consumed)}</dt><dd>{amount(resource.diamonds)} 钻</dd></React.Fragment>;
        })}
      </dl>
      <p>角色本体：{amount(policy.unitPrices?.characterCopy)} 钻 / 个。</p>
      <p>符石兑换券超额单价 {amount(policy.unitPrices?.runeTickets)} 钻 / 张；强化秘药 {amount(policy.unitPrices?.reinforcementMedicine)} 钻 / 个；圣装经验 {amount((policy.unitPrices?.holySteel ?? 0) * steelRatio)} 钻 / 点。</p>
      <p>魔装累计经验 {amount(cost?.matchlessExperience)}。各类碎片独立计价；材料表示当前配置的累计投入，降级会减少预算。</p>
      <p>导出包含完整计价规则与费用细目。接收方会按当前规则重新计算。</p>
    </div></details>
    <button className="button primary summary-export" disabled={!canExport} onClick={onExport}><Icon name="download" />导出配队文件</button>
    <p className="summary-export-note">{memberCount < 5 ? '选齐 5 名角色即可导出' : errors.length ? '修正无效配置后即可导出' : '下载 JSON 文件，发送给站主用于构建'}</p>
    <p className="policy-footnote">规则版本：{policy.version ?? policy.revision ?? '当前规则'}<br />费用为构筑预算，不代表战力或战斗结果。</p>
  </aside>;
}

export function getCharacterStatsResult(member, catalog, policy, arcanaState, validationErrors = []) {
  if (!member) return null;
  if (validationErrors.length) return { valid: false, rows: [], errors: validationErrors, notes: [] };
  try { return calculateCharacterStats(member, catalog, policy, arcanaState); }
  catch (error) { return { valid: false, rows: [], errors: [{ message: error.message }], notes: [] }; }
}

export function CharacterStatsPanel({ result, policy }) {
  if (!result) return <div className="empty-detail" id="stats-page" role="tabpanel" aria-labelledby="stats-tab"><h2>先选择一名队员</h2><p>将角色拖入队伍位置，再查看角色属性。</p></div>;
  const groups = new Map();
  const groupLabels = { main: '主要属性', base: '四维属性', advanced: '进阶属性' };
  for (const row of result.rows ?? []) {
    const group = groupLabels[row.group] ?? '属性总览';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  return <div className="character-stats-page" id="stats-page" role="tabpanel" aria-labelledby="stats-tab"><div className="character-stats-intro"><h2>角色属性</h2><p>玩家等级 {amount(policy.baseline?.playerLevel)} · 战斗技能增益不计入</p></div>{result.errors?.length > 0 && <div className="notice error" role="alert">{result.errors.map((issue, index) => <p key={index}>{issue.message}</p>)}</div>}{result.valid && [...groups].map(([group, rows]) => <section className="character-stat-group" aria-label={group} key={group}><h3>{group}</h3><div className="character-stat-grid">{rows.map(row => row.parts?.length > 0 ? <details className="character-stat-row" key={row.key}><summary><span>{row.label}</span><strong>{row.displayValue}</strong></summary><dl>{row.parts.map((part, index) => <React.Fragment key={index}><dt>{part.label}</dt><dd>{part.displayValue}</dd></React.Fragment>)}</dl></details> : <div className="character-stat-row" key={row.key}><div className="character-stat-value"><span>{row.label}</span><strong>{row.displayValue}</strong></div></div>)}</div></section>)}{result.notes?.length > 0 && <div className="character-stats-notes" aria-label="属性计算口径">{result.notes.map((note, index) => <p key={index}>{note}</p>)}</div>}</div>;
}

function BlessingCard({ blessing, policy }) {
  const resourceName = RESOURCE_NAMES[blessing.resource]?.split(' · ')[0] ?? '';
  const baseAllowance = policy.allowances?.[blessing.resource] ?? 0;
  return <aside className="intro-note blessing-note" aria-label="恩泽机制"><strong>{blessing.name}</strong>{blessing.effect === 'freeEquipmentCrafting' ? <><p>普通 {blessing.rarity} 装备制作免费</p><span>{blessing.rarity} 专武按原规则计价；强化与养成按实际配置计算</span></> : blessing.effect === 'freeExclusiveFragmentBaseline' ? <><p>每把专武紫水晶制作免费至 {blessing.rarity} Lv.{blessing.level}</p><span>更高等级只收基础以上差额</span></> : blessing.effect === 'resourceDiamondAllowance' ? <><p>{DIAMOND_RESOURCE_NAMES[blessing.resource]}免费 {amount(blessing.amount)} 钻</p><span>独立材料预算 · 整队共享</span></> : baseAllowance > 0 ? <><p>额外免费 {amount(blessing.amount)} {resourceName}</p><span>基础免费 {amount(baseAllowance)} · 合计免费 {amount(getResourceAllowance(policy, blessing.resource))}</span></> : <><p>整队免费总额度 {amount(getResourceAllowance(policy, blessing.resource))} {resourceName}</p><span>超过总额度后按超额计价</span></>}</aside>;
}

export default function App({ catalog, policy, freeLibrary, nameAliases }) {
  const curseName = policy.baseline?.curse?.name ?? '诅咒·时之枷锁';
  const characterCopyPrice = policy.unitPrices?.characterCopy;
  const originalCharacterCopyPrice = policy.baseline?.curse?.characterCopyOriginalPrice;
  const characterCopySaving = Number.isFinite(originalCharacterCopyPrice) && Number.isFinite(characterCopyPrice) ? Math.max(0, originalCharacterCopyPrice - characterCopyPrice) : 0;
  const [restoredDraft] = useState(() => restoreDraft(catalog, policy, freeLibrary));
  const [team, setTeam] = useState(restoredDraft.team);
  const [selectedIndex, setSelectedIndex] = useState(() => team.members.findIndex(Boolean));
  const [search, setSearch] = useState('');
  const [element, setElement] = useState('all');
  const [activePage, setActivePage] = useState('team');
  const [headerCollapsed, setHeaderCollapsed] = useState(true);
  const [notice, setNotice] = useState(restoredDraft.notice);
  const [draftStatus, setDraftStatus] = useState('已保存在此浏览器');
  const [dropTarget, setDropTarget] = useState(null);
  const [rosterDropActive, setRosterDropActive] = useState(false);
  const [runeBatch, setRuneBatch] = useState(null);
  const [runeFillReport, setRuneFillReport] = useState(null);
  const importInput = useRef(null);
  const editorRef = useRef(null);
  const draftBackupDone = useRef(!restoredDraft.needsBackup);
  const dragPayload = useRef(null);
  const characters = useMemo(() => new Map(catalog.characters.map(character => [character.id, character])), [catalog]);
  const aliases = useMemo(() => new Map((nameAliases?.characters ?? []).map(item => [item.characterId, item.aliases.join(' ')])), [nameAliases]);
  const freeCharacters = useMemo(() => new Map((freeLibrary?.characters ?? []).map(item => [item.characterId, item])), [freeLibrary]);
  const selectedMember = team.members[selectedIndex];
  const selectedCharacter = selectedMember ? characters.get(selectedMember.characterId) : null;
  const arcanaRequiresLR = Boolean(selectedMember && getArcanaRequiredRarity(team, selectedMember.characterId, catalog));
  const presetOptions = selectedMember ? getEquipmentPresetOptions(selectedMember) : [];
  const memberCount = team.members.filter(Boolean).length;
  const arcanaState = useMemo(() => getArcanaState(team, catalog, policy, freeLibrary), [team, catalog, policy, freeLibrary]);
  const valuation = useMemo(() => {
    const validation = validateTeam(team, catalog, policy, { freeLibrary });
    if (!validation.valid) return { cost: null, errors: validation.errors };
    try { return { cost: calculateTeam(team, catalog, policy, freeLibrary), errors: [] }; }
    catch (error) { return { cost: null, errors: error.errors ?? [{ message: error.message }] }; }
  }, [team, catalog, policy, freeLibrary]);
  const teamStats = useMemo(() => team.members.map(member => getCharacterStatsResult(member, catalog, policy, arcanaState, valuation.errors)), [team, catalog, policy, arcanaState, valuation.errors]);
  const characterStats = teamStats[selectedIndex];
  const canExport = memberCount === 5 && valuation.errors.length === 0;
  const inventory = useMemo(() => fixedRuneInventory(team, catalog, policy, valuation.cost), [team, catalog, policy, valuation.cost]);
  const borrowableWeapons = useMemo(() => selectedMember ? getBorrowableWeapons(team, selectedIndex, catalog, freeLibrary) : [], [team, selectedMember, selectedIndex, catalog, freeLibrary]);
  const ownWeaponClaimed = selectedMember ? isWeaponOwnerClaimed(team, selectedIndex, selectedMember.characterId) : false;
  const filtered = catalog.characters.filter(character =>
    (character.baseRarity == null || character.baseRarity === 8)
    && (element === 'all' || character.element === element)
    && `${character.name} ${character.subtitle ?? ''} ${character.variant ?? ''} ${character.aliases?.join?.(' ') ?? ''} ${aliases.get(character.id) ?? ''} ${character.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  useEffect(() => { setRuneBatch(null); setRuneFillReport(null); }, [selectedIndex, activePage]);
  useEffect(() => {
    try {
      if (!draftBackupDone.current && restoredDraft.originalRaw) {
        const backupKey = `${DRAFT_KEY}:backup:${Date.now()}`;
        localStorage.setItem(backupKey, restoredDraft.originalRaw);
        draftBackupDone.current = true;
      }
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ schemaVersion: 1, catalogVersion: catalog.version, team: cloneTeam(team) }));
      setDraftStatus('已保存在此浏览器');
    } catch {
      setDraftStatus(draftBackupDone.current ? '浏览器无法保存草稿，请及时导出' : '原草稿无法备份，已暂停自动保存');
    }
  }, [team, catalog.version, restoredDraft]);
  function changeTeam(update, { keepRuneBatch = false } = {}) {
    if (!keepRuneBatch) { setRuneBatch(null); setRuneFillReport(null); }
    setNotice(null);
    setTeam(current => typeof update === 'function' ? update(current) : update);
  }
  function applyPlacement(result) {
    changeTeam(result.team);
    setSelectedIndex(result.selectedIndex);
  }
  function selectMember(index) {
    setSelectedIndex(index);
  }
  function purchaseArcana(id, purchased) {
    try {
      changeTeam(setArcanaPurchased(team, id, purchased, catalog, policy, freeLibrary));
      setNotice({ kind: 'success', text: purchased ? '已获得关联角色的 LR 持有资格，配队与秘仪费用已合并更新。' : '已取消秘仪购买，已配置队员的稀有度保留，费用已按当前持有重新计算。' });
    } catch (error) { setNotice({ kind: 'error', text: error.message }); }
  }
  function startDrag(event, payload) {
    dragPayload.current = payload;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(TEAM_DRAG_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', '配队角色');
  }
  function endDrag() { dragPayload.current = null; setDropTarget(null); setRosterDropActive(false); }
  function dropMember(event, index) {
    event.preventDefault();
    event.stopPropagation();
    let payload;
    try { payload = JSON.parse(event.dataTransfer.getData(TEAM_DRAG_TYPE)); } catch { payload = dragPayload.current; }
    endDrag();
    if (payload?.kind === 'member' && team.members[payload.index]?.characterId === payload.characterId) applyPlacement(swapTeamPositions(team, payload.index, index, selectedIndex));
    else if (payload?.kind === 'character' && characters.has(payload.characterId)) applyPlacement(placeRosterCharacter(team, characters.get(payload.characterId), index, { catalog, freeLibrary }));
  }
  function dropToRoster(event) {
    if (dragPayload.current?.kind !== 'member') return;
    event.preventDefault();
    event.stopPropagation();
    let payload;
    try { payload = JSON.parse(event.dataTransfer.getData(TEAM_DRAG_TYPE)); } catch { payload = dragPayload.current; }
    endDrag();
    if (payload?.kind === 'member' && team.members[payload.index]?.characterId === payload.characterId) removeMember(payload.index);
  }
  function updateMember(update) {
    changeTeam(current => ({ ...current,
      members: current.members.map((member, index) => index === selectedIndex ? { ...member, ...update } : member),
    }));
  }
  function chooseMemberRarity(rarity) {
    try { updateMember(changeMemberRarity(selectedMember, rarity, catalog)); }
    catch (error) { setNotice({ kind: 'error', text: error.message }); }
  }
  function updateEquipment(index, equipment) {
    changeTeam(current => ({ ...current, members: current.members.map((member, i) => i === selectedIndex ? { ...member, equipment: member.equipment.map((gear, j) => j === index ? equipment : gear) } : member) }));
  }
  function updateRune(slot, runeIndex, nextRune, kind) {
    try {
      const result = updateColumnRune(team, selectedIndex, slot, runeIndex, nextRune, catalog, policy, { batch: runeBatch, kind });
      setRuneBatch(result.batch);
      setRuneFillReport(result.fillReport ? { ...result.fillReport, memberIndex: selectedIndex } : null);
      changeTeam(result.team, { keepRuneBatch: true });
    } catch (error) { setNotice({ kind: 'error', text: error.message }); }
  }
  function finishRuneBatch(slot, runeIndex) {
    if (runeBatch?.memberIndex === selectedIndex && runeBatch.slot === slot && runeBatch.runeIndex === runeIndex) setRuneBatch(null);
  }
  function chooseEquipmentPreset(presetId) {
    try {
      const member = applyEquipmentPreset(selectedMember, presetId, catalog, policy);
      changeTeam(current => ({ ...current, members: current.members.map((currentMember, index) => index === selectedIndex ? member : currentMember) }));
    } catch (error) { setNotice({ kind: 'error', text: error.message }); }
  }
  function removeMember(index) {
    changeTeam(current => ({ ...current, members: current.members.map((member, i) => i === index ? null : member) }));
    if (selectedIndex === index) setSelectedIndex(team.members.findIndex((member, i) => member && i !== index));
  }
  function exportTeam() {
    try {
      const exported = createExport(team, catalog, policy, freeLibrary);
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(team.name.trim() || '我的配队').replace(/[\\/:*?"<>|]/g, '_')}.mmtm-team.json`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice({ kind: 'success', text: '配队文件已下载。将 JSON 文件发送给站主，即可按此方案构建。' });
    } catch (error) { setNotice({ kind: 'error', text: error.message }); }
  }
  async function importTeam(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('配队文件超过 1 MB，请选择本站导出的 JSON 文件。');
      const imported = parseImport(await file.text(), catalog, policy, freeLibrary);
      changeTeam(imported.team); setSelectedIndex(imported.team.members.findIndex(Boolean));
      setNotice({ kind: 'success', text: `配队已导入。${imported.warnings.join(' ')}` });
    } catch (error) { setNotice({ kind: 'error', text: `导入失败：${error.message}` }); }
  }
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark" aria-hidden="true">M</span><div><div className="brand-title">配队工坊</div><div className="brand-subtitle">MEMENTO MORI · TEAM BUILDER</div></div></div>
      <div className="topbar-right"><span className="local-note"><span className="status-dot" />{draftStatus}</span><button className="button" onClick={() => importInput.current?.click()}><Icon name="upload" size={14} />导入方案</button><button className="button primary" disabled={!canExport} onClick={exportTeam}><Icon name="download" size={14} />导出方案</button></div>
      <input ref={importInput} type="file" accept="application/json,.json" aria-label="导入配队 JSON 文件" onChange={importTeam} />
    </header>
    <div className="intro"><div><div className="eyebrow">BUILD YOUR OWN STORY</div><h1>身为剑所天成<span className="intro-heading-suffix">· 简易杯初筛</span></h1><p>挑选角色，调整装备，掌握资源预算。完成后导出你的专属方案。</p></div><div className="intro-mechanisms"><aside className="intro-note curse-note" aria-label="诅咒机制"><strong>{curseName}</strong><p>等级固定为{policy.characterLevel}级</p><p className="curse-character-price">每个角色本体 {characterCopySaving > 0 && <>{amount(originalCharacterCopyPrice)} → </>}{amount(characterCopyPrice)} 钻</p>{characterCopySaving > 0 && <span className="curse-character-saving">受诅咒影响，每个本体减少 {amount(characterCopySaving)} 钻</span>}<span>秘仪加成随角色实际持有汇总</span></aside>{(policy.blessings ?? []).map(blessing => <BlessingCard blessing={blessing} policy={policy} key={blessing.id} />)}</div></div>
    {notice && <div className={`notice ${notice.kind}`} role="status" style={{ marginBottom: 16 }}>{notice.text}</div>}
    <main className="workspace">
      <aside className="panel catalog-panel left-column" aria-label="选择角色">
        <div className="panel-header"><div className="panel-heading"><span className="section-index">01</span><h2>选择角色</h2></div><span className="count">{filtered.length} 位</span></div>
      <div className={`catalog-roster${rosterDropActive ? ' remove-drop-target' : ''}`} role="region" aria-label="角色目录"
        onDragOver={event => { if (dragPayload.current?.kind !== 'member') return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setRosterDropActive(true); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setRosterDropActive(false); }} onDrop={dropToRoster}>
        <div className="search"><Icon name="search" size={14} /><input aria-label="搜索角色" placeholder="搜索角色名称" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div className="filter-row" role="group" aria-label="元素筛选"><button className={`filter-button${element === 'all' ? ' active' : ''}`} aria-pressed={element === 'all'} onClick={() => setElement('all')}>全部</button>{Object.entries(ELEMENTS).map(([key, item]) => <button key={key} className={`filter-button${element === key ? ' active' : ''}`} aria-pressed={element === key} onClick={() => setElement(key)}>{item.name}</button>)}</div>
        <div className="catalog-grid" role="list" aria-label="可拖入配队的角色">{filtered.map(character => {
          const inTeam = team.members.some(member => member?.characterId === character.id);
          const entitlement = freeCharacters.get(character.id);
          return <div className={`character-tile${inTeam ? ' in-team' : ''}`} role="listitem" key={character.id} title={`${characterLabel(character)} · 拖到站位${inTeam ? '调整位置' : '加入或替换'}${entitlement ? ` · 免费库 ${entitlement.rarity}` : ''}`} aria-label={`拖入${characterLabel(character)}`} draggable onDragStart={event => startDrag(event, { kind: 'character', characterId: character.id })} onDragEnd={endDrag}>
            <div style={{ position: 'relative' }}><Portrait character={character} elementIcons={catalog.elementIcons} jobIcons={catalog.jobIcons} iconArt={catalog.iconArt} rarity="SR" />{inTeam && <span className="selected-check"><Icon name="check" size={10} /></span>}</div><span className="tile-name">{character.name}</span><span className="tile-subtitle" aria-hidden={!character.subtitle}>{character.subtitle || '\u00a0'}</span><span className="tile-free-cap" aria-hidden={!entitlement}>{entitlement ? `${entitlement.rarity} 免费` : '\u00a0'}</span>
          </div>;
        })}{filtered.length === 0 && <p className="no-results">没有找到符合条件的角色</p>}</div>
        <p className="catalog-help">拖动目录角色到站位加入或替换。<br />将队员拖回此目录可移出配队。</p>
      </div>
        <section className="plan-panel" aria-label="方案信息"><div className="panel-header"><h2>为方案留下一些说明</h2><span className="count">自动保存草稿</span></div><div className="plan-fields"><Field label="配队名称" path="name" errors={valuation.errors}><input aria-label="配队名称" maxLength={120} value={team.name} onChange={event => changeTeam(current => ({ ...current, name: event.target.value }))} /></Field><Field label="作者 / 昵称（可选）" path="author" errors={valuation.errors}><input aria-label="作者昵称" maxLength={120} placeholder="你的昵称" value={team.author} onChange={event => changeTeam(current => ({ ...current, author: event.target.value }))} /></Field><Field label="备注（可选）" path="notes" errors={valuation.errors} full><textarea aria-label="方案备注" rows={3} maxLength={4000} placeholder="例如：配队思路、主力角色或希望测试的对手……" value={team.notes} onChange={event => changeTeam(current => ({ ...current, notes: event.target.value }))} /></Field></div></section>
      </aside>
      <div className="center-column">
        <section className="panel details-panel" ref={editorRef} aria-label="当前角色装备配置">
          <div className="workbench-heading">
            <div className="panel-heading gear-panel-heading"><span className="section-index">02</span><h2>角色与装备</h2></div>
            <div className="panel-header"><div className="panel-heading"><h3>我的配队 <span className="count">{memberCount} / 5</span></h3></div><div className="team-header-controls"><button className="quiet-button reset-button" onClick={() => { changeTeam({ ...createTeam(), level: policy.characterLevel }); setSelectedIndex(-1); }}>新建方案</button></div></div>
          </div>
          <div className="workbench-sticky">
          <div className="character-workbench-header">
            <div className="character-overview"><div className="selected-character-header">{selectedMember && selectedCharacter ? (
              <div className="selected-character-identity"><Portrait character={selectedCharacter} elementIcons={catalog.elementIcons} jobIcons={catalog.jobIcons} iconArt={catalog.iconArt} rarity={selectedMember.rarity} /><div><h2>{selectedCharacter.name}</h2>{selectedCharacter.subtitle && <p className="selected-subtitle">{selectedCharacter.subtitle}</p>}<p className="character-meta">{ELEMENTS[selectedCharacter.element]?.name}属性 · 第 {selectedIndex + 1} 位 · Lv.{policy.characterLevel}</p></div></div>
            ) : <div className="character-overview-empty"><Icon name="gear" size={20} /><p>将角色拖入队伍位置<br />即可编辑装备</p></div>}
              <div className="character-overview-controls">
                {selectedMember && selectedCharacter && <label className="rarity-control"><span className="field-label">角色稀有度</span><select aria-label="角色稀有度" value={selectedMember.rarity} onChange={event => chooseMemberRarity(event.target.value)}><option value="SR" disabled={arcanaRequiresLR}>SR</option><option value="LR">LR</option><option value="LR5">LR5</option></select>{arcanaRequiresLR && <span className="arcana-rarity-note">已购秘仪至少需 LR</span>}</label>}
                <button type="button" className="quiet-button workbench-toggle" aria-expanded={!headerCollapsed} aria-controls="team-equipment-overview" onClick={() => setHeaderCollapsed(value => !value)}>{headerCollapsed ? '展开概览' : '折叠概览'}</button>
              </div>
            </div></div>
        <section className="team-panel" aria-label="当前五人配队">
          <div className="team-lineup" style={catalog.teamFrame ? { '--team-frame-image': `url("${catalog.teamFrame}")` } : undefined}><div className="team-slots">{team.members.map((member, index) => {
            const character = member ? characters.get(member.characterId) : null;
            return <div className="team-position" key={index}><div className={`team-slot${member ? '' : ' empty'}${member && index === selectedIndex ? ' selected' : ''}${dropTarget === index ? ' drop-target' : ''}`} style={{ backgroundImage: `url("${teamSeat}")` }} draggable={Boolean(member)}
              onDragStart={event => member && startDrag(event, { kind: 'member', index, characterId: member.characterId })} onDragEnd={endDrag}
              onDragOver={event => { if (!event.dataTransfer.types.includes(TEAM_DRAG_TYPE)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(index); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(current => current === index ? null : current); }} onDrop={event => dropMember(event, index)}>
              <span className="slot-position">0{index + 1}</span>
              {member ? <button className="member-select" title={characterLabel(character)} aria-label={`配置${characterLabel(character)}，位置${index + 1}`} aria-pressed={index === selectedIndex} onClick={() => selectMember(index)}><Portrait character={character} elementIcons={catalog.elementIcons} jobIcons={catalog.jobIcons} iconArt={catalog.iconArt} rarity={member.rarity} /><span className="member-speed" title="当前构筑速度，不含战斗技能增益">速度 {teamStats[index]?.valid ? teamStats[index].rows.find(row => row.key === 'Speed')?.displayValue ?? '—' : '—'}</span></button> : <div className="empty-slot-content"><div className="empty-slot-plus">＋</div></div>}
            </div></div>;
          })}</div></div>
        </section>
          </div>
          </div>
          <div id="team-equipment-overview" className="team-equipment-overview" hidden={headerCollapsed}>
            <span className="team-equipment-caption">装备与魔装概览</span>
            <div className="team-equipment-grid">{team.members.map((member, index) => <div className="team-equipment-position" key={index}>{member && <MemberEquipmentSummary member={member} position={index + 1} catalog={catalog} />}</div>)}</div>
          </div>
          <p className="team-note">拖动调整站位，点击队员编辑装备。替换保留该位置的稀有度、装备与符石。</p>
          <nav className="workspace-tabs" role="tablist" aria-label="构筑页面"><button id="team-tab" role="tab" aria-selected={activePage === 'team'} aria-controls="team-page" onClick={() => setActivePage('team')}>装备 A</button><button id="equipment-b-tab" role="tab" aria-selected={activePage === 'equipment-b'} aria-controls="equipment-b-page" onClick={() => setActivePage('equipment-b')}>装备 B</button><button id="arcana-tab" role="tab" aria-selected={activePage === 'arcana'} aria-controls="arcana-page" onClick={() => setActivePage('arcana')}>秘仪 · LR 档</button><button id="stats-tab" role="tab" aria-selected={activePage === 'stats'} aria-controls="stats-page" onClick={() => setActivePage('stats')}>角色属性</button></nav>
          {activePage === 'arcana' ? <ArcanaEditor state={arcanaState} catalog={catalog} onPurchase={purchaseArcana} /> : activePage === 'stats' ? <CharacterStatsPanel result={characterStats} policy={policy} /> : <div id={activePage === 'equipment-b' ? 'equipment-b-page' : 'team-page'} role="tabpanel" aria-labelledby={activePage === 'equipment-b' ? 'equipment-b-tab' : 'team-tab'}>
          {selectedMember && selectedCharacter ? <>
            {valuation.errors.length > 0 && <div className="notice error validation-notice" role="alert"><strong>当前配置需要修正</strong><ul>{valuation.errors.slice(0, 6).map((issue, i) => <li key={`${issue.path}-${i}`}>{issue.message}</li>)}</ul>{valuation.errors.length > 6 && <p>另有 {valuation.errors.length - 6} 项，请逐项检查。</p>}</div>}
            <div className="equip-intro"><span>{activePage === 'equipment-b' ? '装备 B · 打磨与符石' : '装备 A · 等级与圣魔装'}</span><span>未装备部位不消耗材料</span></div>
            {activePage === 'team' && <>
            <div className="equipment-presets" role="group" aria-label="快捷装备方案">{presetOptions.map(preset => <button className="button" key={preset.id} disabled={preset.requiresLR5 && selectedMember.rarity !== 'LR5'} title={`${preset.composition}${preset.requiresLR5 && selectedMember.rarity !== 'LR5' ? ' · 需要 LR5 角色' : ''}`} onClick={() => chooseEquipmentPreset(preset.id)}>{preset.label}</button>)}</div>
            <p className="equipment-preset-note">强化：武器／手套／脚 {policy.characterLevel}，头盔／衣服 240，项链 60。高阶项链、头盔和衣服按 240 档制作；圣魔装与符石保留，四件套随角色自动选 4UR／4LR。</p>
            <p className="equipment-default-note">新装备默认魔装 40，可按实际配置调整。</p>
            {(freeCharacters.has(selectedCharacter.id) || freeLibrary?.exclusiveWeapons?.some(item => item.characterId === selectedCharacter.id)) && <p className="free-library-note">免费库：{freeCharacters.has(selectedCharacter.id) ? `角色本体免费至 ${freeCharacters.get(selectedCharacter.id).rarity}` : ''}{freeLibrary?.exclusiveWeapons?.filter(item => item.characterId === selectedCharacter.id).map(item => `${freeCharacters.has(selectedCharacter.id) ? '；' : ''}${item.level} 级 ${item.rarity} ${catalog.characters.find(character => character.id === item.characterId)?.exclusiveWeaponName ?? '专武'}免费`).join('')}。更高配置按差额计价。</p>}
            </>}
            {activePage === 'equipment-b' && policy.runes?.fixedStock && <p className="fixed-stock-note">普通符石：每类 {fixedRuneCaption(policy)}，整队共享。穿透与速度可自由调整等级。</p>}
            <div className="equip-grid">{EQUIPMENT_SLOTS.map((slot, index) => <EquipmentEditor key={`${selectedMember.characterId}-${slot}`} part={activePage === 'equipment-b' ? 'B' : 'A'} gear={selectedMember.equipment[index]} index={index} member={selectedMember} memberIndex={selectedIndex} catalog={catalog} policy={policy} freeLibrary={freeLibrary} errors={valuation.errors} inventory={inventory} borrowableWeapons={borrowableWeapons} ownWeaponClaimed={ownWeaponClaimed} onChange={gear => updateEquipment(index, gear)} onRuneChange={(runeIndex, nextRune, kind) => updateRune(slot, runeIndex, nextRune, kind)} onRuneCommit={runeIndex => finishRuneBatch(slot, runeIndex)} batchSourceRuneIndex={runeBatch?.memberIndex === selectedIndex && runeBatch.slot === slot ? runeBatch.runeIndex : null} runeFillReport={runeFillReport?.memberIndex === selectedIndex && runeFillReport.slot === slot ? runeFillReport : null} />)}</div>
          </> : <div className="empty-detail"><div className="empty-detail-mark"><Icon name="gear" size={23} /></div><h2>从一名角色开始</h2><p>将角色头像拖入队伍位置，设定稀有度与六部位装备。<br />受「{curseName}」影响，全队等级固定为{policy.characterLevel}级。</p></div>}
          </div>}
        </section>
      </div>
      <CostSummary cost={valuation.cost} errors={valuation.errors} policy={policy} catalog={catalog} memberCount={memberCount} inventory={inventory} arcanaState={arcanaState} canExport={canExport} onExport={exportTeam} />
    </main>
    <footer className="footer"><span>配队与草稿保存在你的浏览器中 · 不自动上传 · {draftStatus}</span><span>资源价值参考 <a href="https://hitazuki.github.io/mementomori-calculator/#packCompare" target="_blank" rel="noopener noreferrer">MementoMori Calculator</a> · 最终按站主规则复核</span></footer>
  </div>;
}
