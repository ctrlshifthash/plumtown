/* ============================================================
   LifeSim — Cloud / Community (data layer)
   The "multiplayer" layer: a shared neighbourhood of players, each
   with their own house, that you can browse and visit.

     • If window.LIFESIM_CONFIG.cloudApi is set → REAL shared world
       (talks to the backend in /server). Everyone who joins sees
       the same players and can visit each other's real houses.
     • Otherwise → offline single-player with a SIMULATED community
       (locally generated neighbours), so the UI works with no server.

   The UI only calls listPlayers()/getWorld()/publish()/signIn(), so
   switching modes never touches the dashboard or game.
   Attaches to window.LifeSim.Cloud.
   ============================================================ */

(function () {
  'use strict';

  const LS = window.LifeSim;
  const COMMUNITY_KEY = 'lifesim_community_v1'; // local simulated neighbours
  const IDENTITY_KEY = 'lifesim_identity_v1';   // {id, apiKey, name} for remote

  function apiBase() {
    const c = window.LIFESIM_CONFIG;
    return (c && c.cloudApi) ? String(c.cloudApi).replace(/\/+$/, '') : '';
  }
  function isRemote() { return !!apiBase(); }

  const NEIGHBOR_NAMES = [
    'Mia Chen', 'Noah Patel', 'Ava Rossi', 'Liam Bauer', 'Zoe Nakamura',
    'Ethan Clarke', 'Layla Khan', 'Oscar Moreno', 'Iris Lindqvist', 'Kai Okafor',
    'Nora Vasquez', 'Felix Brun', 'Maya Santos', 'Theo Walsh', 'Lena Park', 'Diego Marín'
  ];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const ri = (n) => Math.floor(Math.random() * n);

  // ---- identity (remote) ----
  function me() { try { return JSON.parse(localStorage.getItem(IDENTITY_KEY)) || null; } catch (e) { return null; } }
  function setMe(v) { try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(v)); } catch (e) { /* */ } }
  function signOut() { try { localStorage.removeItem(IDENTITY_KEY); } catch (e) { /* */ } }

  // ---- snapshots ----
  function activeSim(world) {
    if (!world.sims || !world.sims.length) return null;
    return world.sims.find((s) => s.id === world.activeSimId) || world.sims[0];
  }
  function houseOf(lot) {
    if (!lot) return null;
    return {
      size: lot.size, floor: lot.floor, wall: lot.wall, walls: lot.walls || [],
      furniture: (lot.furniture || []).map((f) => ({ x: f.x, y: f.y, size: f.size, cat: f.cat, id: f.id }))
    };
  }
  // Compact, render-everything snapshot of a world (for publishing / visiting).
  function worldSnapshot(state) {
    const sim = activeSim(state);
    return {
      player: { name: state.player.name, level: state.player.level },
      lot: state.lot,
      sims: sim ? [sim] : [],
      npcs: [],
      activeSimId: sim ? sim.id : null,
      time: state.time
    };
  }
  function summaryOf(state) {
    const sim = activeSim(state);
    return {
      name: state.player.name,
      sim: sim ? { skinTone: sim.skinTone, hairColor: sim.hairColor, outfitColor: sim.outfitColor } : null,
      houseValue: state.lot ? (state.lot.value || 0) : 0,
      furniture: state.lot ? (state.lot.furniture || []).length : 0,
      level: state.player.level || 1,
      house: houseOf(state.lot)
    };
  }

  /* ================= LOCAL (simulated) ================= */

  function readStore() { try { return JSON.parse(localStorage.getItem(COMMUNITY_KEY)) || null; } catch (e) { return null; } }
  function writeStore(o) { try { localStorage.setItem(COMMUNITY_KEY, JSON.stringify(o)); } catch (e) { /* */ } }

  function generateNeighborWorld(name) {
    const st = structuredClone(LS.DEFAULT_STATE);
    st.player = Object.assign({}, st.player, { name: name });
    const sim = LS.createSim({
      name: name, skinTone: pick(LS.SKIN_TONES), hairColor: pick(LS.HAIR_COLORS), outfitColor: pick(LS.OUTFIT_COLORS),
      traits: [pick(LS.TRAITS), pick(LS.TRAITS)].filter((v, i, a) => a.indexOf(v) === i),
      aspiration: pick(Object.keys(LS.ASPIRATIONS))
    });
    sim.money = 1000 + ri(6000);
    st.sims = [sim]; st.activeSimId = sim.id;
    st.lot.floor = pick(Object.keys(LS.FLOOR_STYLES));
    st.lot.wall = pick(Object.keys(LS.WALL_STYLES));
    LS.Build.ensureLot(st);
    const catalog = LS.Build.CATALOG;
    const count = 9 + ri(7);
    for (let i = 0; i < count; i++) {
      const item = pick(catalog);
      for (let t = 0; t < 10; t++) {
        const x = ri(st.lot.size.w - item.size.w + 1), y = ri(st.lot.size.h - item.size.h + 1);
        if (LS.Build.canPlace(st, item, x, y)) { LS.Build.placeItem(st, item, x, y); break; }
      }
    }
    LS.Movement.ensureSimTile(st, sim); sim.px = sim.tile.x; sim.py = sim.tile.y;
    return st;
  }

  function ensureSeeded(force) {
    let store = readStore();
    if (store && store.players && store.players.length && !force) return store;
    const names = NEIGHBOR_NAMES.slice().sort(() => Math.random() - 0.5).slice(0, 8);
    store = { players: names.map((n) => ({ id: 'npc_' + LS.uid(), world: generateNeighborWorld(n) })) };
    writeStore(store);
    return store;
  }
  function selfWorld() { return LS.load(); }

  function localSummary(id, state, isYou) {
    const s = summaryOf(state);
    return Object.assign({ id: id, isYou: !!isYou, online: isYou ? true : Math.random() < 0.6 }, s);
  }
  function listPlayersLocal() {
    const store = ensureSeeded();
    const out = [localSummary('you', selfWorld(), true)];
    store.players.forEach((p) => out.push(localSummary(p.id, p.world, false)));
    return out;
  }
  function getWorldLocal(id) {
    if (id === 'you') return selfWorld();
    const store = ensureSeeded();
    const p = store.players.find((x) => x.id === id);
    return p ? p.world : null;
  }

  /* ================= REMOTE (real backend) ================= */

  function apiUrl(path) { return apiBase() + '/api' + path; }
  async function apiGet(path) {
    const r = await fetch(apiUrl(path));
    if (!r.ok) throw new Error('GET ' + path + ' ' + r.status);
    return r.json();
  }
  async function apiGetAuth(path) {
    const headers = {};
    if (me()) headers['x-api-key'] = me().apiKey;
    const r = await fetch(apiUrl(path), { headers });
    if (!r.ok) throw new Error('GET ' + path + ' ' + r.status);
    return r.json();
  }
  async function apiPost(path, body, auth) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && me()) headers['x-api-key'] = me().apiKey;
    const r = await fetch(apiUrl(path), { method: 'POST', headers, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error('POST ' + path + ' ' + r.status);
    return r.json();
  }

  // ---- public, mode-agnostic API (all async) ----

  async function signIn(name) {
    if (!isRemote()) return null;
    const r = await apiPost('/register', { name: name });
    const ident = { id: r.id, apiKey: r.apiKey, name: r.name };
    setMe(ident);
    await publish(selfWorld()); // put your house on the shared map straight away
    return ident;
  }

  // Make sure the player has a shared-world account (needed for real rewards:
  // daily, quests, milestones, withdrawals). Registers once, silently; concurrent
  // callers share one in-flight request so we never create duplicate accounts.
  let _signInPromise = null;
  async function ensureSignedIn() {
    if (!isRemote()) return null;
    if (me()) return me();
    if (!_signInPromise) _signInPromise = signIn(selfWorld().player.name || 'Player').catch(() => null);
    return (await _signInPromise) || me();
  }

  async function publish(state) {
    if (!isRemote() || !me()) return false;
    try {
      await apiPost('/world', { summary: summaryOf(state), world: worldSnapshot(state) }, true);
      return true;
    } catch (e) { return false; }
  }

  async function listPlayers() {
    if (!isRemote()) return listPlayersLocal();
    const data = await apiGetAuth('/players'); // authed so the server can hide private/blocked houses
    const myId = me() && me().id;
    return (data.players || []).map((p) => Object.assign({}, p, { isYou: p.id === myId }));
  }

  async function getWorld(id) {
    if (id === 'you') return selfWorld();
    if (!isRemote()) return getWorldLocal(id);
    try { const data = await apiGetAuth('/world/' + encodeURIComponent(id)); return data.world; }
    catch (e) { return null; }
  }

  // House visitor controls — make your house private, block/unblock a player.
  async function setHouseControl(patch) {
    if (!isRemote() || !me()) return { ok: false };
    try { return await apiPost('/house/control', patch || {}, true); } catch (e) { return { ok: false }; }
  }
  function blockPlayer(id) { return setHouseControl({ block: id }); }
  function unblockPlayer(id) { return setHouseControl({ unblock: id }); }
  function setHousePrivate(v) { return setHouseControl({ private: !!v }); }

  async function heartbeat() { if (isRemote() && me()) { try { await apiPost('/heartbeat', {}, true); } catch (e) { /* */ } } }

  /* ---- house preview (sync) — accepts a world, a summary, or a lot ---- */
  function housePreviewHTML(src, px) {
    px = px || 150;
    const lot = (src && src.lot) ? src.lot : (src && src.house) ? src.house : src;
    if (!lot || !lot.size) return '';
    const W = lot.size.w, H = lot.size.h;
    const cell = Math.floor(Math.min(px / W, (px * 0.66) / H));
    const fw = W * cell, fh = H * cell;
    const floorCol = (LS.FLOOR_STYLES[lot.floor] && LS.FLOOR_STYLES[lot.floor].color) || '#caa472';
    const wallCol = (LS.WALL_STYLES[lot.wall] && LS.WALL_STYLES[lot.wall].color) || '#3a3550';
    let inner = '';
    (lot.walls || []).forEach((w) => {
      inner += '<div style="position:absolute;left:' + (w.x * cell) + 'px;top:' + (w.y * cell) + 'px;width:' + cell + 'px;height:' + cell + 'px;background:' + wallCol + '"></div>';
    });
    (lot.furniture || []).forEach((f) => {
      const sp = (LS.SPRITES && f.id) ? LS.SPRITES[f.id] : null;
      if (sp) {
        const sw = sp.w * cell, sh = sp.h * cell;
        const left = f.x * cell + (f.size.w * cell - sw) / 2;
        const top = (f.y + f.size.h) * cell - sh;
        inner += '<img src="' + sp.src + '" style="position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + sw + 'px;height:' + sh + 'px;image-rendering:pixelated">';
      } else {
        inner += '<div style="position:absolute;left:' + (f.x * cell + 1) + 'px;top:' + (f.y * cell + 1) + 'px;width:' + (f.size.w * cell - 2) + 'px;height:' + (f.size.h * cell - 2) + 'px;background:' + catColor(f.cat) + ';border-radius:2px"></div>';
      }
    });
    return '<div class="house-preview" style="width:' + fw + 'px;height:' + fh + 'px;background:' + floorCol + '">' + inner + '</div>';
  }
  function catColor(cat) {
    return ({ bed: '#7c8cff', food: '#ff8a5c', bath: '#5cd0ff', comfort: '#5cffa6', fun: '#b65cff', skill: '#ffcf5c', decor: '#2ee6a6' })[cat] || '#9aa0ad';
  }

  /* ---- neighbourhood chat (real backend, or local demo when offline) ---- */
  const CHAT_KEY = 'lifesim_chat_v1';
  function readChatLocal() { try { return JSON.parse(localStorage.getItem(CHAT_KEY)) || null; } catch (e) { return null; } }
  function writeChatLocal(a) { try { localStorage.setItem(CHAT_KEY, JSON.stringify(a.slice(-100))); } catch (e) { /* */ } }
  function seedChat() {
    const now = Date.now();
    return [
      { id: LS.uid(), name: 'Mia Chen',   text: 'anyone else grinding cooking today? 🍳', at: now - 720000 },
      { id: LS.uid(), name: 'Kai Okafor', text: 'gm plumtown ☀️', at: now - 540000 },
      { id: LS.uid(), name: 'Noah Patel', text: 'just got promoted to Engineer III, lets gooo', at: now - 300000 },
      { id: LS.uid(), name: 'Ava Rossi',  text: 'selling my old sofa cheap — come visit 🛋️', at: now - 120000 }
    ];
  }
  function chatLocal() { let a = readChatLocal(); if (!a) { a = seedChat(); writeChatLocal(a); } return a; }

  async function getChat(limit) {
    if (!isRemote()) return chatLocal();
    try { const d = await apiGet('/chat?limit=' + (limit || 50)); return d.messages || []; }
    catch (e) { return []; }
  }
  async function sendChat(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    if (!text) return null;
    if (!isRemote() || !me()) {
      const a = chatLocal();
      const m = { id: LS.uid(), name: (selfWorld().player.name || 'You'), text: text, at: Date.now(), isYou: true };
      a.push(m); writeChatLocal(a); return m;
    }
    try { const r = await apiPost('/chat', { text: text }, true); return r.message || null; }
    catch (e) { return null; }
  }

  /* ---- marketplace (real backend, or local demo when offline) ---- */
  const MARKET_KEY = 'lifesim_market_v1';
  const EARN_KEY = 'lifesim_market_earn_v1';
  function readMarketLocal() { try { return JSON.parse(localStorage.getItem(MARKET_KEY)) || null; } catch (e) { return null; } }
  function writeMarketLocal(a) { try { localStorage.setItem(MARKET_KEY, JSON.stringify(a.slice(-200))); } catch (e) { /* */ } }
  function seedMarket() {
    const now = Date.now();
    const cat = (LS.Build && LS.Build.CATALOG) ? LS.Build.CATALOG.slice() : [];
    const names = ['Ava Rossi', 'Kai Okafor', 'Mia Chen', 'Noah Patel'];
    const sample = cat.sort(() => Math.random() - 0.5).slice(0, 4);
    return sample.map((it, i) => ({
      id: LS.uid(), sellerId: 'npc_' + i, sellerName: names[i % names.length],
      itemId: it.id, itemName: it.name, itemIcon: it.icon,
      price: Math.max(20, Math.floor((it.cost || 100) * 0.6)), createdAt: now - (i + 1) * 120000
    }));
  }
  function marketLocal() { let a = readMarketLocal(); if (!a) { a = seedMarket(); writeMarketLocal(a); } return a; }
  function earnLocal() { try { return Number(localStorage.getItem(EARN_KEY)) || 0; } catch (e) { return 0; } }
  function setEarnLocal(v) { try { localStorage.setItem(EARN_KEY, String(v)); } catch (e) { /* */ } }

  async function getMarket(limit) {
    if (!isRemote()) return { listings: marketLocal().slice().reverse().slice(0, limit || 100), earnings: earnLocal(), me: 'you' };
    try { const d = await apiGetAuth('/market?limit=' + (limit || 100)); return { listings: d.listings || [], earnings: d.earnings || 0, me: d.me || null }; }
    catch (e) { return { listings: [], earnings: 0, me: null }; }
  }
  async function listItem(item) {
    if (!isRemote() || !me()) {
      const a = marketLocal();
      const l = { id: LS.uid(), sellerId: 'you', sellerName: (selfWorld().player.name || 'You'), itemId: item.itemId, itemName: item.itemName, itemIcon: item.itemIcon, price: item.price, createdAt: Date.now() };
      a.push(l); writeMarketLocal(a); return { ok: true, listing: l };
    }
    try { return await apiPost('/market/list', item, true); } catch (e) { return { ok: false, reason: 'network' }; }
  }
  async function buyItem(id) {
    if (!isRemote() || !me()) {
      const a = marketLocal(); const i = a.findIndex((l) => l.id === id);
      if (i < 0) return { ok: false, reason: 'gone' };
      if (a[i].sellerId === 'you') return { ok: false, reason: 'own' };
      const listing = a.splice(i, 1)[0]; writeMarketLocal(a); return { ok: true, listing };
    }
    try { return await apiPost('/market/buy', { id: id }, true); } catch (e) { return { ok: false, reason: 'network' }; }
  }
  async function cancelMarketListing(id) {
    if (!isRemote() || !me()) {
      const a = marketLocal(); const i = a.findIndex((l) => l.id === id && l.sellerId === 'you');
      if (i < 0) return { ok: false, reason: 'gone' };
      const listing = a.splice(i, 1)[0]; writeMarketLocal(a); return { ok: true, listing };
    }
    try { return await apiPost('/market/cancel', { id: id }, true); } catch (e) { return { ok: false, reason: 'network' }; }
  }
  async function collectEarnings() {
    if (!isRemote() || !me()) { const amt = earnLocal(); setEarnLocal(0); return { ok: true, amount: amt }; }
    try { return await apiPost('/market/collect', {}, true); } catch (e) { return { ok: false, reason: 'network' }; }
  }
  async function featureMarketListing(id) {
    if (!isRemote() || !me()) {
      const a = marketLocal(); const l = a.find((x) => x.id === id && x.sellerId === 'you');
      if (!l) return { ok: false, reason: 'not_yours' };
      l.featured = Date.now(); writeMarketLocal(a); return { ok: true, listing: l };
    }
    try { return await apiPost('/market/feature', { id: id }, true); } catch (e) { return { ok: false, reason: 'network' }; }
  }
  async function getLeaderboard() {
    const empty = { richest: [], earners: [], visited: [] };
    if (!isRemote()) return empty;
    try { const d = await apiGet('/leaderboard'); return (d && d.leaderboard) || empty; }
    catch (e) { return empty; }
  }

  // $PLUM holder-tier badge icons (key → emoji) shown in chat / community.
  const TIER_ICONS = { lord: '👑', duke: '🏰', baron: '🏯', homestead: '🏡', orchard: '🌳', grove: '🍃', sapling: '🌿', sprout: '🌱' };
  function tierBadge(key) { return (key && TIER_ICONS[key]) || ''; }

  LS.Cloud = {
    isRemote, me, signIn, ensureSignedIn, signOut, publish, heartbeat, tierBadge,
    listPlayers, getWorld,                 // async, mode-agnostic
    sendChat, getChat,                     // neighbourhood chat
    getMarket, listItem, buyItem, cancelListing: cancelMarketListing, collectEarnings, featureListing: featureMarketListing, // marketplace
    getLeaderboard, // leaderboards
    setHouseControl, blockPlayer, unblockPlayer, setHousePrivate, // house visitor controls
    listPlayersLocal, getWorldLocal, ensureSeeded, selfWorld, generateNeighborWorld, // local/test
    housePreviewHTML, summaryOf, worldSnapshot
  };

  // Auto-register on first load (remote mode) so real rewards work without the
  // player ever hunting for the Community "Join" button.
  ensureSignedIn();
})();
