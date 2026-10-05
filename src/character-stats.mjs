// Independent static build calculator. Display data is a deliberately limited
// public projection; no account snapshot, service or combat state is required.
const BASE_KEYS = ['Muscle', 'Energy', 'Intelligence', 'Health'];
const BATTLE_KEYS = ['HP', 'AttackPower', 'PhysicalDamageRelax', 'MagicDamageRelax', 'Hit', 'Avoidance', 'Critical', 'CriticalResist', 'CriticalDamageEnhance', 'PhysicalCriticalDamageRelax', 'MagicCriticalDamageRelax', 'DefensePenetration', 'Defense', 'DamageEnhance', 'DebuffHit', 'DebuffResist', 'DamageReflect', 'HpDrain', 'Speed'];
const MAIN_ATTRIBUTE = { 1: 'Muscle', 2: 'Energy', 4: 'Intelligence' };
const POLISH_KEYS = { muscle: 'Muscle', energy: 'Energy', intelligence: 'Intelligence', health: 'Health' };
const MULTIPLIED = new Set(['HP', 'AttackPower', 'Defense', 'PhysicalDamageRelax', 'MagicDamageRelax', 'Hit', 'Avoidance', 'Critical', 'CriticalResist', 'DebuffHit', 'DebuffResist']);
const RATE_KEYS = new Set(['CriticalDamageEnhance', 'PhysicalCriticalDamageRelax', 'MagicCriticalDamageRelax', 'DamageReflect', 'HpDrain']);
const MAIN_ROWS = ['AttackPower', 'HP', 'Speed', 'Defense', 'PhysicalDamageRelax', 'MagicDamageRelax'];
const LABELS = {
  Muscle: '力量', Energy: '战技', Intelligence: '魔力', Health: '耐力',
  HP: '生命', AttackPower: '攻击力', Defense: '防御力', Speed: '速度',
  PhysicalDamageRelax: '物理防御', MagicDamageRelax: '魔法防御',
  Hit: '命中', Avoidance: '回避', Critical: '暴击值', CriticalResist: '暴击耐性',
  CriticalDamageEnhance: '暴击伤害提升', PhysicalCriticalDamageRelax: '物理暴击伤害减免',
  MagicCriticalDamageRelax: '魔法暴击伤害减免', DefensePenetration: '防御穿透',
  DamageEnhance: '物魔防御穿透', DebuffHit: '弱化效果命中', DebuffResist: '弱化效果耐性',
  DamageReflect: '反弹', HpDrain: '吸血',
};
const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const display = (key, value) => RATE_KEYS.has(key) ? `${format.format(value / 100)}%` : format.format(value);
const initialKey = key => key === 'HP' ? 'Hp' : key;
const empty = keys => Object.fromEntries(keys.map(key => [key, 0]));
const part = (label, displayValue) => ({ label, displayValue });
const requireValue = (value, message) => {
  if (!Number.isFinite(value)) throw new Error(message);
  return value;
};
const requireLevel = (level, maximum, label) => {
  if (!Number.isSafeInteger(level) || level < 0 || level > maximum) throw new Error(`${label}超出可计算范围。`);
  return level;
};

// The four integer allocations always preserve the equipment's original total.
// Remainders use the public, fixed attribute order, including equal shares.
export function allocatePolish(total, attribute, job, settings) {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('装备附加四维总量无效。');
  const selected = attribute === 'main' ? MAIN_ATTRIBUTE[job] : POLISH_KEYS[attribute];
  if (attribute !== 'none' && !selected) throw new Error('打磨属性未知。');
  const percent = requireValue(settings?.selectedPercent, '满打磨比例数据缺失。');
  if (!Number.isSafeInteger(percent) || percent < 25 || percent > 100) throw new Error('满打磨比例无效。');
  const numerators = BASE_KEYS.map(key => total * (attribute === 'none' ? 75 : key === selected ? percent * 3 : 100 - percent));
  if (numerators.some(value => !Number.isSafeInteger(value))) throw new Error('打磨总量超出可计算范围。');
  const values = numerators.map(value => Math.floor(value / 300));
  const remainder = total - values.reduce((sum, value) => sum + value, 0);
  const order = BASE_KEYS.map((_, i) => i).sort((a, b) => numerators[b] % 300 - numerators[a] % 300 || a - b);
  for (const index of order.slice(0, remainder)) values[index]++;
  return Object.fromEntries(BASE_KEYS.map((key, i) => [key, values[i]]));
}

