import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  createTeam, createMember, createEquipment, calculateTeam, validateTeam,
  createExport, parseImport, cloneTeam, deriveWeaponSync, getBorrowableWeapons, isWeaponOwnerClaimed, EQUIPMENT_SLOTS, RESOURCE_KEYS,
} from './domain.mjs';
import { addRosterCharacter, equipReserveWeapon, placeRosterCharacter, rosterDoubleClick, swapTeamPositions } from './team-interactions.mjs';

const DRAFT_KEY = 'mementomori-team-builder:draft:v1';
const ELEMENTS = {
  blue: { name: '蓝', color: '#6595b6', symbol: '水' },
  red: { name: '红', color: '#b97470', symbol: '火' },
  green: { name: '绿', color: '#729782', symbol: '风' },
  yellow: { name: '黄', color: '#ba9d57', symbol: '土' },
  light: { name: '光', color: '#b9ac7f', symbol: '光' },
  dark: { name: '暗', color: '#88829d', symbol: '暗' },
};
const SLOT_NAMES = { 1: '武器', 2: '饰品', 3: '护手', 4: '头盔', 5: '铠甲', 6: '鞋子' };
const RESOURCE_NAMES = {
  runeTickets: '饼干 · 符石兑换券', reinforcementMedicine: '红水 · 强化秘药',
  unidentifiedRune7: '7 级未鉴定符石', holySteel: '圣装经验等价',
  ssrFragments: 'SSR 装备碎片（禁忌）', forbiddenFragments: '禁忌武具碎片',
  urLrFragments: 'UR / LR 圣遗物碎片', exclusiveFragments: '专属武器碎片',
  lifeTreeDew: '叶子 · 生命树之露',
};
const RARITY_SERIES = { SSR: 12, UR: 13, LR: 14 };
const characterLabel = character => character?.subtitle ? `${character.name} · ${character.subtitle}` : character?.name ?? '';
const FORMATTER = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const amount = value => Number.isFinite(value) ? FORMATTER.format(value) : '—';
const numeric = value => value === '' ? '' : Number(value);
const runeSlots = category => category.slots ?? category.allowedSlots ?? category.equipmentSlots ?? [];
const fixedRuneTiers = policy => policy.runes?.fixedStock?.tiers ?? (policy.runes?.fixedStock ? [{ level: policy.runes.fixedStock.level, perCategory: policy.runes.fixedStock.perCategory }] : []);
const fixedRuneCaption = policy => fixedRuneTiers(policy).map(tier => `Lv.${tier.level} × ${tier.perCategory}`).join('、');
const TEAM_DRAG_TYPE = 'application/x-mementomori-team';

