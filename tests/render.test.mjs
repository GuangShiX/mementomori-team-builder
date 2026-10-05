import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'vite';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createTeam,createMember} from '../src/domain.mjs';
const catalog=JSON.parse(await readFile(new URL('../public/data/catalog.json',import.meta.url)));
const policy=JSON.parse(await readFile(new URL('../public/data/pricing-policy.json',import.meta.url)));

test('production UI renders the shipped empty and restored five-member draft without a browser',async()=>{
  const server=await createServer({server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'});
  const original=globalThis.localStorage;
  try{
    const {default:App}=await server.ssrLoadModule('/src/App.jsx');
    const empty=renderToStaticMarkup(React.createElement(App,{catalog,policy}));
    assert.match(empty,/我的配队/);
    assert.match(empty,/搜索角色/);
    assert.match(empty,/导出/);
    assert.doesNotMatch(empty,/NaN/);
    const team=createTeam();team.members=catalog.characters.slice(0,5).map(createMember);
    globalThis.localStorage={getItem:()=>JSON.stringify({schemaVersion:1,catalogVersion:catalog.version,team})};
    const restored=renderToStaticMarkup(React.createElement(App,{catalog,policy}));
    assert.match(restored,/85,000/);
    assert.match(restored,/索尔缇娜/);
    assert.match(restored,/100,000/);
    assert.doesNotMatch(restored,/NaN/);
    globalThis.localStorage={getItem:()=>JSON.stringify({schemaVersion:1,catalogVersion:'previous-public-catalog',team})};
    const migrated=renderToStaticMarkup(React.createElement(App,{catalog,policy}));
    assert.match(migrated,/85,000/,'a catalog update must not discard a valid draft');
  }finally{
    if(original===undefined) delete globalThis.localStorage;else globalThis.localStorage=original;
    await server.close();
  }
});
