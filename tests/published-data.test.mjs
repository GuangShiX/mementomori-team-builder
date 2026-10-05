import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createTeam,createMember,calculateTeam,createExport,parseImport,validateTeam,deriveWeaponSync,deriveWeaponPricing} from '../src/domain.mjs';
const catalog = JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url)));
const policy = JSON.parse(await readFile(new URL('../public/data/pricing-policy.json',import.meta.url)));
const lock = JSON.parse(await readFile(new URL('../public/data/asset-lock.json',import.meta.url)));
const freeLibrary = JSON.parse(await readFile(new URL('../public/data/free-library.json',import.meta.url)));
const manualPolicy = () => ({...policy,weaponSync:{minimumLevel:300,maximumSourceCount:3,slots:[{slot:1,requiredAnchors:2},{slot:2,requiredAnchors:3}]}});
const five = () => {const team=createTeam();team.members=catalog.characters.slice(0,5).map(createMember);return team;};

test('all shipped portraits match the canonical public asset manifest',async()=>{
  assert.equal(catalog.characters.length,lock.portraits.length);
  for(const asset of lock.portraits){
    const bytes=await readFile(new URL(`../public/${asset.path}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),asset.sha256);
  }
});
test('actual policy handles complete all-SR teams and untrusted fee import',()=>{
  const team=five();
  assert.equal(calculateTeam(team,catalog,policy).totalDiamonds,60000);
  const exported=createExport(team,catalog,policy);
  exported.costBreakdown.totalDiamonds=0;
  exported.policySnapshot.unitPrices.characterCopy=0;
  assert.equal(parseImport(JSON.stringify(exported),catalog,policy).costBreakdown.totalDiamonds,60000);
});
test('current curse policy prices every required copy at twelve thousand while keeping rarity counts',()=>{
  const normal=catalog.characters.find(character=>!['light','dark'].includes(character.element));
  const lightDark=catalog.characters.find(character=>['light','dark'].includes(character.element));
  const team=createTeam();team.members[0]=createMember(normal.id);team.members[1]=createMember(lightDark.id);
  for(const [rarity,expectedCopies] of [['SR',[1,1]],['LR',[8,14]],['LR5',[20,26]]]){
    team.members[0].rarity=rarity;team.members[1].rarity=rarity;
    const cost=calculateTeam(team,catalog,policy);
    assert.deepEqual(cost.characterCosts.map(item=>item.copies),expectedCopies);
    assert.equal(cost.characterDiamonds,expectedCopies.reduce((sum,count)=>sum+count*12000,0));
  }
  assert.equal(policy.baseline.curse.name,'诅咒·时之枷锁');
  assert.equal(policy.baseline.curse.fixedCharacterLevel,450);
  assert.equal(policy.baseline.arcanaMode,'ownedRarity');
});
test('older seventeen-thousand-copy exports import under the current price without losing equipment or free entitlements',()=>{
  const team=five();
  const freeIds=new Set(freeLibrary.characters.map(item=>item.characterId));
  team.members=[createMember(5),...catalog.characters.filter(character=>!freeIds.has(character.id)).slice(0,4).map(character=>createMember(character.id))];
  const olderPolicy=structuredClone(policy);olderPolicy.id='owner-450-v3';olderPolicy.version=3;olderPolicy.unitPrices.characterCopy=17000;
  Object.assign(team.members[0].equipment[1],{rarity:'SSR',seriesId:12,level:450});
  const oldExport=createExport(team,catalog,olderPolicy,freeLibrary);
  const current=parseImport(oldExport,catalog,policy,freeLibrary);
  assert.deepEqual(current.team,oldExport.team);
  assert.equal(current.costBreakdown.resourceDiamonds,oldExport.costBreakdown.resourceDiamonds);
  assert.equal(current.costBreakdown.characterCosts[0].chargedCopies,0);
  assert.equal(current.costBreakdown.characterDiamonds,current.costBreakdown.characterCosts.reduce((sum,item)=>sum+item.chargedCopies*12000,0));
  assert.equal(oldExport.costBreakdown.characterDiamonds-current.costBreakdown.characterDiamonds,current.costBreakdown.characterCosts.reduce((sum,item)=>sum+item.chargedCopies*5000,0));
  assert.equal(createExport(current.team,catalog,policy,freeLibrary).policySnapshot.baseline.curse.name,'诅咒·时之枷锁');
});
test('actual gear data computes full reinforcement investment and team-wide free allowance',()=>{
  const team=five();
  for(const member of team.members) for(const gear of member.equipment){Object.assign(gear,{rarity:'SSR',seriesId:12,level:450,reinforcementLevel:450});}
  const result=calculateTeam(team,catalog,policy);
  assert.equal(result.resources.reinforcementMedicine.consumed,147315);
  assert.equal(result.resources.reinforcementMedicine.baseAllowance,60000);
  assert.equal(result.resources.reinforcementMedicine.blessingAllowance,40000);
  assert.equal(result.resources.reinforcementMedicine.freeAllowance,100000);
  assert.equal(result.resources.reinforcementMedicine.charged,47315);
  assert.equal(result.resources.reinforcementMedicine.diamonds,473150);
  const next=structuredClone(policy);next.allowances.reinforcementMedicine=147315;
  assert.equal(calculateTeam(team,catalog,next).resources.reinforcementMedicine.diamonds,0);
});
test('actual catalog rejects SSR exclusive450 and permits exclusive240',()=>{
  const team=five(); const gear=team.members[0].equipment[0];
  Object.assign(gear,{rarity:'SSR',seriesId:12,weaponKind:'exclusive',level:450});
  assert.equal(validateTeam(team,catalog,policy).valid,false);
  gear.level=240;
  assert.equal(validateTeam(team,catalog,policy).valid,true);
  assert.equal(calculateTeam(team,catalog,policy).resources.exclusiveFragments.consumed,275);
});
test('published LR normal and exclusive costs include the distinct leaf evolution chains',()=>{
  const team=five();const member=team.members[0];member.rarity='LR5';
  Object.assign(member.equipment[0],{rarity:'LR',seriesId:14,weaponKind:'exclusive',level:450});
  Object.assign(member.equipment[1],{rarity:'LR',seriesId:14,level:450});
  const result=calculateTeam(team,catalog,policy);
  assert.equal(result.resources.lifeTreeDew.consumed,115);
  assert.equal(result.resources.lifeTreeDew.diamonds,46000);
});
test('sacred experience is cumulative and overage charges rather than blocking export',()=>{
  const team=five();
  for(const member of team.members){const gear=member.equipment[0];Object.assign(gear,{rarity:'UR',seriesId:13,weaponKind:'exclusive',level:450,legendSacredTreasureLevel:40});}
  const result=calculateTeam(team,catalog,policy);
  assert.equal(result.resources.holySteel.consumed,3905);
  assert.equal(result.resources.holySteel.charged,405);
  assert.equal(result.resources.holySteel.diamonds,40500);
  assert.doesNotThrow(()=>createExport(team,catalog,policy));
});
test('ordinary rune stock permits three level11 runes per category across the whole team',()=>{
  const team=five();
  for(const member of team.members) Object.assign(member.equipment[0],{rarity:'SSR',seriesId:12,level:450});
  for(const member of team.members.slice(0,3)) member.equipment[0].runes[0]={categoryId:4,level:11};
  const result=calculateTeam(team,catalog,policy);
  assert.equal(result.resources.unidentifiedRune7.consumed,0);
  assert.equal(result.fixedRuneInventory.find(item=>item.categoryId===4).remaining,0);
  team.members[3].equipment[0].runes[0]={categoryId:4,level:11};
  assert.equal(validateTeam(team,catalog,policy).valid,false);
  team.members[3].equipment[0].runes[0]={categoryId:6,level:11};
  assert.equal(validateTeam(team,catalog,policy).valid,true);
  team.members[3].equipment[0].runes[0].level=10;
  assert.equal(validateTeam(team,catalog,policy).valid,true);
  team.members[3].equipment[0].runes[0].level=9;
  assert.equal(validateTeam(team,catalog,policy).valid,false);
});
test('published free library applies permanent LR5 and LR caps with named limited characters free at SR only',()=>{
  const team=createTeam();
  team.members=[5,41,100,124,86].map(createMember);
  ['LR5','LR5','LR','LR5','SR'].forEach((rarity,index)=>{team.members[index].rarity=rarity;});
  const result=calculateTeam(team,catalog,policy,freeLibrary);
  assert.deepEqual(result.characterCosts.map(item=>item.chargedCopies),[0,12,7,19,0]);
  assert.equal(result.characterDiamonds,38*12000);
  assert.equal(result.freeLibraryVersion,2);
  const exported=createExport(team,catalog,policy,freeLibrary);
  exported.freeLibrarySnapshot.characters=catalog.characters.map(character=>({characterId:character.id,rarity:'LR5'}));
  assert.equal(parseImport(exported,catalog,policy,freeLibrary).costBreakdown.characterDiamonds,38*12000);
});
test('published free weapons cover SSR240 and SSR180 crafting and retain exact crystal equivalents above the entitlement',()=>{
  const team=createTeam();
  team.members=[124,96,86,85,100].map(createMember);
  for(const member of team.members){
    const entitlement=freeLibrary.exclusiveWeapons.find(item=>item.characterId===member.characterId);
    Object.assign(member.equipment[0],{rarity:'SSR',seriesId:12,weaponKind:'exclusive',level:entitlement.level});
  }
  const result=calculateTeam(team,catalog,policy,freeLibrary);
  assert.equal(result.totalDiamonds,0);
  assert.deepEqual(result.exclusiveWeaponCosts.map(item=>item.freeMagicCrystals),[82.5,82.5,82.5,24,24]);
  assert.ok(result.exclusiveWeaponCosts.every(item=>item.diamonds===0));
  team.members[3].equipment[0].level=240;
  const upgraded=calculateTeam(team,catalog,policy,freeLibrary);
  assert.equal(upgraded.resources.exclusiveFragments.charged,195);
  assert.equal(upgraded.exclusiveWeaponCosts[3].chargedMagicCrystals,58.5);
  assert.equal(upgraded.totalDiamonds,8983.2);
  assert.equal(upgraded.exclusiveWeaponCosts[3].diamonds,8983.2);
  assert.ok(Math.abs(policy.unitPrices.exclusiveFragments-policy.conversions.magicCrystalPrice*3/10)<1e-10);
});
test('published level10 and level11 ordinary rune allowances cannot borrow each other stock',()=>{
  const team=five();
  for(const member of team.members.slice(0,3)){
    Object.assign(member.equipment[0],{rarity:'SSR',seriesId:12,level:450});
    Object.assign(member.equipment[1],{rarity:'SSR',seriesId:12,level:450});
    member.equipment[0].runes[0]={categoryId:4,level:11};
    member.equipment[1].runes[0]={categoryId:4,level:10};
  }
  const result=calculateTeam(team,catalog,policy,freeLibrary);
  assert.deepEqual(result.fixedRuneInventory.filter(item=>item.categoryId===4).map(item=>[item.level,item.used,item.remaining]),[[11,3,0],[10,3,0]]);
  Object.assign(team.members[3].equipment[0],{rarity:'SSR',seriesId:12,level:450});
  team.members[3].equipment[0].runes[0]={categoryId:4,level:10};
  assert.equal(validateTeam(team,catalog,policy,{freeLibrary}).errors.some(item=>item.code==='FIXED_RUNE_STOCK_EXCEEDED'&&item.path.endsWith('.10')),true);
});
test('free UR weapon baselines include their fifteen leaves and LR upgrades charge the additional fifty',()=>{
  const team=createTeam();team.members=[124,96,86,85,100].map(createMember);
  for(const member of team.members){const free=freeLibrary.exclusiveWeapons.find(item=>item.characterId===member.characterId);Object.assign(member.equipment[0],{rarity:free.rarity,seriesId:free.rarity==='UR'?13:12,weaponKind:'exclusive',level:free.level});}
  const free=calculateTeam(team,catalog,policy,freeLibrary);
  assert.equal(free.totalDiamonds,0);
  assert.equal(free.resources.lifeTreeDew.consumed,45);
  assert.equal(free.resources.lifeTreeDew.freeLibraryCredit,45);
  team.members[0].rarity='LR5';Object.assign(team.members[0].equipment[0],{rarity:'LR',seriesId:14,level:300});
  const evolved=calculateTeam(team,catalog,policy,freeLibrary);
  assert.equal(evolved.resources.lifeTreeDew.charged,50);
  assert.equal(evolved.exclusiveWeaponCosts[0].chargedLifeTreeDew,50);
});
test('legacy manual policy can price real free UR300 anchors and paid outside upgrades',()=>{
  const policy=manualPolicy();
  const team=createTeam();team.members=[124,96,86,85,100].map(createMember);
  Object.assign(team.members[0].equipment[0],{rarity:'UR',seriesId:13,weaponKind:'exclusive',level:300,syncSlot:1});
  const base=calculateTeam(team,catalog,policy,freeLibrary);
  assert.equal(base.weaponSync.effectiveLevels[0],300);
  assert.deepEqual(base.weaponSync.slots[0].anchors.map(item=>item.characterId),[8,27]);
  assert.equal(base.totalDiamonds,4837.11);
  team.weaponSources=[8,27].map(characterId=>({characterId,characterRarity:'SR',rarity:'UR',level:450}));
  const elevated=calculateTeam(team,catalog,policy,freeLibrary);
  assert.equal(elevated.weaponSync.effectiveLevels[0],450);
  assert.equal(elevated.exclusiveWeaponCosts[0].level,300);
  assert.equal(elevated.exclusiveWeaponCosts[0].chargedFragments,105);
  assert.equal(elevated.exclusiveWeaponCosts[0].syncSavedFragments,570);
  assert.equal(elevated.weaponSourceCosts[0].diamonds,26258.58);
  assert.equal(elevated.weaponSourceCosts[1].diamonds,26258.58);
  assert.equal(elevated.resources.lifeTreeDew.charged,0);
  assert.equal(elevated.totalDiamonds,57354.27);
  Object.assign(team.members[1].equipment[0],{rarity:'UR',seriesId:13,weaponKind:'exclusive',level:300,syncSlot:2});
  assert.equal(deriveWeaponSync(team,catalog,policy,freeLibrary).slots[1].available,false);
  team.weaponSources.push({characterId:26,characterRarity:'SR',rarity:'UR',level:400});
  assert.equal(deriveWeaponSync(team,catalog,policy,freeLibrary).slots[1].effectiveLevel,400);
  assert.equal(validateTeam(team,catalog,policy,{freeLibrary}).valid,true);
  const exported=createExport(team,catalog,policy,freeLibrary);
  exported.costBreakdown.weaponSync.effectiveLevels[1]=450;
  assert.equal(parseImport(exported,catalog,policy,freeLibrary).costBreakdown.weaponSync.effectiveLevels[1],400);
});
test('legacy manual borrowed UR gift uses its physical owner and can serve as an equipped sync anchor',()=>{
  const policy=manualPolicy();
  const team=createTeam();team.members=[153,96,86,85,100].map(createMember);
  Object.assign(team.members[0].equipment[0],{rarity:'UR',seriesId:13,weaponKind:'exclusive',weaponOwnerCharacterId:27,level:300});
  const borrowed=calculateTeam(team,catalog,policy,freeLibrary);
  assert.equal(borrowed.totalDiamonds,0);
  assert.equal(borrowed.exclusiveWeaponCosts[0].weaponOwnerCharacterId,27);
  assert.equal(borrowed.exclusiveWeaponCosts[0].ownExclusiveSkillActive,false);
  assert.equal(borrowed.weaponSync.anchors.find(item=>item.characterId===27).source,'team');
  team.members[0].equipment[0].level=450;
  Object.assign(team.members[1].equipment[0],{rarity:'UR',seriesId:13,weaponKind:'exclusive',level:300,syncSlot:1});
  assert.equal(calculateTeam(team,catalog,policy,freeLibrary).weaponSync.effectiveLevels[1],300);
  team.weaponSources=[{characterId:8,characterRarity:'SR',rarity:'UR',level:450}];
  const elevated=calculateTeam(team,catalog,policy,freeLibrary);
  assert.equal(elevated.weaponSync.effectiveLevels[1],450);
  assert.deepEqual(elevated.weaponSync.slots[0].anchors.map(item=>item.characterId),[8,27]);
  assert.equal(elevated.totalDiamonds,57354.27);
  const exported=createExport(team,catalog,policy,freeLibrary);
  assert.equal(exported.team.members[0].equipment[0].weaponOwnerCharacterId,27);
  assert.equal(parseImport(exported,catalog,policy,freeLibrary).costBreakdown.exclusiveWeaponCosts[0].ownExclusiveSkillActive,false);
  team.weaponSources.push({characterId:27,characterRarity:'SR',rarity:'UR',level:450});
  assert.equal(validateTeam(team,catalog,policy,{freeLibrary}).errors.some(item=>item.code==='DUPLICATE_WEAPON_SOURCE'),true);
});
test('actual automatic policy discounts the third450 weapon only, with crafting300 and all actual levels450',()=>{
  assert.equal(policy.version,6);
  assert.deepEqual(policy.weaponSync,{mode:'automatic',targetLevel:450,billedLevel:300,discountedOrdinals:[3,6]});
  const team=createTeam();team.members=[124,96,86,85,100].map(createMember);
  for(const member of team.members)Object.assign(member.equipment[0],{rarity:'UR',seriesId:13,weaponKind:'exclusive',level:450,reinforcementLevel:450});
  const auto=calculateTeam(team,catalog,policy,freeLibrary);
  const full=calculateTeam(team,catalog,manualPolicy(),freeLibrary);
  assert.deepEqual(auto.exclusiveWeaponCosts.map(item=>item.level),[450,450,450,450,450]);
  assert.deepEqual(auto.exclusiveWeaponCosts.map(item=>item.billedLevel),[450,450,300,450,450]);
  assert.deepEqual(auto.exclusiveWeaponCosts.map(item=>item.fragments),[950,950,380,950,950]);
  assert.equal(auto.exclusiveWeaponCosts[2].levelDiscountFragments,570);
  assert.equal(auto.exclusiveWeaponCosts[2].levelDiscountDiamonds,26258.58);
  assert.equal(Math.round((full.totalDiamonds-auto.totalDiamonds)*100)/100,26258.58);
  assert.deepEqual(auto.resources.lifeTreeDew,full.resources.lifeTreeDew);
  assert.deepEqual(auto.resources.reinforcementMedicine,full.resources.reinforcementMedicine);
  assert.equal(deriveWeaponPricing(createTeam(),catalog,policy,freeLibrary).qualifyingCount,0);
  assert.equal(auto.weaponPricing.discountCount,1);
});
test('real v4 synchronized import migrates its verified levels and removes sources before v5 automatic pricing',()=>{
  const team=createTeam();team.members=[124,96,86,85,100].map(createMember);
  Object.assign(team.members[0].equipment[0],{rarity:'UR',seriesId:13,weaponKind:'exclusive',level:300,syncSlot:1,reinforcementLevel:450});
  team.weaponSources=[8,27].map(characterId=>({characterId,characterRarity:'SR',rarity:'UR',level:450}));
  const old=createExport(team,catalog,manualPolicy(),freeLibrary);
  old.costBreakdown.weaponSync.effectiveLevels[0]=999;
  old.costBreakdown.totalDiamonds=0;
  const imported=parseImport(old,catalog,policy,freeLibrary);
  assert.equal(imported.team.members[0].equipment[0].level,450);
  assert.equal(imported.team.members[0].equipment[0].reinforcementLevel,450);
  assert.equal(imported.team.members[0].equipment[0].syncSlot,0);
  assert.deepEqual(imported.team.weaponSources,[]);
  assert.deepEqual(imported.costBreakdown.weaponSourceCosts,[]);
  assert.equal(imported.costBreakdown.weaponPricing.qualifyingCount,1);
  assert.equal(imported.costBreakdown.exclusiveWeaponCosts[0].billedLevel,450);
  assert.equal(imported.warnings.some(message=>/旧同步武器/.test(message)),true);
});