function normalizedEffect(effect, label) {
  const keys = effect.group === 'base' ? BASE_KEYS : effect.group === 'battle' ? BATTLE_KEYS : null;
  if (!keys || !Number.isSafeInteger(effect.type) || !keys[effect.type - 1] || ![1, 2, 3].includes(effect.changeType)) throw new Error(`${label}属性类型未知。`);
  return { ...effect, key: keys[effect.type - 1], value: requireValue(effect.value, `${label}属性数值缺失。`), source: label };
}

function evaluate(member, catalog, policy, arcanaState) {
  const data = catalog.characterStats;
  if (!data || data.schemaVersion !== 1) throw new Error('角色属性数据尚未加载。');
  if (!member) throw new Error('请先选择一名配队角色。');
  const character = data.characters?.[member.characterId];
  const natural = character?.baseByRarity?.[member.rarity];
  if (!natural || !MAIN_ATTRIBUTE[character.job]) throw new Error('此角色或稀有度的属性数据缺失。');
  if (policy.characterLevel !== data.characterLevel || (policy.baseline?.levelLink?.subLevel ?? 0) !== 0) throw new Error('当前等级与角色属性数据不一致。');
  if (policy.baseline?.playerLevel !== data.rank560?.rank) throw new Error('当前玩家等级与属性数据不一致。');
  if (!Array.isArray(member.equipment) || member.equipment.length !== 6) throw new Error('角色装备槽位不完整。');
  if (arcanaState?.errors?.length) throw new Error('秘仪配置无效，请先修正配置。');
  const level = policy.characterLevel;
  const base = Object.fromEntries(BASE_KEYS.map(key => [key, requireValue(natural[key], '角色基础四维数据缺失。')]));
  const baseParts = Object.fromEntries(BASE_KEYS.map(key => [key, [part('450级与当前稀有度', format.format(base[key]))]]));
  const polish = empty(BASE_KEYS);
  const effects = [];
  const gearEffects = [];
  const setCounts = new Map();
  const equipped = [];
  const add = (target, changes, label) => {
    if (!Array.isArray(changes)) throw new Error(`${label}属性数据缺失。`);
    target.push(...changes.map(effect => normalizedEffect(effect, label)));
  };
  for (const [index, gear] of member.equipment.entries()) {
    if (gear.slot !== index + 1) throw new Error('装备槽位顺序无效。');
    if (gear.rarity === 'NONE') continue;
    if (gear.rarity === 'LR' && member.rarity !== 'LR5') throw new Error('LR装备需要LR5角色。');
    const kind = gear.slot === 1 ? gear.weaponKind ?? 'normal' : 'normal';
    const template = data.equipment?.[`${kind}:${gear.slot}:${gear.rarity}:${gear.level}`];
    if (!template) throw new Error('此装备等级或稀有度的属性数据缺失。');
    equipped.push({ gear, template, kind });
    const distribution = allocatePolish(template.polishTotal, gear.polishAttribute ?? 'main', character.job, data.polish);
    for (const key of BASE_KEYS) polish[key] += distribution[key];
    if (!Array.isArray(gear.runes) || gear.runes.length !== 4) throw new Error('符石槽位不完整。');
    for (const rune of gear.runes) {
      if (rune.level === 0) continue;
      add(effects, data.runes?.[`${rune.categoryId}:${rune.level}`], '符石');
    }
  }
  // Spheres, then exclusive four-dimensional terms, then set terms, then arcana.
  for (const { gear, template, kind } of equipped) {
    const reinforced = requireLevel(gear.reinforcementLevel, Math.min(gear.level, 450), '强化等级');
    const coefficient = requireValue(data.reinforcementCoefficients?.[reinforced], '强化倍率数据缺失。');
    if (template.battleChange) add(gearEffects, [{ ...template.battleChange, value: template.battleChange.value * coefficient }], '装备与强化');
    for (const [kindName, levelKey] of [['legend', 'legendSacredTreasureLevel'], ['matchless', 'matchlessSacredTreasureLevel']]) {
      const treasureLevel = requireLevel(gear[levelKey], 40, kindName === 'legend' ? '圣装等级' : '魔装等级');
      if (!treasureLevel) continue;
      const bonus = catalog.equipmentBonuses?.kinds?.[kindName]?.slots?.[gear.slot];
      const value = requireValue(bonus?.values?.[treasureLevel], '圣魔装属性数据缺失。');
      add(gearEffects, [{ group: 'battle', type: bonus.parameterTypeId, changeType: bonus.changeParameterTypeId, value: bonus.unit === 'percent' ? value * 100 : value }], kindName === 'legend' ? '圣装' : '魔装');
    }
    if (template.setId) setCounts.set(template.setId, (setCounts.get(template.setId) ?? 0) + 1);
    if (kind === 'exclusive') {
      const owner = gear.weaponOwnerCharacterId ?? member.characterId;
      if (owner === member.characterId) {
        const exclusive = data.exclusiveEffects?.[`${owner}:${gear.rarity}:${gear.level}`] ?? data.exclusiveEffects?.[`${owner}:${gear.rarity}`];
        if (!exclusive) throw new Error('专武固有属性数据缺失。');
        add(gearEffects, exclusive.baseChanges, '自身专武');
        add(gearEffects, exclusive.battleChanges, '自身专武');
      }
    }
  }
  for (const [setId, count] of setCounts) {
    const thresholds = data.sets?.[setId];
    if (!Array.isArray(thresholds)) throw new Error('装备套装属性数据缺失。');
    for (const threshold of thresholds) if (threshold.requiredCount <= count) add(gearEffects, threshold.effects, '套装');
  }
  effects.push(...gearEffects);
  for (const key of BASE_KEYS) {
    base[key] += polish[key];
    if (polish[key]) baseParts[key].push(part('装备附加四维／打磨', format.format(polish[key])));
  }
  for (const effect of effects.filter(effect => effect.group === 'base')) {
    const delta = effect.changeType === 2 ? Math.trunc(base[effect.key] * effect.value * 0.0001) : Math.trunc(effect.value * (effect.changeType === 3 ? level : 1));
    base[effect.key] += delta;
    baseParts[effect.key].push(part(effect.source, format.format(delta)));
  }
  const arcanaEffects = (arcanaState?.bonusRows ?? []).map(effect => normalizedEffect({ ...effect, group: effect.kind }, '秘仪'));
  // Aggregate fixed/level effects before a single percentage application per base stat.
  for (const key of BASE_KEYS) {
    const changes = arcanaEffects.filter(effect => effect.group === 'base' && effect.key === key);
    const fixed = changes.filter(effect => effect.changeType !== 2).reduce((sum, effect) => sum + effect.value * (effect.changeType === 3 ? level : 1), 0);
    const percent = changes.filter(effect => effect.changeType === 2).reduce((sum, effect) => sum + effect.value, 0);
    base[key] += Math.trunc(fixed);
    const percentDelta = Math.trunc(base[key] * percent * 0.0001);
    base[key] += percentDelta;
    if (fixed || percentDelta) baseParts[key].push(part('已解锁秘仪', format.format(Math.trunc(fixed) + percentDelta)));
  }
  const addValues = empty(BATTLE_KEYS), percentages = empty(BATTLE_KEYS);
  const battleParts = Object.fromEntries(BATTLE_KEYS.map(key => [key, []]));
  for (const effect of [...effects, ...arcanaEffects].filter(effect => effect.group === 'battle')) {
    if (effect.changeType === 2) {
      percentages[effect.key] += effect.value;
      battleParts[effect.key].push(part(`${effect.source}比例`, `${format.format(effect.value / 100)}%`));
    } else {
      const delta = Math.trunc(effect.value * (effect.changeType === 3 ? level : 1));
      addValues[effect.key] += delta;
      battleParts[effect.key].push(part(effect.source, display(effect.key, delta)));
    }
  }
  const rank = data.rank560.bonuses;
  const battle = {};
  for (const key of BATTLE_KEYS) {
    const initial = requireValue(character.initialBattle?.[initialKey(key)], '角色初始战斗属性数据缺失。');
    let inside = initial + addValues[key], outside = 0, percent = percentages[key];
    if (initial) battleParts[key].unshift(part('角色初始值', display(key, initial)));
    let converted = 0;
    if (key === 'AttackPower') {
      converted = base[MAIN_ATTRIBUTE[character.job]];
      percent += requireValue(rank.AttackPowerPercentBonus, '玩家等级攻击比例缺失。');
      outside = requireValue(rank.AttackPowerBonus, '玩家等级攻击加成缺失。');
      battleParts[key].push(part('玩家560级固定加成（比例后）', format.format(outside)));
    } else if (key === 'HP') {
      converted = base.Health * 10;
      const fixed = requireValue(rank.HpBonus, '玩家等级生命加成缺失。');
      inside += fixed;
      percent += requireValue(rank.HpPercentBonus, '玩家等级生命比例缺失。');
      battleParts[key].push(part('玩家560级固定加成', format.format(fixed)));
    } else if (key === 'Defense') {
      inside -= initial;
      outside = initial;
    } else if (key === 'PhysicalDamageRelax') converted = base.Muscle;
    else if (key === 'MagicDamageRelax') converted = base.Intelligence;
    else if (['Hit', 'Avoidance', 'Critical', 'CriticalResist', 'DebuffHit'].includes(key)) {
      const source = { Hit: 'Muscle', Avoidance: 'Energy', Critical: 'Energy', CriticalResist: 'Health', DebuffHit: 'Intelligence' }[key];
      converted = base[source] * 0.5;
    }
    inside += converted;
    if (converted) battleParts[key].push(part('当前四维转换', format.format(converted)));
    if (key !== 'AttackPower' && key !== 'HP' && key !== 'Defense') {
      const fixed = requireValue(rank[`${key}Bonus`] ?? 0, '玩家等级固定加成无效。');
      inside += fixed;
      if (fixed) battleParts[key].push(part('玩家560级固定加成', display(key, fixed)));
    }
    if (key === 'HP' && rank.HpPercentBonus) battleParts[key].push(part('玩家560级生命比例', `${format.format(rank.HpPercentBonus / 100)}%`));
    if (key === 'AttackPower' && rank.AttackPowerPercentBonus) battleParts[key].push(part('玩家560级攻击比例', `${format.format(rank.AttackPowerPercentBonus / 100)}%`));
    battle[key] = MULTIPLIED.has(key) ? Math.trunc(inside * (10000 + percent) * 0.0001 + (key === 'Defense' ? outside : 0)) + (key === 'AttackPower' ? outside : 0) : Math.trunc(inside);
    if (!Number.isSafeInteger(battle[key]) || battle[key] < 0) throw new Error('当前属性超出可计算范围。');
  }
  const rows = [...MAIN_ROWS, ...BASE_KEYS, ...BATTLE_KEYS.filter(key => !MAIN_ROWS.includes(key))].map(key => ({
    key, group: BASE_KEYS.includes(key) ? 'base' : MAIN_ROWS.includes(key) ? 'main' : 'advanced',
    label: LABELS[key], displayValue: BASE_KEYS.includes(key) ? format.format(base[key]) : display(key, battle[key]),
    parts: BASE_KEYS.includes(key) ? baseParts[key] : battleParts[key],
  }));
  return { valid: true, errors: [], base, battle, rows, notes: [
    `角色 Lv.${level} · 玩家等级 ${data.rank560.rank} · 等级联结副等级 0。`,
    `满打磨：所选属性占 ${data.polish.selectedPercent}%，其余均分；四维均分选项按各25%，整数尾差按固定四维顺序分配。`,
    '包含装备、强化、符石、圣魔装、固有专武属性、套装及已解锁秘仪；借用专武不获得其固有加成。',
    '不计战斗技能、临时增益与战斗阵营加成；本页为构筑静态面板，实际战斗接入仍为后续工作。',
  ] };
}

export function calculateCharacterStats(member, catalog, policy, arcanaState) {
  try { return evaluate(member, catalog, policy, arcanaState); }
  catch (error) { return { valid: false, errors: [{ message: error.message }], rows: [], notes: [] }; }
}