function restoreDraft(catalog, policy) {
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
    let repaired = previous.members.length !== 5 || previous.level !== policy.characterLevel;
    const readableNumber = (value, fallback) => typeof value === 'number' || value === '' ? value : fallback;
    const recovered = {
      ...empty,
      name: typeof previous.name === 'string' ? previous.name : empty.name,
      author: typeof previous.author === 'string' ? previous.author : '',
      notes: typeof previous.notes === 'string' ? previous.notes : '',
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
          if (saved.rarity === 'NONE') return emptyGear;
          if (!Array.isArray(saved.runes) || saved.runes.length !== 4) repaired = true;
          return {
            ...emptyGear, rarity: saved.rarity, seriesId: saved.seriesId ?? RARITY_SERIES[saved.rarity],
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
    for (const source of recovered.weaponSources) {
      const actor = recovered.members.find(member => member?.characterId === source.characterId);
      if (actor && source.characterRarity !== actor.rarity) { source.characterRarity = actor.rarity; repaired = true; }
    }
    const versionChanged = stored.catalogVersion !== catalog.version;
    const needsBackup = repaired || versionChanged || JSON.stringify(cloneTeam(recovered)) !== JSON.stringify(previous);
    const notice = needsBackup ? {
      kind: 'info',
      text: versionChanged
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

function Portrait({ character, badge = true }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [character?.id, character?.portrait]);
  const element = ELEMENTS[character?.element];
  return <div className="portrait-frame">
    {character?.portrait && !failed
      ? <img src={character.portrait} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
      : <span className="portrait-fallback" aria-hidden="true">{character?.name?.slice(0, 1) ?? '✧'}</span>}
    {badge && element && <span className="element-badge" style={{ '--element-color': element.color }} title={`${element.name}属性`}>{element.symbol}</span>}
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

function equipmentLevels(catalog, rarity, weaponKind) {
  if (rarity === 'NONE') return [];
  const tableKey = weaponKind === 'exclusive' ? `exclusive${rarity}` : rarity;
  const table = catalog.equipmentCosts?.fragments?.[tableKey];
  if (table) return Object.keys(table).map(Number).filter(Number.isSafeInteger).sort((a, b) => a - b);
  return catalog.equipmentCosts?.allowedLevels?.[rarity] ?? [];
}

function EquipmentEditor({ gear, index, member, catalog, policy, freeLibrary, onChange, errors, memberIndex, inventory, weaponSync, syncOptions, borrowableWeapons, ownWeaponClaimed }) {
  const prefix = `members[${memberIndex}].equipment[${index}]`;
  const availableRunes = catalog.runeCategories.filter(category => runeSlots(category).includes(gear.slot));
  const levels = equipmentLevels(catalog, gear.rarity, gear.weaponKind).filter(level => level <= policy.characterLevel);
  const series = (catalog.equipmentSeries ?? catalog.series ?? []).find(item => item.id === gear.seriesId);
  const maximumSacred = catalog.limits?.sacredTreasureLevel ?? policy.limits?.sacredTreasureLevel ?? 40;
  const maximumRune = catalog.limits?.runeLevel ?? policy.limits?.runeLevel ?? 15;
  const fixedStock = policy.runes?.fixedStock;
  const stockTiers = fixedRuneTiers(policy);
  const isFixedCategory = categoryId => fixedStock && !fixedStock.excludedCategoryIds.includes(categoryId);
  const syncSlot = gear.syncSlot ?? 0;
  const syncEligible = gear.slot === 1 && gear.weaponKind === 'exclusive' && ['UR', 'LR'].includes(gear.rarity) && gear.level >= 300;
  const effectiveLevel = gear.slot === 1 ? weaponSync?.effectiveLevels?.[memberIndex] ?? gear.level : gear.level;
  const reinforcementMaximum = Math.max(gear.level, effectiveLevel);
  const ownerId = gear.weaponOwnerCharacterId ?? member.characterId;
  const ownerCharacter = catalog.characters.find(character => character.id === ownerId);
  const actor = catalog.characters.find(character => character.id === member.characterId);
  const borrowed = ownerId !== member.characterId;
  const compatibleOwners = (freeLibrary?.exclusiveWeapons ?? []).filter(weapon => weapon.rarity === 'UR' && weapon.characterId !== member.characterId && catalog.characters.find(character => character.id === weapon.characterId)?.job === actor?.job);
  function updateGearLevel(level) {
    const nextSyncSlot = level < 300 ? 0 : syncSlot;
    const syncedLevel = nextSyncSlot > 0 ? weaponSync?.slots.find(slot => slot.slot === nextSyncSlot)?.effectiveLevel ?? level : level;
    onChange({ ...gear, level, syncSlot: nextSyncSlot, reinforcementLevel: Math.min(Number(gear.reinforcementLevel) || 0, Math.max(level, syncedLevel)) });
  }
  function selectRarity(rarity) {
    if (rarity === 'NONE') { onChange(createEquipment(gear.slot)); return; }
    const updated = {
      ...gear, rarity, seriesId: RARITY_SERIES[rarity], weaponKind: gear.slot === 1 ? 'exclusive' : gear.weaponKind,
      weaponOwnerCharacterId: gear.slot === 1 ? rarity === 'SSR' ? member.characterId : ownerId : null,
      runes: gear.runes.map((rune, index) => rune.level === 0
        ? { ...rune, categoryId: availableRunes[index]?.id ?? availableRunes[0]?.id ?? rune.categoryId }
        : rune),
    };
    const allowed = equipmentLevels(catalog, rarity, updated.weaponKind).filter(level => level <= policy.characterLevel);
    if (!allowed.includes(updated.level)) updated.level = gear.slot === 1 && gear.rarity === 'NONE' ? allowed[0] ?? 180 : allowed.at(-1) ?? policy.characterLevel;
    if (!['UR', 'LR'].includes(rarity) || updated.level < 300 || updated.weaponKind !== 'exclusive') updated.syncSlot = 0;
    if (Number.isFinite(updated.reinforcementLevel)) updated.reinforcementLevel = Math.min(updated.reinforcementLevel, updated.syncSlot ? Math.max(updated.level, effectiveLevel) : updated.level);
    onChange(updated);
  }
  function setWeaponKind(weaponKind) {
    const updated = { ...gear, weaponKind, weaponOwnerCharacterId: weaponKind === 'normal' ? member.characterId : ownerId };
    const allowed = equipmentLevels(catalog, gear.rarity, weaponKind).filter(level => level <= policy.characterLevel);
    if (!allowed.includes(updated.level)) updated.level = allowed.at(-1) ?? policy.characterLevel;
    if (weaponKind !== 'exclusive' || updated.level < 300) updated.syncSlot = 0;
    if (Number.isFinite(updated.reinforcementLevel)) updated.reinforcementLevel = Math.min(updated.reinforcementLevel, updated.syncSlot ? Math.max(updated.level, effectiveLevel) : updated.level);
    onChange(updated);
  }
  function chooseWeaponOwner(nextOwnerId) {
    const gift = freeLibrary?.exclusiveWeapons.find(weapon => weapon.characterId === nextOwnerId);
    const rarity = gift?.rarity ?? 'SSR';
    const level = gift?.level ?? 180;
    onChange({ ...gear, weaponKind: 'exclusive', weaponOwnerCharacterId: nextOwnerId, rarity, seriesId: RARITY_SERIES[rarity], level, syncSlot: 0, reinforcementLevel: Math.min(Number(gear.reinforcementLevel) || 0, level) });
  }
  function setRune(runeIndex, updates) {
    onChange({ ...gear, runes: gear.runes.map((rune, i) => i === runeIndex ? { ...rune, ...updates } : rune) });
  }
  return <section className={`equipment-card${gear.rarity === 'NONE' ? ' empty-equipment' : ''}`} aria-label={SLOT_NAMES[gear.slot]}>
    <div className="equipment-card-header">
      <h3 className="equipment-name"><Icon name={gear.slot <= 3 ? 'sword' : 'shield'} size={15} />{SLOT_NAMES[gear.slot]}</h3>
      <select className="equipment-rarity" aria-label={`${SLOT_NAMES[gear.slot]}稀有度`} value={gear.rarity} onChange={event => selectRarity(event.target.value)}>
        <option value="NONE">未装备</option><option value="SSR">SSR</option><option value="UR">UR</option>
        <option value="LR" disabled={member.rarity !== 'LR5'}>LR{member.rarity !== 'LR5' ? ' · 需 LR5' : ''}</option>
      </select>
    </div>
    {gear.rarity === 'NONE' ? <p className="empty-equipment-note">选择装备后设置养成与符石</p> : <>
      <div className="fixed-series">{gear.weaponKind === 'exclusive' ? `${borrowed ? '借用 ' : ''}${ownerCharacter?.name ?? '角色'}专属武器` : series?.name ?? gear.rarity}{gear.rarity === 'LR' ? ' · 需 LR5 角色' : ''}</div>
      {gear.slot === 1 && gear.weaponKind === 'normal' && ['UR', 'LR'].includes(gear.rarity) && <p className="input-error">UR / LR 武器需使用专武。<button className="rune-repair" onClick={() => setWeaponKind('exclusive')}>改为专属武器</button></p>}
      <div className="equipment-fields">
        {gear.slot === 1 && gear.weaponKind === 'exclusive' && <Field label="专武来源" path={`${prefix}.weaponOwnerCharacterId`} errors={errors} full>
          <select aria-label="专武所属角色" value={ownerId} onChange={event => chooseWeaponOwner(Number(event.target.value))}>
            <option value={member.characterId} disabled={ownWeaponClaimed && ownerId !== member.characterId}>自己的专武{ownWeaponClaimed ? ' · 已使用' : ''}</option>
            {borrowed && !compatibleOwners.some(weapon => weapon.characterId === ownerId) && <option value={ownerId}>{ownerCharacter?.name} · 不可借用</option>}
            {compatibleOwners.map(weapon => <option key={weapon.characterId} value={weapon.characterId} disabled={ownerId !== weapon.characterId && !borrowableWeapons.some(item => item.characterId === weapon.characterId)}>{catalog.characters.find(character => character.id === weapon.characterId)?.name} · 免费 UR Lv.{weapon.level}{!borrowableWeapons.some(item => item.characterId === weapon.characterId) && ownerId !== weapon.characterId ? ' · 已使用' : ''}</option>)}
          </select>
          {borrowed && <span className="borrowed-weapon-note">同职业借用 · 此武器不提供当前角色的专武技能，每把免费专武仅能装备给一人。</span>}
        </Field>}
        {gear.slot === 1 && gear.rarity === 'SSR' && <Field label="武器类型" path={`${prefix}.weaponKind`} errors={errors} full>
          <select aria-label="武器类型" value={gear.weaponKind} onChange={event => setWeaponKind(event.target.value)}><option value="exclusive">专属武器</option><option value="normal">SSR 通用武器</option></select>
        </Field>}
        <Field label={gear.slot === 1 && syncSlot > 0 ? '武器基础等级' : '装备等级'} path={`${prefix}.level`} errors={errors}>
          <select aria-label={`${SLOT_NAMES[gear.slot]}装备等级`} value={gear.level} onChange={event => updateGearLevel(Number(event.target.value))}>
            {!levels.includes(gear.level) && <option value={gear.level}>{gear.level} · 不可用</option>}
            {levels.map(level => <option key={level} value={level}>Lv. {level}</option>)}
          </select>
        </Field>
        <Field label="强化等级" path={`${prefix}.reinforcementLevel`} errors={errors}>
          <input aria-label={`${SLOT_NAMES[gear.slot]}强化等级`} type="number" min="0" max={reinforcementMaximum} step="1" value={gear.reinforcementLevel} onChange={event => onChange({ ...gear, reinforcementLevel: numeric(event.target.value) })} />
        </Field>
        <Field label="圣装等级" path={`${prefix}.legendSacredTreasureLevel`} errors={errors}>
          <input aria-label={`${SLOT_NAMES[gear.slot]}圣装等级`} type="number" min="0" max={maximumSacred} step="1" value={gear.legendSacredTreasureLevel} onChange={event => onChange({ ...gear, legendSacredTreasureLevel: numeric(event.target.value) })} />
        </Field>
        <Field label="魔装等级" path={`${prefix}.matchlessSacredTreasureLevel`} errors={errors}>
          <input aria-label={`${SLOT_NAMES[gear.slot]}魔装等级`} type="number" min="0" max={maximumSacred} step="1" value={gear.matchlessSacredTreasureLevel} onChange={event => onChange({ ...gear, matchlessSacredTreasureLevel: numeric(event.target.value) })} />
        </Field>
        {gear.slot === 1 && gear.weaponKind === 'exclusive' && <Field label="武器同步" path={`${prefix}.syncSlot`} errors={errors} full>
          <select aria-label="武器同步位" value={syncSlot} onChange={event => {
            const next = Number(event.target.value);
            onChange({ ...gear, syncSlot: next, reinforcementLevel: next === 0 ? Math.min(Number(gear.reinforcementLevel) || 0, gear.level) : gear.reinforcementLevel });
          }}>
            <option value="0">不使用同步</option>
            {(syncOptions ?? weaponSync?.slots ?? []).map(slot => {
              const occupiedElsewhere = slot.usedBy.some(position => position !== memberIndex + 1);
              const disabled = !syncEligible || !slot.available || occupiedElsewhere || (slot.effectiveLevel ?? 0) < gear.level;
              return <option key={slot.slot} value={slot.slot} disabled={disabled && syncSlot !== slot.slot}>同步位 {slot.slot}{slot.available ? ` · Lv.${slot.effectiveLevel}` : ` · 需 ${slot.requiredAnchors} 把基准`}{occupiedElsewhere ? ' · 已使用' : ''}</option>;
            })}
          </select>
          <span className="weapon-sync-hint">{!syncEligible ? 'UR / LR 专武达到 300 级后可使用同步。' : syncSlot > 0 ? `同步后 Lv.${effectiveLevel}；基础等级以上不再消耗升级材料，强化仍按所选等级计费。` : '同步位沿用基准武器中的最低等级，每个位可同步一把专武。'}</span>
        </Field>}
      </div>
      <div className="rune-section">
        <div className="rune-heading"><span>符石孔</span><span>{gear.slot <= 3 ? '攻击类' : '防御类'} · 同类不可重复</span></div>
        <div className="rune-holes">{gear.runes.map((rune, runeIndex) => {
          const active = rune.level !== 0;
          const fixedLevel = active && isFixedCategory(rune.categoryId);
          const issue = errors.find(item => item.path.startsWith(`${prefix}.runes[${runeIndex}]`));
          return <div key={runeIndex}>
            <div className="rune-row">
              <span className="rune-number">{runeIndex + 1}</span>
              <select aria-label={`${SLOT_NAMES[gear.slot]}第${runeIndex + 1}孔符石类别`} value={active ? rune.categoryId : ''} onChange={event => {
                if (event.target.value === '') { setRune(runeIndex, { level: 0 }); return; }
                const categoryId = Number(event.target.value);
                const availableTier = stockTiers.find(tier => inventory.some(item => item.categoryId === categoryId && item.level === tier.level && item.remaining > 0));
                setRune(runeIndex, { categoryId, level: isFixedCategory(categoryId) ? availableTier?.level ?? stockTiers[0]?.level : rune.level > 0 ? rune.level : 1 });
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
              {fixedLevel
                ? <select aria-label={`${SLOT_NAMES[gear.slot]}第${runeIndex + 1}孔固定符石等级`} className="fixed-rune-level" value={rune.level} onChange={event => setRune(runeIndex, { level: Number(event.target.value) })}>
                  {!stockTiers.some(tier => tier.level === rune.level) && <option value={rune.level}>Lv.{rune.level} · 不可用</option>}
                  {stockTiers.map(tier => {
                    const stock = inventory.find(item => item.categoryId === rune.categoryId && item.level === tier.level);
                    return <option key={tier.level} value={tier.level} disabled={rune.level !== tier.level && stock?.remaining <= 0}>Lv.{tier.level}</option>;
                  })}
                </select>
                : <input aria-label={`${SLOT_NAMES[gear.slot]}第${runeIndex + 1}孔符石等级`} type="number" min="0" max={maximumRune} step="1" disabled={!active} value={active ? rune.level : ''} placeholder="—" onChange={event => setRune(runeIndex, { level: numeric(event.target.value) })} />}
            </div>
            {fixedLevel && !stockTiers.some(tier => tier.level === rune.level) && <button className="rune-repair" onClick={() => setRune(runeIndex, { level: stockTiers[0].level })}>调整为 Lv.{stockTiers[0].level}</button>}
            {issue && <p className="input-error" role="alert">{issue.message}</p>}
          </div>;
        })}</div>
      </div>
    </>}
  </section>;
}

function WeaponSyncEditor({ team, catalog, policy, freeLibrary, sync, errors, onChange, onEquipSource }) {
  const sources = team.weaponSources ?? [];
  const equippedOwners = new Set(team.members.flatMap(member => member?.equipment[0]?.weaponKind === 'exclusive' && member.equipment[0].rarity !== 'NONE' ? [member.equipment[0].weaponOwnerCharacterId ?? member.characterId] : []));
  const sourceIds = new Set(sources.map(source => source.characterId));
  const characters = new Map(catalog.characters.map(character => [character.id, character]));
  const selectable = catalog.characters.filter(character => !equippedOwners.has(character.id) && !sourceIds.has(character.id));
  const gifts = (freeLibrary?.exclusiveWeapons ?? []).filter(weapon => ['UR', 'LR'].includes(weapon.rarity) && weapon.level >= 300);
  const maximumSources = policy.weaponSync?.maximumSourceCount ?? 3;
  function addSource(characterId) {
    const gift = gifts.find(weapon => weapon.characterId === characterId);
    const freeCharacter = freeLibrary?.characters.find(character => character.characterId === characterId);
    const actor = team.members.find(member => member?.characterId === characterId);
    onChange([...sources, { characterId, characterRarity: actor?.rarity ?? freeCharacter?.rarity ?? 'SR', rarity: gift?.rarity ?? 'UR', level: gift?.level ?? 300 }]);
  }
  const changeSource = (index, update) => onChange(sources.map((source, i) => i === index ? { ...source, ...update } : source));
  return <section className="panel sync-panel" aria-label="武器同步配置">
    <div className="panel-header"><div className="panel-heading"><Icon name="sword" size={15} /><h2>武器同步</h2></div><span className="count">{sync.anchors.length} 把可用基准</span></div>
    <div className="sync-slots">{sync.slots.map(slot => <div className={`sync-slot-status${slot.available ? ' available' : ''}`} key={slot.slot}>
      <strong>同步位 {slot.slot}<span>{slot.available ? `Lv.${slot.effectiveLevel}` : '尚未满足'}</span></strong>
      <p>{slot.requiredAnchors} 把基准 · {slot.usedBy.length > 0 ? `第 ${slot.usedBy.join('、')} 位正在使用` : '可同步 1 把专武'}</p>
      <p>{slot.anchors.map(anchor => `${anchor.characterName} Lv.${anchor.level}`).join('、') || '提升基准武器后可开启'}</p>
    </div>)}</div>
    <p className="sync-rule-note">300 级以上 UR / LR 专武可作为基准。同一组基准可供两个同步位使用；同步后的武器不能再作基准。</p>
    {gifts.length > 0 && <div className="sync-free-anchors"><span>免费基准</span>{gifts.map(gift => <div key={gift.characterId}><span>{characterLabel(characters.get(gift.characterId))} · {gift.rarity} Lv.{gift.level}</span>{equippedOwners.has(gift.characterId) ? <small>在配队内调整</small> : sourceIds.has(gift.characterId) ? <small>已在下方调整</small> : <button className="quiet-button" disabled={sources.length >= maximumSources} onClick={() => addSource(gift.characterId)}>提升等级</button>}</div>)}</div>}
    <details className="sync-source-details" open={sources.length > 0 || errors.some(issue => issue.path?.startsWith('weaponSources'))}>
      <summary>配置同步基准 <span>{sources.length > 0 ? `${sources.length} 把队外武器` : '提升免费基准或补足第 3 把'}</span></summary>
      <p className="sync-rule-note">队外武器只用于同步；角色本体和专武差额计入预算。最多 {maximumSources} 把；配队内角色请直接调整自己的武器。同一角色使用当前配置的武器。</p>
      <label className="source-add"><span className="field-label">添加队外角色的基准武器</span><select aria-label="添加队外基准武器" disabled={sources.length >= maximumSources} value="" onChange={event => event.target.value && addSource(Number(event.target.value))}><option value="">{sources.length >= maximumSources ? '已达到队外基准数量上限' : '选择角色…'}</option>{selectable.map(character => <option key={character.id} value={character.id}>{characterLabel(character)}</option>)}</select></label>
      <div className="sync-source-list">{sources.map((source, index) => {
        const character = characters.get(source.characterId);
        const actor = team.members.find(member => member?.characterId === source.characterId);
        const levels = equipmentLevels(catalog, source.rarity, 'exclusive').filter(level => level >= 300 && level <= team.level);
        return <div className="sync-source-card" key={source.characterId}>
          <div className="sync-source-header"><span>{characterLabel(character)}</span><button className="icon-button danger" aria-label={`移除${characterLabel(character)}队外基准`} onClick={() => onChange(sources.filter((_, i) => i !== index))}><Icon name="close" size={13} /></button></div>
          {equippedOwners.has(source.characterId) && <div className="source-conflict"><p className="input-error">该专武已在队伍中使用。将此队外配置装备给队员，或移除队外记录后在队内调整。</p><button className="button gold" onClick={() => onEquipSource(index)}>将队外专武装备给队员</button></div>}
          <div className="sync-source-fields">
            <Field label={actor ? '跟随队内角色' : '角色稀有度'} path={`weaponSources[${index}].characterRarity`} errors={errors}><select aria-label={`${characterLabel(character)}基准角色稀有度`} disabled={Boolean(actor)} value={actor?.rarity ?? source.characterRarity} onChange={event => changeSource(index, { characterRarity: event.target.value })}><option value="SR">SR</option><option value="LR">LR</option><option value="LR5">LR5</option></select></Field>
            <Field label="专武稀有度" path={`weaponSources[${index}].rarity`} errors={errors}><select aria-label={`${characterLabel(character)}基准专武稀有度`} value={source.rarity} onChange={event => {
              const rarity = event.target.value;
              const allowed = equipmentLevels(catalog, rarity, 'exclusive').filter(level => level >= 300 && level <= team.level);
              changeSource(index, { rarity, level: allowed.includes(source.level) ? source.level : allowed[0] ?? 300 });
            }}><option value="UR">UR</option><option value="LR" disabled={source.characterRarity !== 'LR5'}>LR{source.characterRarity !== 'LR5' ? ' · 需 LR5' : ''}</option></select></Field>
            <Field label="基准等级" path={`weaponSources[${index}].level`} errors={errors}><select aria-label={`${characterLabel(character)}基准武器等级`} value={source.level} onChange={event => changeSource(index, { level: Number(event.target.value) })}>{!levels.includes(source.level) && <option value={source.level}>{source.level} · 不可用</option>}{levels.map(level => <option key={level} value={level}>Lv. {level}</option>)}</select></Field>
          </div>
        </div>;
      })}</div>
    </details>
  </section>;
}

function CostSummary({ cost, errors, policy, catalog, canExport, onExport, memberCount, inventory }) {
  const displayedResources = ['runeTickets', 'reinforcementMedicine', 'holySteel'];
  const steelRatio = policy.holySteelPerExperience || 1;
  const captionByResource = {
    runeTickets: '穿透、速度符石折算', reinforcementMedicine: '含武器与其余五件装备',
    holySteel: '按各部位累计经验合计',
  };
  const resourceLabel = key => RESOURCE_NAMES[key] ?? key;
  const scaled = (key, value) => key === 'holySteel' ? value / steelRatio : value;
  const leafCosts = cost?.equipmentCosts?.filter(item => (item.resources?.lifeTreeDew ?? 0) > 0) ?? [];
  const costKey = item => `${item.sourceKind ?? 'team'}-${item.sourceIndex ?? item.position}-${item.slot ?? 'weapon'}`;
  const catalogCharacter = id => catalog.characters.find(character => character.id === id);
  return <aside className="panel summary-panel" aria-label="资源与费用摘要">
    <div className="panel-header"><div className="panel-heading"><span className="section-index">03</span><h2>资源预算</h2></div><Icon name="sparkle" size={16} /></div>
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
      const free = scaled(key, resource?.freeAllowance ?? policy.allowances?.[key] ?? 0);
      const charged = resource ? scaled(key, resource.charged) : null;
      const ratio = consumed == null ? 0 : free > 0 ? Math.min(1, consumed / free) : consumed > 0 ? 1 : 0;
      return <div className="resource-item" key={key}>
        <div className="resource-item-top"><span>{resourceLabel(key)}</span><strong>{amount(consumed)}</strong></div>
        <div className="resource-caption"><span>{captionByResource[key]}</span><span>{amount(free)} 免费</span></div>
        <div className={`resource-bar${charged > 0 ? ' exceeded' : ''}`}><span style={{ width: `${ratio * 100}%` }} /></div>
        {charged > 0 && <p className="resource-extra">超出 {amount(charged)} · +{amount(resource.diamonds)} 钻</p>}
      </div>;
    })}</div>
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
    {cost?.characterCosts?.some(item => item.freeDiamonds > 0) && <div className="free-credit-note">免费库已抵扣本体 {amount(cost.characterCosts.reduce((sum, item) => sum + (item.freeDiamonds ?? 0), 0))} 钻</div>}
    {cost?.exclusiveWeaponCosts?.length > 0 && <section className="weapon-costs" aria-label="专武造价">
      <div className="resource-section-title"><span>专武造价</span><span>已计入总额</span></div>
      {cost.exclusiveWeaponCosts.map(item => <div className="weapon-cost-item" key={costKey(item)}>
        <div className="weapon-cost-heading"><span>{item.characterName} · {item.rarity} Lv.{item.level}{item.sourceKind === 'reserve' ? ' · 队外基准' : ''}</span><strong>{amount(item.diamonds)} 钻</strong></div>
        {item.borrowed && <p className="borrowed-weapon-note">借用 {item.weaponOwnerCharacterName} 专武 · 不提供当前角色的专武技能</p>}
        {item.syncSlot > 0 && <p className="synced-weapon-level">同步位 {item.syncSlot} → Lv.{item.effectiveLevel} · 升级材料按基础 Lv.{item.level} 计算</p>}
        <p>紫水晶等价 {amount(item.magicCrystals)} 个 · {amount(item.magicCrystals * item.magicCrystalUnitPrice)} 钻</p>
        {item.lifeTreeDew > 0 && <p>叶子 {amount(item.lifeTreeDew)} 个 · {amount(item.lifeTreeDew * (policy.unitPrices?.lifeTreeDew ?? 0))} 钻</p>}
        {item.freeDiamonds > 0 && <p className="free-weapon-credit">免费库抵扣 {amount(item.freeMagicCrystals)} 紫水晶等价{item.freeLifeTreeDew > 0 ? `、${amount(item.freeLifeTreeDew)} 叶子` : ''} · {amount(item.freeDiamonds)} 钻</p>}
      </div>)}
    </section>}
    {leafCosts.length > 0 && <section className="weapon-costs leaf-costs" aria-label="叶子造价">
      <div className="resource-section-title"><span>叶子造价</span><span>{amount(cost.resources.lifeTreeDew.diamonds)} 钻</span></div>
      <p className="inventory-caption">UR 专武 15；LR 专武 65（UR 15 ＋ LR 50）；通用 LR 装备每件 50。每个 {amount(policy.unitPrices?.lifeTreeDew)} 钻。</p>
      {leafCosts.map(item => {
        const consumed = item.resources.lifeTreeDew;
        const charged = item.chargedResources?.lifeTreeDew ?? Math.max(0, consumed - (item.freeLibraryCredits?.lifeTreeDew ?? 0));
        return <div className="leaf-cost-row" key={costKey(item)}><span>{characterLabel(catalogCharacter(item.characterId))} · {item.weaponKind === 'exclusive' ? `${item.rarity} 专武` : `${SLOT_NAMES[item.slot]} ${item.rarity}`}{item.sourceKind === 'reserve' ? '（队外）' : ''}<small>{consumed} 个 · 免费抵扣 {amount(consumed - charged)}</small></span><strong>{amount(charged * (policy.unitPrices?.lifeTreeDew ?? 0))} 钻</strong></div>;
      })}
    </section>}
    {cost?.weaponSourceCosts?.length > 0 && <section className="weapon-costs" aria-label="队外基准费用">
      <div className="resource-section-title"><span>队外基准费用</span><span>已计入总额</span></div>
      {cost.weaponSourceCosts.map(item => <div className="weapon-cost-item" key={item.sourceIndex}><div className="weapon-cost-heading"><span>{item.characterName} · {item.rarity} Lv.{item.level}</span><strong>{amount(item.diamonds)} 钻</strong></div><p>本体 {amount(item.characterDiamonds)} 钻 · 专武 {amount(item.weaponDiamonds)} 钻</p></div>)}
    </section>}
    <details className="price-details"><summary>查看费用细目与规则</summary><div className="cost-detail-content">
      <dl>{cost?.characterCosts?.map(item => <React.Fragment key={costKey(item)}><dt>{item.characterName} · {item.rarity} · {item.copies} 本体{item.freeRarity ? `（免费至 ${item.freeRarity}）` : ''}{item.sourceKind === 'reserve' ? ' · 队外基准' : ''}</dt><dd>{amount(item.diamonds)} 钻</dd></React.Fragment>)}
        {RESOURCE_KEYS.filter(key => key !== 'unidentifiedRune7').map(key => {
          const resource = cost?.resources?.[key];
          if (!resource || resource.consumed === 0) return null;
          return <React.Fragment key={key}><dt>{RESOURCE_NAMES[key] ?? key} · {amount(resource.consumed)}</dt><dd>{amount(resource.diamonds)} 钻</dd></React.Fragment>;
        })}
      </dl>
      <p>符石兑换券超额单价 {amount(policy.unitPrices?.runeTickets)} 钻 / 张；强化秘药 {amount(policy.unitPrices?.reinforcementMedicine)} 钻 / 个；圣装经验 {amount((policy.unitPrices?.holySteel ?? 0) * steelRatio)} 钻 / 点。</p>
      <p>魔装累计经验 {amount(cost?.matchlessExperience)}。各类碎片独立计价；材料表示当前配置的累计投入，降级会减少预算。</p>
      <p>导出包含完整计价规则与费用细目。接收方会按当前规则重新计算。</p>
    </div></details>
    <button className="button primary summary-export" disabled={!canExport} onClick={onExport}><Icon name="download" />导出配队文件</button>
    <p className="summary-export-note">{memberCount < 5 ? '选齐 5 名角色即可导出' : errors.length ? '修正无效配置后即可导出' : '下载 JSON 文件，发送给站主用于构建'}</p>
    <p className="policy-footnote">规则版本：{policy.version ?? policy.revision ?? '当前规则'}<br />费用为构筑预算，不代表战力或战斗结果。</p>
  </aside>;
}

export default function App({ catalog, policy, freeLibrary, nameAliases }) {
  const [restoredDraft] = useState(() => restoreDraft(catalog, policy));
  const [team, setTeam] = useState(restoredDraft.team);
  const [selectedIndex, setSelectedIndex] = useState(() => team.members.findIndex(Boolean));
  const [search, setSearch] = useState('');
  const [element, setElement] = useState('all');
  const [notice, setNotice] = useState(restoredDraft.notice);
  const [draftStatus, setDraftStatus] = useState('已保存在此浏览器');
  const [dropTarget, setDropTarget] = useState(null);
  const importInput = useRef(null);
  const editorRef = useRef(null);
  const draftBackupDone = useRef(!restoredDraft.needsBackup);
  const rosterClick = useRef(null);
  const dragPayload = useRef(null);
  const characters = useMemo(() => new Map(catalog.characters.map(character => [character.id, character])), [catalog]);
  const aliases = useMemo(() => new Map((nameAliases?.characters ?? []).map(item => [item.characterId, item.aliases.join(' ')])), [nameAliases]);
  const freeCharacters = useMemo(() => new Map((freeLibrary?.characters ?? []).map(item => [item.characterId, item])), [freeLibrary]);
  const selectedMember = team.members[selectedIndex];
  const selectedCharacter = selectedMember ? characters.get(selectedMember.characterId) : null;
  const memberCount = team.members.filter(Boolean).length;
  const valuation = useMemo(() => {
    const validation = validateTeam(team, catalog, policy, { freeLibrary });
    if (!validation.valid) return { cost: null, errors: validation.errors };
    try { return { cost: calculateTeam(team, catalog, policy, freeLibrary), errors: [] }; }
    catch (error) { return { cost: null, errors: error.errors ?? [{ message: error.message }] }; }
  }, [team, catalog, policy, freeLibrary]);
  const canExport = memberCount === 5 && valuation.errors.length === 0;
  const inventory = useMemo(() => fixedRuneInventory(team, catalog, policy, valuation.cost), [team, catalog, policy, valuation.cost]);
  const weaponSync = useMemo(() => deriveWeaponSync(team, catalog, policy, freeLibrary), [team, catalog, policy, freeLibrary]);
  const borrowableWeapons = useMemo(() => selectedMember ? getBorrowableWeapons(team, selectedIndex, catalog, freeLibrary) : [], [team, selectedMember, selectedIndex, catalog, freeLibrary]);
  const ownWeaponClaimed = selectedMember ? isWeaponOwnerClaimed(team, selectedIndex, selectedMember.characterId) : false;
  const syncOptions = useMemo(() => {
    if (!selectedMember) return weaponSync.slots;
    return weaponSync.slots.map(slot => {
      const preview = { ...team, members: team.members.map((member, index) => index === selectedIndex ? { ...member, equipment: member.equipment.map(gear => gear.slot === 1 ? { ...gear, syncSlot: slot.slot } : gear) } : member) };
      return deriveWeaponSync(preview, catalog, policy, freeLibrary).slots.find(item => item.slot === slot.slot);
    });
  }, [team, catalog, policy, freeLibrary, weaponSync, selectedMember, selectedIndex]);
  const filtered = catalog.characters.filter(character =>
    (character.baseRarity == null || character.baseRarity === 8)
    && (element === 'all' || character.element === element)
    && `${character.name} ${character.subtitle ?? ''} ${character.variant ?? ''} ${character.aliases?.join?.(' ') ?? ''} ${aliases.get(character.id) ?? ''} ${character.id}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  useEffect(() => () => clearTimeout(rosterClick.current?.timer), []);
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
  function changeTeam(update, { preserveRosterClick = false } = {}) {
    clearTimeout(rosterClick.current?.timer);
    if (!preserveRosterClick) rosterClick.current = null;
    setNotice(null);
    setTeam(current => typeof update === 'function' ? update(current) : update);
  }
  function applyPlacement(result, options) {
    if (result.full) { setNotice({ kind: 'info', text: '配队已满。双击左侧角色可替换当前选中角色，也可以拖到目标位置。' }); return; }
    const synchronized = { ...result.team, weaponSources: (result.team.weaponSources ?? []).map(source => {
      const actor = result.team.members.find(member => member?.characterId === source.characterId);
      return actor && source.characterRarity !== actor.rarity ? { ...source, characterRarity: actor.rarity } : source;
    }) };
    changeTeam(synchronized, options);
    setSelectedIndex(result.selectedIndex);
  }
  function addCharacter(character) {
    applyPlacement(addRosterCharacter(team, character, { catalog, freeLibrary }));
  }
  function selectMember(index) {
    clearTimeout(rosterClick.current?.timer);
    rosterClick.current = null;
    setSelectedIndex(index);
  }
  function clickRoster(character, event) {
    if (event.detail > 1) return;
    clearTimeout(rosterClick.current?.timer);
    if (event.detail === 0) { rosterClick.current = null; addCharacter(character); return; }
    const snapshot = { team, selectedIndex, characterId: character.id };
    snapshot.timer = setTimeout(() => {
      if (rosterClick.current === snapshot) applyPlacement(addRosterCharacter(snapshot.team, character, { catalog, freeLibrary }), { preserveRosterClick: true });
    }, 240);
    rosterClick.current = snapshot;
  }
  function doubleClickRoster(character) {
    const snapshot = rosterClick.current;
    clearTimeout(snapshot?.timer);
    rosterClick.current = null;
    const before = snapshot?.characterId === character.id ? snapshot : { team, selectedIndex };
    applyPlacement(rosterDoubleClick(before.team, character, before.selectedIndex, { catalog, freeLibrary }));
  }
  function startDrag(event, payload) {
    clearTimeout(rosterClick.current?.timer);
    rosterClick.current = null;
    dragPayload.current = payload;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(TEAM_DRAG_TYPE, JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', '配队角色');
  }
  function endDrag() { dragPayload.current = null; setDropTarget(null); }
  function dropMember(event, index) {
    event.preventDefault();
    let payload;
    try { payload = JSON.parse(event.dataTransfer.getData(TEAM_DRAG_TYPE)); } catch { payload = dragPayload.current; }
    endDrag();
    if (payload?.kind === 'member' && team.members[payload.index]?.characterId === payload.characterId) applyPlacement(swapTeamPositions(team, payload.index, index, selectedIndex));
    else if (payload?.kind === 'character' && characters.has(payload.characterId)) applyPlacement(placeRosterCharacter(team, characters.get(payload.characterId), index, { catalog, freeLibrary }));
  }
  function updateMember(update) {
    changeTeam(current => ({ ...current,
      members: current.members.map((member, index) => index === selectedIndex ? { ...member, ...update } : member),
      weaponSources: (current.weaponSources ?? []).map(source => update.rarity && source.characterId === current.members[selectedIndex]?.characterId ? { ...source, characterRarity: update.rarity } : source),
    }));
  }
  function updateEquipment(index, equipment) {
    changeTeam(current => ({ ...current, members: current.members.map((member, i) => i === selectedIndex ? { ...member, equipment: member.equipment.map((gear, j) => j === index ? equipment : gear) } : member) }));
  }
  function equipSource(sourceIndex) {
    changeTeam(current => equipReserveWeapon(current, sourceIndex));
  }
  function removeMember(index) {
    changeTeam(current => ({ ...current, members: current.members.map((member, i) => i === index ? null : member) }));
    if (selectedIndex === index) setSelectedIndex(team.members.findIndex((member, i) => member && i !== index));
  }
  function moveMember(index, offset) {
    applyPlacement(swapTeamPositions(team, index, index + offset, selectedIndex));
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
    clearTimeout(rosterClick.current?.timer);
    rosterClick.current = null;
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
    <div className="intro"><div><div className="eyebrow">BUILD YOUR OWN STORY</div><h1>身为剑所天成</h1><p>挑选角色，调整装备，掌握资源预算。完成后导出你的专属方案。</p></div><div className="intro-note"><strong>{policy.characterLevel}</strong><span>级统一链接模拟基准<br />SR、LR 与 LR5 共用此等级</span></div></div>
    {notice && <div className={`notice ${notice.kind}`} role="status" style={{ marginBottom: 16 }}>{notice.text}</div>}
    <main className="workspace">
      <div className="left-column">
        <section className="panel team-panel" aria-label="当前五人配队">
          <div className="panel-header"><div className="panel-heading"><h2>我的配队 <span className="count">{memberCount} / 5</span></h2></div><div className="team-header-controls"><button className="quiet-button reset-button" onClick={() => { changeTeam({ ...createTeam(), level: policy.characterLevel }); setSelectedIndex(-1); }}>新建方案</button></div></div>
          <div className="team-slots">{team.members.map((member, index) => {
            const character = member ? characters.get(member.characterId) : null;
            return <div key={index} className={`team-slot${member ? '' : ' empty'}${member && index === selectedIndex ? ' selected' : ''}${dropTarget === index ? ' drop-target' : ''}`} draggable={Boolean(member)}
              onDragStart={event => member && startDrag(event, { kind: 'member', index, characterId: member.characterId })} onDragEnd={endDrag}
              onDragOver={event => { if (!event.dataTransfer.types.includes(TEAM_DRAG_TYPE)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropTarget(index); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(current => current === index ? null : current); }} onDrop={event => dropMember(event, index)}>
              <span className="slot-position">0{index + 1}</span>
              {member ? <><button className="member-select" title={characterLabel(character)} aria-label={`配置${characterLabel(character)}，位置${index + 1}`} aria-pressed={index === selectedIndex} onClick={() => selectMember(index)}><Portrait character={character} /><span className="member-name">{character?.name}</span>{character?.subtitle && <span className="member-subtitle">{character.subtitle}</span>}<span className="rarity-pill">{member.rarity} · Lv.{team.level}</span></button><div className="member-actions"><button className="icon-button" aria-label={`${characterLabel(character)}前移`} title="前移" disabled={index === 0} onClick={() => moveMember(index, -1)}><Icon name="left" size={12} /></button><button className="icon-button" aria-label={`${characterLabel(character)}后移`} title="后移" disabled={index === 4} onClick={() => moveMember(index, 1)}><Icon name="right" size={12} /></button><button className="icon-button danger" aria-label={`移除${characterLabel(character)}`} title="移除角色" onClick={() => removeMember(index)}><Icon name="close" size={12} /></button></div></> : <div className="empty-slot-content"><div className="empty-slot-plus">＋</div><span>待选择</span></div>}
            </div>;
          })}</div>
          <p className="team-note">拖动调整站位或从下方拖入角色。替换保留该位置的稀有度、装备与符石。</p>
        </section>
      <aside className="panel catalog-panel" aria-label="角色目录">
        <div className="panel-header"><div className="panel-heading"><span className="section-index">01</span><h2>选择角色</h2></div><span className="count">{filtered.length} 位</span></div>
        <div className="search"><Icon name="search" size={14} /><input aria-label="搜索角色" placeholder="搜索角色名称" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div className="filter-row" role="group" aria-label="元素筛选"><button className={`filter-button${element === 'all' ? ' active' : ''}`} aria-pressed={element === 'all'} onClick={() => setElement('all')}>全部</button>{Object.entries(ELEMENTS).map(([key, item]) => <button key={key} className={`filter-button${element === key ? ' active' : ''}`} aria-pressed={element === key} onClick={() => setElement(key)}>{item.name}</button>)}</div>
        <div className="catalog-grid">{filtered.map(character => {
          const inTeam = team.members.some(member => member?.characterId === character.id);
          const entitlement = freeCharacters.get(character.id);
          return <button className={`character-tile${inTeam ? ' in-team' : ''}`} key={character.id} title={`${characterLabel(character)} · 单击${inTeam ? '查看当前配置' : '加入配队'}，双击替换选中角色${entitlement ? ` · 免费库 ${entitlement.rarity}` : ''}`} aria-label={`${inTeam ? '选择' : '添加'}${characterLabel(character)}`} onClick={event => clickRoster(character, event)} onDoubleClick={() => doubleClickRoster(character)} draggable onDragStart={event => startDrag(event, { kind: 'character', characterId: character.id })} onDragEnd={endDrag}>
            <div style={{ position: 'relative' }}><Portrait character={character} />{inTeam && <span className="selected-check"><Icon name="check" size={10} /></span>}</div><span className="tile-name">{character.name}</span>{character.subtitle && <span className="tile-subtitle">{character.subtitle}</span>}{entitlement && <span className="tile-free-cap">{entitlement.rarity} 免费</span>}
          </button>;
        })}{filtered.length === 0 && <p className="no-results">没有找到符合条件的角色</p>}</div>
        <p className="catalog-help">单击加入或选择 · 双击替换选中角色<br />也可拖动到上方的指定站位。</p>
      </aside>
      </div>
      <div className="center-column">
        <section className="panel details-panel" ref={editorRef} aria-label="当前角色装备配置">
          <div className="panel-heading gear-panel-heading"><span className="section-index">02</span><h2>角色与装备</h2></div>
          {selectedMember && selectedCharacter ? <>
            <div className="selected-character-header"><div className="selected-character-identity"><Portrait character={selectedCharacter} /><div><h2>{selectedCharacter.name}</h2>{selectedCharacter.subtitle && <p className="selected-subtitle">{selectedCharacter.subtitle}</p>}<p className="character-meta">{ELEMENTS[selectedCharacter.element]?.name}属性 · 第 {selectedIndex + 1} 位 · Lv.{policy.characterLevel}</p></div></div><label className="rarity-control"><span className="field-label">角色稀有度</span><select aria-label="角色稀有度" value={selectedMember.rarity} onChange={event => updateMember({ rarity: event.target.value })}><option value="SR">SR</option><option value="LR">LR</option><option value="LR5">LR5</option></select></label></div>
            {valuation.errors.length > 0 && <div className="notice error validation-notice" role="alert"><strong>当前配置需要修正</strong><ul>{valuation.errors.slice(0, 6).map((issue, i) => <li key={`${issue.path}-${i}`}>{issue.message}</li>)}</ul>{valuation.errors.length > 6 && <p>另有 {valuation.errors.length - 6} 项，请逐项检查。</p>}</div>}
            <div className="equip-intro"><span>六部位装备</span><span>未装备部位不消耗材料</span></div>
            {(freeCharacters.has(selectedCharacter.id) || freeLibrary?.exclusiveWeapons?.some(item => item.characterId === selectedCharacter.id)) && <p className="free-library-note">免费库：{freeCharacters.has(selectedCharacter.id) ? `角色本体免费至 ${freeCharacters.get(selectedCharacter.id).rarity}` : ''}{freeLibrary?.exclusiveWeapons?.filter(item => item.characterId === selectedCharacter.id).map(item => `${freeCharacters.has(selectedCharacter.id) ? '；' : ''}${item.level} 级 ${item.rarity} 专武基准免费`).join('')}。更高配置按差额计价。</p>}
            {policy.runes?.fixedStock && <p className="fixed-stock-note">普通符石：每类 {fixedRuneCaption(policy)}，整队共享。穿透与速度可自由调整等级。</p>}
            <div className="equip-grid">{EQUIPMENT_SLOTS.map((slot, index) => <EquipmentEditor key={`${selectedMember.characterId}-${slot}`} gear={selectedMember.equipment[index]} index={index} member={selectedMember} memberIndex={selectedIndex} catalog={catalog} policy={policy} freeLibrary={freeLibrary} errors={valuation.errors} inventory={inventory} weaponSync={weaponSync} syncOptions={syncOptions} borrowableWeapons={borrowableWeapons} ownWeaponClaimed={ownWeaponClaimed} onChange={gear => updateEquipment(index, gear)} />)}</div>
          </> : <div className="empty-detail"><div className="empty-detail-mark"><Icon name="gear" size={23} /></div><h2>从一名角色开始</h2><p>在角色目录中选择头像，设定稀有度与六部位装备。<br />全队使用 Lv.{policy.characterLevel} 统一链接基准。</p></div>}
        </section>
        <WeaponSyncEditor team={team} catalog={catalog} policy={policy} freeLibrary={freeLibrary} sync={weaponSync} errors={valuation.errors} onChange={weaponSources => changeTeam(current => ({ ...current, weaponSources }))} onEquipSource={equipSource} />
        <section className="panel plan-panel" aria-label="方案信息"><div className="panel-header"><h2>为方案留下一些说明</h2><span className="count">自动保存草稿</span></div><div className="plan-fields"><Field label="配队名称" path="name" errors={valuation.errors}><input aria-label="配队名称" maxLength={120} value={team.name} onChange={event => changeTeam(current => ({ ...current, name: event.target.value }))} /></Field><Field label="作者 / 昵称（可选）" path="author" errors={valuation.errors}><input aria-label="作者昵称" maxLength={120} placeholder="你的昵称" value={team.author} onChange={event => changeTeam(current => ({ ...current, author: event.target.value }))} /></Field><Field label="备注（可选）" path="notes" errors={valuation.errors} full><textarea aria-label="方案备注" rows={3} maxLength={4000} placeholder="例如：配队思路、主力角色或希望测试的对手……" value={team.notes} onChange={event => changeTeam(current => ({ ...current, notes: event.target.value }))} /></Field></div></section>
      </div>
      <CostSummary cost={valuation.cost} errors={valuation.errors} policy={policy} catalog={catalog} memberCount={memberCount} inventory={inventory} canExport={canExport} onExport={exportTeam} />
    </main>
    <footer className="footer"><span>配队与草稿保存在你的浏览器中 · 不自动上传 · {draftStatus}</span><span>资源价值参考 <a href="https://hitazuki.github.io/mementomori-calculator/#packCompare" target="_blank" rel="noopener noreferrer">MementoMori Calculator</a> · 最终按站主规则复核</span></footer>
  </div>;
}
