// ジェスチャー後付けブックマークレット本体
// ページ内の <video> の playbackRate / currentTime を触るだけ（DRMには一切触らへん）
// もう一回ブックマークレットを押すとOFF
(() => {
  'use strict';
  const NS = '__gpbm';
  if (window[NS]) { window[NS].destroy(); return; }

  // ---------- 設定（gesture-player の初期値に合わせる） ----------
  const store = {
    get(k, d){ try { const x = localStorage.getItem('gpbm_' + k); return x === null ? d : JSON.parse(x); } catch(e){ return d; } },
    set(k, val){ try { localStorage.setItem('gpbm_' + k, JSON.stringify(val)); } catch(e){} }
  };
  const opt = { hold: store.get('hold', 2), skip: store.get('skip', 10), sens: store.get('sens', 12) };
  const HOLD_MS = 350, DOUBLE_MS = 210, MULTI_MS = 500, ZONE = 1 / 3;   // 上1/3＝巻き戻し、下2/3＝スキップ
  const HOLD_OPTS = [1.25, 1.5, 1.75, 2, 2.5, 3, 4];
  const SENS_OPTS = [[20, 'ひかえめ'], [12, 'ふつう'], [7, '敏感']];

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const rateLabel = r => (Math.round(r * 100) / 100) + 'x';
  const fmt = s => {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };

  // ---------- 動画を探す（shadow DOM・同じドメインのiframeの中も） ----------
  function collect(root, ox, oy, out, depth){
    if (depth > 4) return;
    root.querySelectorAll('video').forEach(v => out.push({ v, ox, oy }));
    root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) collect(el.shadowRoot, ox, oy, out, depth + 1); });
    root.querySelectorAll('iframe').forEach(f => {
      try {
        const d = f.contentDocument; if (!d) return;
        const r = f.getBoundingClientRect();
        collect(d, ox + r.left + f.clientLeft, oy + r.top + f.clientTop, out, depth + 1);
      } catch(e){}  // 別ドメインのiframeは中を見られへん
    });
  }
  function pickVideo(){
    const list = []; collect(document, 0, 0, list, 0);
    let best = null, bestScore = 0;
    for (const c of list) {
      const r = c.v.getBoundingClientRect(), area = r.width * r.height;
      if (area < 2000) continue;
      const score = area * (c.v.paused ? 1 : 3) * (c.v.readyState > 0 ? 2 : 1);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
  let cur = pickVideo();
  if (!cur) {
    const big = [...document.querySelectorAll('iframe')].some(f => { const r = f.getBoundingClientRect(); return r.width * r.height > 40000; });
    alert(big ? '動画が別ドメインの枠（iframe）の中にあって触られへんかった…' : '動画が見つからへんかった。再生を始めてからもう一回押してな');
    return;
  }
  const vid = () => cur && cur.v;

  // ---------- オーバーレイ（ページのCSSと混ざらんようにshadow DOMで） ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;';
  const sr = host.attachShadow({ mode:'open' });
  sr.innerHTML = `<style>
    :host { all:initial; }
    * { box-sizing:border-box; -webkit-user-select:none; user-select:none; -webkit-touch-callout:none;
        font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif; -webkit-tap-highlight-color:transparent; }
    #layer { position:absolute; inset:0; touch-action:none; pointer-events:auto; }
    #layer.pass { pointer-events:none; }
    #chip { position:absolute; right:16px; bottom:56px; pointer-events:none; text-align:right;
      color:rgba(255,255,255,.72); text-shadow:0 1px 3px rgba(0,0,0,.55);
      font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; opacity:0; transition:opacity .12s; white-space:nowrap; }
    #chip small { display:block; font-size:12px; font-weight:500; color:rgba(255,255,255,.6); margin-top:1px; }
    #chip.show { opacity:1; }
    #bar { position:absolute; left:8px; top:8px; display:flex; gap:6px; pointer-events:auto; opacity:0; transition:opacity .2s; }
    #bar.show, #bar.pin { opacity:1; }
    #bar.off { pointer-events:none; }
    #bar button { width:34px; height:34px; border-radius:17px; border:0; background:rgba(0,0,0,.55); color:#fff;
      font-size:15px; line-height:34px; padding:0; }
    #bar button.on { background:rgba(10,132,255,.85); }
    #panel { position:absolute; left:8px; top:48px; width:220px; max-height:calc(100% - 56px); overflow:auto; padding:10px 12px;
      border-radius:12px; background:rgba(28,28,30,.94); color:#fff; font-size:13px; pointer-events:auto; display:none; }
    #panel.open { display:block; }
    #panel label { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 0; }
    #panel select { font-size:14px; background:#3a3a3c; color:#fff; border:0; border-radius:8px; padding:4px 6px; }
    #panel p { margin:6px 0 0; font-size:11px; color:rgba(255,255,255,.55); line-height:1.5; }
  </style>
  <div id="layer"></div>
  <div id="chip"></div>
  <div id="bar">
    <button id="bSet" aria-label="設定">⚙︎</button>
    <button id="bPass" aria-label="ジェスチャー一時停止">👆</button>
    <button id="bFull" aria-label="画面いっぱい">⛶</button>
    <button id="bOff" aria-label="OFF">✕</button>
  </div>
  <div id="panel">
    <label>長押しの速度 <select id="sHold">${HOLD_OPTS.map(r => `<option value="${r}">${rateLabel(r)}</option>`).join('')}</select></label>
    <label>スキップ秒数 <select id="sSkip">${Array.from({ length:180 }, (_, i) => `<option value="${i + 1}">${i + 1}秒</option>`).join('')}</select></label>
    <label>スワイプ感度 <select id="sSens">${SENS_OPTS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
    <p>👆＝プレイヤー本来の操作に切替<br>⛶＝ページ内で画面いっぱい（iPhoneの全画面だとジェスチャーが効かへんため）</p>
  </div>`;
  document.documentElement.appendChild(host);
  const $ = id => sr.getElementById(id);
  const layer = $('layer'), chipEl = $('chip'), bar = $('bar'), panel = $('panel');
  $('sHold').value = opt.hold; $('sSkip').value = opt.skip; $('sSens').value = opt.sens;

  let chipTimer = null;
  function chip(main, sub, ms){
    chipEl.innerHTML = main + (sub ? `<small>${sub}</small>` : '');
    chipEl.classList.add('show'); clearTimeout(chipTimer);
    if (ms) chipTimer = setTimeout(() => chipEl.classList.remove('show'), ms);
  }
  const hideChip = d => { clearTimeout(chipTimer); chipTimer = setTimeout(() => chipEl.classList.remove('show'), d || 0); };

  let barTimer = null;
  function showBar(){ bar.classList.add('show'); clearTimeout(barTimer); barTimer = setTimeout(() => { if (!panel.classList.contains('open')) bar.classList.remove('show'); }, 2500); }

  // ---------- 動画の位置に追従 ----------
  let rect = { x:0, y:0, w:0, h:0 }, raf = 0, lastPick = 0;
  function track(t){
    raf = requestAnimationFrame(track);
    const v = vid();
    if (!v || !v.isConnected || (t - lastPick > 1500 && v.getBoundingClientRect().width < 2)) {   // 動画が作り直されたら探し直す
      lastPick = t; const n = pickVideo(); if (n) cur = n;
    }
    if (!cur) return;
    const r = cur.v.getBoundingClientRect(), f = cur.v.ownerDocument.defaultView.frameElement;
    let ox = 0, oy = 0;
    if (f) { try { const fr = f.getBoundingClientRect(); ox = fr.left + f.clientLeft; oy = fr.top + f.clientTop; } catch(e){} }
    const n = { x:r.left + ox, y:r.top + oy, w:r.width, h:r.height };
    if (n.x !== rect.x || n.y !== rect.y || n.w !== rect.w || n.h !== rect.h) {
      rect = n;
      host.style.left = n.x + 'px'; host.style.top = n.y + 'px'; host.style.width = n.w + 'px'; host.style.height = n.h + 'px';
    }
  }
  raf = requestAnimationFrame(track);

  // ---------- 1回タップはプレイヤーへそのまま渡す ----------
  function deepPoint(doc, x, y){
    let el = doc.elementFromPoint(x, y);
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; }
    if (el && el.tagName === 'IFRAME') {
      try { const d = el.contentDocument; if (d) { const r = el.getBoundingClientRect(); return deepPoint(d, x - r.left - el.clientLeft, y - r.top - el.clientTop); } } catch(e){}
    }
    return el ? { el, x, y } : null;
  }
  function forwardTap(cx, cy){
    host.style.visibility = 'hidden';
    const hit = deepPoint(document, cx, cy);
    host.style.visibility = '';
    if (!hit) return;
    const { el, x, y } = hit, w = el.ownerDocument.defaultView;
    const o = { bubbles:true, cancelable:true, composed:true, clientX:x, clientY:y, view:w, button:0 };
    const P = w.PointerEvent, M = w.MouseEvent;
    try { if (P) el.dispatchEvent(new P('pointerdown', { ...o, pointerType:'touch', isPrimary:true, pointerId:1 })); } catch(e){}
    try { el.dispatchEvent(new M('mousemove', o)); el.dispatchEvent(new M('mousedown', o)); } catch(e){}
    try { if (P) el.dispatchEvent(new P('pointerup', { ...o, pointerType:'touch', isPrimary:true, pointerId:1 })); } catch(e){}
    try { el.dispatchEvent(new M('mouseup', o)); el.dispatchEvent(new M('click', o)); } catch(e){}
  }

  // ---------- ジェスチャー ----------
  let s0 = null, st = 0, holdTimer = null, mode = null, holdWasPaused = false, savedRate = 1;
  let lastX = 0, lastT = 0, velS = 0, accum = 0;
  let lastTap = 0, lastZone = null, tapTimer = null, multiSkip = 0, multiTimer = null, multiZone = null;
  const local = t => ({ x:t.clientX - rect.x, y:t.clientY - rect.y, cx:t.clientX, cy:t.clientY });

  function endHold(){
    const v = vid(); if (!v) return;
    v.playbackRate = savedRate; hideChip();
    if (holdWasPaused) v.pause();
  }

  const onStart = e => {
    e.preventDefault();
    if (panel.classList.contains('open')) { panel.classList.remove('open'); $('bSet').classList.remove('on'); s0 = null; return; }
    if (e.touches.length > 1) {   // 2本指は何もしない（途中なら元に戻す）
      clearTimeout(holdTimer);
      if (mode === 'hold') endHold();
      if (mode === 'scrub') hideChip();
      mode = 'multi'; return;
    }
    s0 = local(e.touches[0]); st = Date.now(); mode = null;
    lastX = s0.x; lastT = performance.now(); velS = 0; accum = 0;
    holdTimer = setTimeout(() => {
      const v = vid();
      if (mode !== null || !v) return;
      mode = 'hold';
      holdWasPaused = v.paused; savedRate = v.playbackRate || 1;
      v.playbackRate = opt.hold;
      if (v.paused) v.play().catch(() => {});
      chip(`▶▶ ${rateLabel(opt.hold)}`, '長押し中');
    }, HOLD_MS);
  };

  const onMove = e => {
    e.preventDefault();
    if (!s0 || mode === 'multi' || mode === 'hold') return;
    const p = local(e.touches[0]), dx = p.x - s0.x, dy = p.y - s0.y, ax = Math.abs(dx), ay = Math.abs(dy);
    if (mode === null) {
      if (ax > 10 || ay > 10) clearTimeout(holdTimer);
      if (ax > 10 && ax >= ay * 0.7) { mode = 'scrub'; lastX = s0.x; }   // 左右＝シーク
      else if (ay > 10) { mode = 'none'; return; }                         // 縦は何もしない
      else return;
    }
    const v = vid();
    if (mode !== 'scrub' || !v || !v.duration) return;
    const now = performance.now(), ddx = p.x - lastX, dt = Math.max(8, now - lastT);
    velS = velS * 0.3 + (Math.abs(ddx) / dt) * 0.7;
    const mult = Math.min(80, 1 + Math.pow(velS / 0.4, 2) * 4);   // 速く動かすほど大きく飛ぶ（gesture-playerと同じ式）
    accum += ddx / opt.sens * mult;
    lastX = p.x; lastT = now;
    const jump = Math.round(accum), to = clamp(v.currentTime + jump, 0, v.duration);
    chip((jump < 0 ? '−' : '+') + Math.abs(jump) + '秒', `${fmt(to)} / ${fmt(v.duration)}`);
  };

  const onEnd = e => {
    e.preventDefault();
    if (e.touches && e.touches.length > 0) return;
    clearTimeout(holdTimer);
    const v = vid();
    if (mode === 'hold') endHold();
    else if (mode === 'scrub') {
      const jump = Math.round(accum);
      if (v && v.duration && jump !== 0) v.currentTime = clamp(v.currentTime + jump, 0, v.duration);
      hideChip(500);
    } else if (mode === null && s0 && Date.now() - st < HOLD_MS) handleTap(s0);
    mode = null; s0 = null;
  };
  layer.addEventListener('touchstart', onStart, { passive:false });
  layer.addEventListener('touchmove', onMove, { passive:false });
  layer.addEventListener('touchend', onEnd, { passive:false });
  layer.addEventListener('touchcancel', onEnd, { passive:false });
  layer.addEventListener('contextmenu', e => e.preventDefault());

  // 1回目は少し待ってからプレイヤーへ渡す。2回目が来たらスキップ（連打で加算）
  function handleTap(p){
    const now = Date.now(), zone = p.y / rect.h < ZONE ? 'R' : 'F';
    if (multiTimer && zone === multiZone) { doSkip(zone); return; }
    if (now - lastTap < DOUBLE_MS && zone === lastZone) { clearTimeout(tapTimer); lastTap = 0; doSkip(zone); return; }
    lastTap = now; lastZone = zone;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { forwardTap(p.cx, p.cy); showBar(); }, DOUBLE_MS);
  }
  function doSkip(zone){
    const v = vid(); if (!v) return;
    if (multiZone && multiZone !== zone) multiSkip = 0;
    multiZone = zone;
    const sign = zone === 'R' ? -1 : 1;
    multiSkip += opt.skip;
    v.currentTime = clamp(v.currentTime + sign * opt.skip, 0, v.duration || Infinity);
    chip((sign < 0 ? '−' : '+') + multiSkip + '秒', '');
    clearTimeout(multiTimer);
    multiTimer = setTimeout(() => { hideChip(); multiSkip = 0; multiTimer = null; multiZone = null; }, MULTI_MS);
  }

  // ---------- ボタン ----------
  const tapBtn = (id, fn) => $(id).addEventListener('click', e => { e.stopPropagation(); fn(); showBar(); });
  tapBtn('bSet', () => { const o = panel.classList.toggle('open'); $('bSet').classList.toggle('on', o); bar.classList.toggle('pin', o); });
  let pass = false;
  tapBtn('bPass', () => {
    pass = !pass; layer.classList.toggle('pass', pass); $('bPass').classList.toggle('on', pass); bar.classList.toggle('pin', pass);
    chip(pass ? 'ジェスチャー休止' : 'ジェスチャー再開', pass ? 'プレイヤーを普通に操作できるで' : '', 1000);
  });
  // 擬似全画面：videoだけページいっぱいに広げる（プレイヤー本体のDOMは動かさへん）
  let full = false, savedStyle = null, fullEl = null;
  function setFull(on){
    const v = vid(); if (!v) return;
    if (on) {
      fullEl = v; savedStyle = v.getAttribute('style');
      v.style.cssText += ';position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;height:100dvh!important;'
        + 'max-width:none!important;max-height:none!important;margin:0!important;z-index:2147483646!important;background:#000!important;object-fit:contain!important;transform:none!important;';
    } else if (fullEl) {
      if (savedStyle === null) fullEl.removeAttribute('style'); else fullEl.setAttribute('style', savedStyle);
      fullEl = null;
    }
    full = on; $('bFull').classList.toggle('on', on);
  }
  tapBtn('bFull', () => setFull(!full));
  tapBtn('bOff', () => destroy());
  $('sHold').addEventListener('change', e => { opt.hold = Number(e.target.value); store.set('hold', opt.hold); chip('▶▶ ' + rateLabel(opt.hold), '長押し中の速度', 900); });
  $('sSkip').addEventListener('change', e => { opt.skip = Number(e.target.value); store.set('skip', opt.skip); chip(opt.skip + '秒', 'ダブルタップのスキップ', 900); });
  $('sSens').addEventListener('change', e => { opt.sens = Number(e.target.value); store.set('sens', opt.sens); chip(SENS_OPTS.find(s => s[0] === opt.sens)[1], 'スワイプ感度', 900); });
  [ 'touchstart', 'touchmove', 'touchend' ].forEach(t => { panel.addEventListener(t, e => e.stopPropagation()); bar.addEventListener(t, e => e.stopPropagation()); });

  function destroy(){
    cancelAnimationFrame(raf);
    clearTimeout(holdTimer); clearTimeout(tapTimer); clearTimeout(multiTimer);
    if (mode === 'hold') endHold();
    if (full) setFull(false);
    host.remove();
    delete window[NS];
  }
  window[NS] = { destroy };

  chip('ジェスチャーON', `長押し ${rateLabel(opt.hold)}・スキップ ${opt.skip}秒`, 1500);
  showBar();
})();
