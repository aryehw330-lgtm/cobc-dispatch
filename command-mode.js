// ═══════════════════════════════════════════════════════════════════════════
// COMMAND MODE — live command-center map for missing-person / flood-night ops.
// Admin starts a "command night": added members auto-share GPS continuously; the
// command lead + any admin + on-duty dispatchers see a live map of member unit
// numbers (green=on call, yellow=idle, grey=stale, blue=lead) and red call labels,
// plus roster, incident log, sector zones, closest-unit assign, and a command
// broadcast. Members see a banner and can sign out. Runs alongside the normal app.
//
// Depends on globals from index.html (classic-script shared scope): SESSION, STATE,
// firebase, showToast, loadGoogleMapsAPI, MAPS_API_KEY, _onDutyDispatchUnits,
// geocodeCallAddress, cardTown, escapeHTML, cleanLabel, CALL_TYPE_LABELS, sendWA, sendPush.
// ═══════════════════════════════════════════════════════════════════════════
(function(){
  'use strict';
  var CM_STALE_MS = 10*60*1000;      // dot grey after 10 min with no GPS update
  var CM_SHARE_MS = 30*1000;         // write my location every 30s while in command
  var _cmState = null;               // config/commandMode doc
  var _cmLocs = {};                  // unit → {unit,name,lat,lng,at}
  var _cmLog = [];                   // incident log entries
  var _cmMap = null, _cmMarkers = {}, _cmCallMarkers = {}, _cmSectorMarkers = {};
  var _cmShareTimer = null;
  var _cmUnsub = {};                 // firestore unsubscribers
  var _cmCallCoords = {};            // callId → {lat,lng} cache
  var _cmLoggedCalls = {};           // lead-side de-dupe for auto call logging
  var _cmReady = false;

  function U(u){ return String(u||'').replace(/^BC-?/i,'').trim(); }
  function myUnit(){ return (typeof SESSION!=='undefined' && SESSION && SESSION.unit) ? U(SESSION.unit) : ''; }
  function db(){ return firebase.firestore(); }
  function fsReady(){ return typeof firebase!=='undefined' && firebase.apps && firebase.apps.length; }

  // ── Role / membership ─────────────────────────────────────────────────────
  function cmIsActive(){ return !!(_cmState && _cmState.active); }
  function cmLeadUnit(){ return _cmState ? U(_cmState.leadUnit) : ''; }
  function cmMembers(){ return (_cmState && Array.isArray(_cmState.members)) ? _cmState.members : []; }
  function cmIsMember(){ var u=myUnit(); return cmMembers().some(function(m){ return U(m.unit)===u; }); }
  function cmAmAdmin(){ return typeof SESSION!=='undefined' && SESSION && SESSION.role==='admin'; }
  function cmAmOnDuty(){
    try{ return (_onDutyDispatchUnits()||[]).map(U).indexOf(myUnit())>=0; }catch(e){ return false; }
  }
  // Lead + any admin + on-duty dispatchers can open AND control the command view.
  function cmCanView(){ return cmIsActive() && (cmAmAdmin() || myUnit()===cmLeadUnit() || cmAmOnDuty()); }

  // ── Init: subscribe to the command config (all devices) ─────────────────────
  function initCommandMode(){
    if(_cmReady) return; if(!fsReady()) { setTimeout(initCommandMode, 800); return; }
    _cmReady = true;
    try{
      db().collection('config').doc('commandMode').onSnapshot(function(doc){
        _cmState = doc.exists ? doc.data() : null;
        _cmOnStateChange();
      }, function(e){ console.warn('[command] state sub error', e); });
    }catch(e){ console.warn('[command] init error', e); }
  }

  function _cmOnStateChange(){
    // Location sharing: on only when active AND I'm a listed member (or the lead).
    var shouldShare = cmIsActive() && (cmIsMember() || myUnit()===cmLeadUnit());
    if(shouldShare) _cmStartShare(); else _cmStopShare();
    // Live sub-listeners (locations + log) only while active.
    if(cmIsActive()) _cmAttachLive(); else _cmDetachLive();
    _cmRenderBanner();
    _cmSyncSettingsButton();
    if(document.getElementById('cmOverlay')){
      if(!cmCanView()) closeCommandView(); else _cmRefreshView();
    }
  }

  function _cmAttachLive(){
    if(!_cmUnsub.locs){
      _cmUnsub.locs = db().collection('commandLocations').onSnapshot(function(snap){
        _cmLocs = {}; snap.forEach(function(d){ var v=d.data(); if(v&&v.unit!=null) _cmLocs[U(v.unit)]=v; });
        if(document.getElementById('cmOverlay')) _cmRefreshView();
      }, function(e){ console.warn('[command] locs sub', e); });
    }
    if(!_cmUnsub.log){
      _cmUnsub.log = db().collection('commandLog').orderBy('at','desc').limit(200).onSnapshot(function(snap){
        _cmLog = snap.docs.map(function(d){ return d.data(); });
        var el=document.getElementById('cmLogList'); if(el) _cmRenderLog();
      }, function(e){ console.warn('[command] log sub', e); });
    }
  }
  function _cmDetachLive(){
    ['locs','log'].forEach(function(k){ if(_cmUnsub[k]){ try{_cmUnsub[k]();}catch(e){} _cmUnsub[k]=null; } });
    _cmLocs={}; _cmLog=[];
  }

  // ── Continuous location sharing (command member → commandLocations/{unit}) ──
  function _cmStartShare(){
    if(_cmShareTimer || !navigator.geolocation) return;
    var write = function(){
      navigator.geolocation.getCurrentPosition(function(pos){
        var u=myUnit(); if(!u) return;
        db().collection('commandLocations').doc(u).set({
          unit:u, name:(SESSION&&SESSION.name)||'', lat:pos.coords.latitude, lng:pos.coords.longitude, at:Date.now()
        }).catch(function(){});
      }, function(){}, { enableHighAccuracy:true, maximumAge:20000, timeout:30000 });
    };
    write(); _cmShareTimer = setInterval(write, CM_SHARE_MS);
    console.log('[command] location sharing started');
  }
  function _cmStopShare(){
    if(_cmShareTimer){ clearInterval(_cmShareTimer); _cmShareTimer=null; }
  }

  // ── Member banner ───────────────────────────────────────────────────────────
  function _cmRenderBanner(){
    var show = cmIsActive() && cmIsMember() && !cmCanView(); // controllers see the map, not the banner
    var el = document.getElementById('cmMemberBanner');
    if(!show){ if(el) el.remove(); return; }
    if(!el){
      el=document.createElement('div'); el.id='cmMemberBanner';
      el.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9600;background:linear-gradient(90deg,#7f1d1d,#b91c1c);color:#fff;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      document.body.appendChild(el);
    }
    el.innerHTML='<span style="display:flex;align-items:center;gap:8px;min-width:0;"><span style="width:9px;height:9px;border-radius:50%;background:#fca5a5;box-shadow:0 0 0 3px rgba(252,165,165,.35);flex-shrink:0;animation:cmPulse 1.6s infinite;"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Command Mode active — sharing your location</span></span>'
      +'<button onclick="cmMemberSignOut()" style="flex-shrink:0;background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:800;cursor:pointer;">Sign out</button>';
    if(!document.getElementById('cmPulseStyle')){
      var s=document.createElement('style'); s.id='cmPulseStyle';
      s.textContent='@keyframes cmPulse{0%,100%{opacity:1}50%{opacity:.35}}';
      document.head.appendChild(s);
    }
  }
  function cmMemberSignOut(){
    if(!confirm('Sign out of Command Mode? You will stop sharing your location for tonight.')) return;
    var u=myUnit();
    _cmStopShare();
    try{ db().collection('commandLocations').doc(u).delete().catch(function(){}); }catch(e){}
    try{
      db().collection('config').doc('commandMode').update({
        members: cmMembers().filter(function(m){ return U(m.unit)!==u; })
      });
    }catch(e){}
    showToast('Signed out of Command Mode');
  }

  // ── Settings entry point (admin only) ───────────────────────────────────────
  function _cmSyncSettingsButton(){
    var b=document.getElementById('cmSettingsStatus'); if(b) b.textContent = cmIsActive() ? 'ACTIVE' : 'Off';
    var open=document.getElementById('cmOpenBtn');
    if(open) open.style.display = cmCanView() ? 'block' : 'none';
  }
  function openCommandModeAdmin(){
    if(cmIsActive()){
      if(cmCanView()) openCommandView();
      else showToast('Command night is active — led by BC-'+cmLeadUnit());
      return;
    }
    if(!cmAmAdmin()){ showToast('Admins only'); return; }
    _cmStartSetup();
  }

  // ── Start-night setup modal ─────────────────────────────────────────────────
  function _cmStartSetup(){
    var old=document.getElementById('cmSetup'); if(old) old.remove();
    var members=(STATE.members||[]).slice().sort(function(a,b){ return (parseInt(U(a.unit||a.id))||0)-(parseInt(U(b.unit||b.id))||0); });
    var ov=document.createElement('div'); ov.id='cmSetup';
    ov.style.cssText='position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
    ov.onclick=function(e){ if(e.target===ov) ov.remove(); };
    ov.innerHTML='<div style="background:#fff;border-radius:18px;max-width:440px;width:100%;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;">'
      +'<div style="padding:18px 18px 12px;border-bottom:1px solid #eee;">'
      +'<div style="font-size:18px;font-weight:800;color:#7f1d1d;">🎖️ Start a Command Night</div>'
      +'<div style="font-size:12px;color:#666;margin-top:3px;">Added members share their live location for the night. You are the command lead.</div>'
      +'</div>'
      +'<div style="padding:12px 18px;overflow-y:auto;flex:1;">'
      +'<div style="font-size:12px;font-weight:700;color:#444;margin-bottom:8px;">Add members to the command night</div>'
      +'<input id="cmMemberSearch" placeholder="Filter…" oninput="cmFilterSetup(this.value)" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:10px;box-sizing:border-box;"/>'
      +'<div id="cmMemberPick">'+members.map(function(m){
          var u=U(m.unit||m.id); var nm=((m.firstName||m.name||'')+' '+(m.lastName||'')).trim();
          return '<label class="cmPick" data-u="'+u+'" data-n="'+escapeHTML(nm.toLowerCase())+'" style="display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:1px solid #f2f2f2;cursor:pointer;">'
            +'<input type="checkbox" value="'+u+'" style="width:18px;height:18px;"/>'
            +'<span style="font-weight:700;color:#1a3a5c;">BC-'+u+'</span>'
            +'<span style="color:#666;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escapeHTML(nm)+'</span></label>';
        }).join('')+'</div>'
      +'</div>'
      +'<div style="padding:12px 18px 16px;border-top:1px solid #eee;display:flex;gap:10px;">'
      +'<button onclick="document.getElementById(\'cmSetup\').remove()" style="flex:1;padding:13px;background:#f1f1f1;border:none;border-radius:11px;font-size:14px;font-weight:700;cursor:pointer;">Cancel</button>'
      +'<button onclick="cmConfirmStart()" style="flex:1.4;padding:13px;background:#b91c1c;color:#fff;border:none;border-radius:11px;font-size:15px;font-weight:800;cursor:pointer;">Start Command Night</button>'
      +'</div></div>';
    document.body.appendChild(ov);
  }
  function cmFilterSetup(q){
    q=(q||'').toLowerCase().trim();
    document.querySelectorAll('#cmMemberPick .cmPick').forEach(function(el){
      var hit = !q || el.dataset.u.indexOf(q)>=0 || (el.dataset.n||'').indexOf(q)>=0;
      el.style.display = hit ? 'flex' : 'none';
    });
  }
  function cmConfirmStart(){
    var picked=[].slice.call(document.querySelectorAll('#cmMemberPick input:checked')).map(function(c){ return c.value; });
    var mem=(STATE.members||[]);
    var members=picked.map(function(u){
      var m=mem.find(function(x){ return U(x.unit||x.id)===u; });
      var nm=m?((m.firstName||m.name||'')+' '+(m.lastName||'')).trim():'';
      return { unit:u, name:nm };
    });
    var me=myUnit();
    var payload={
      active:true, startedBy:me, startedByName:(SESSION&&SESSION.name)||'',
      leadUnit:me, leadName:(SESSION&&SESSION.name)||'', startedAt:Date.now(),
      members:members, sectors:[], endedAt:null
    };
    db().collection('config').doc('commandMode').set(payload).then(function(){
      _cmAddLog('🎖️ Command night started by BC-'+me+(members.length?(' · '+members.length+' members'):''), 'start');
      var s=document.getElementById('cmSetup'); if(s) s.remove();
      showToast('🎖️ Command night started');
      setTimeout(openCommandView, 300);
    }).catch(function(e){ showToast('Could not start'); console.warn(e); });
  }

  // ── Incident log ─────────────────────────────────────────────────────────────
  function _cmAddLog(text, kind){
    try{
      db().collection('commandLog').add({ at:Date.now(), text:String(text||''), kind:kind||'note', by:myUnit() }).catch(function(){});
    }catch(e){}
  }
  function cmAddNote(){
    var t=prompt('Add a note to the incident log:'); if(t&&t.trim()) _cmAddLog(t.trim(),'note');
  }

  // ── Full-screen command view ─────────────────────────────────────────────────
  function openCommandView(){
    if(!cmCanView()){ showToast('Not available'); return; }
    var old=document.getElementById('cmOverlay'); if(old) old.remove();
    var ov=document.createElement('div'); ov.id='cmOverlay';
    ov.style.cssText='position:fixed;inset:0;z-index:9700;background:#0f172a;display:flex;flex-direction:column;';
    var canEnd = (myUnit()===cmLeadUnit()) || cmAmAdmin();
    ov.innerHTML=''
      +'<div style="flex-shrink:0;background:#0b1220;color:#fff;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid rgba(255,255,255,.1);">'
        +'<div style="display:flex;align-items:center;gap:10px;min-width:0;"><span style="font-size:18px;">🎖️</span><div style="min-width:0;"><div style="font-size:15px;font-weight:800;">Command Center</div><div style="font-size:11px;color:#94a3b8;">Lead: BC-'+cmLeadUnit()+' · <span id="cmHeadcount"></span></div></div></div>'
        +'<div style="display:flex;gap:8px;flex-shrink:0;">'
          +(canEnd?'<button onclick="cmEndNight()" style="background:#7f1d1d;color:#fff;border:none;border-radius:9px;padding:8px 12px;font-size:12px;font-weight:800;cursor:pointer;">End Night</button>':'')
          +'<button onclick="closeCommandView()" style="background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:800;cursor:pointer;">✕</button>'
        +'</div>'
      +'</div>'
      +'<div style="flex:1;display:flex;min-height:0;">'
        +'<div id="cmMapWrap" style="flex:1;position:relative;min-width:0;"><div id="cmMap" style="position:absolute;inset:0;"></div>'
          +'<div style="position:absolute;left:10px;bottom:10px;z-index:5;background:rgba(11,18,32,.85);color:#fff;border-radius:10px;padding:8px 11px;font-size:11px;line-height:1.7;">'
            +'<div><b style="color:#22c55e;">BC-##</b> on call &nbsp; <b style="color:#eab308;">BC-##</b> idle</div>'
            +'<div><b style="color:#9ca3af;">BC-##</b> stale &nbsp; <b style="color:#3b82f6;">BC-##</b> lead &nbsp; <b style="color:#ef4444;">▮</b> call</div>'
          +'</div>'
        +'</div>'
        +'<div id="cmSidebar" style="width:300px;flex-shrink:0;background:#111827;color:#e5e7eb;display:flex;flex-direction:column;border-left:1px solid rgba(255,255,255,.08);"></div>'
      +'</div>';
    document.body.appendChild(ov);
    _cmBuildSidebar();
    loadGoogleMapsAPI().then(_cmInitMap).catch(function(){ _cmMapFallback(); });
  }
  function closeCommandView(){ var o=document.getElementById('cmOverlay'); if(o) o.remove(); _cmMap=null; _cmMarkers={}; _cmCallMarkers={}; }

  function _cmInitMap(){
    var el=document.getElementById('cmMap'); if(!el) return;
    _cmMap=new google.maps.Map(el,{ center:{lat:40.8976,lng:-74.0160}, zoom:13, mapTypeControl:false, streetViewControl:false, fullscreenControl:false, styles:[{elementType:'geometry',stylers:[{color:'#1d2c4d'}]},{elementType:'labels.text.fill',stylers:[{color:'#8ec3b9'}]},{elementType:'labels.text.stroke',stylers:[{color:'#1a3646'}]},{featureType:'road',elementType:'geometry',stylers:[{color:'#304a7d'}]},{featureType:'water',elementType:'geometry',stylers:[{color:'#0e1626'}]},{featureType:'poi',stylers:[{visibility:'off'}]}] });
    _cmMap._isGoogle=true;
    // Tap map to drop a sector zone (controllers only).
    _cmMap.addListener('click', function(e){ if(_cmSectorArm){ _cmDropSector(e.latLng.lat(), e.latLng.lng()); } });
    _cmRefreshView();
  }
  function _cmMapFallback(){ var el=document.getElementById('cmMap'); if(el) el.innerHTML='<div style="color:#94a3b8;padding:20px;font-size:13px;">Map unavailable — check connection.</div>'; }

  function _transIcon(){ return { url:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'), size:new google.maps.Size(1,1), anchor:new google.maps.Point(0,0) }; }

  // Green if unit is an approved responder on any open/active call.
  function _cmUnitOnCall(u){
    try{
      return (STATE.calls||[]).some(function(c){
        if(c.status!=='open'&&c.status!=='active') return false;
        return (c.responders||[]).some(function(r){ return U(r.unit)===u; });
      });
    }catch(e){ return false; }
  }
  function _cmMemberColor(u, loc){
    if(u===cmLeadUnit()) return '#3b82f6';
    if(!loc || (Date.now()-(loc.at||0))>CM_STALE_MS) return '#9ca3af';
    return _cmUnitOnCall(u) ? '#22c55e' : '#eab308';
  }

  function _cmCallLatLng(call){
    if(_cmCallCoords[call.id]) return _cmCallCoords[call.id];
    var raw=String(call.address||'');
    var m=raw.match(/(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
    if(m){ var v={lat:parseFloat(m[1]),lng:parseFloat(m[2])}; _cmCallCoords[call.id]=v; return v; }
    // async geocode + cache; refresh when it lands
    try{ geocodeCallAddress(call).then(function(g){ if(g){ _cmCallCoords[call.id]=g; if(document.getElementById('cmOverlay')) _cmRefreshView(); } }); }catch(e){}
    return null;
  }

  function _cmRefreshView(){
    if(!_cmMap||!_cmMap._isGoogle){ _cmBuildSidebar(); return; }
    var G=google.maps, seen={};
    // Members
    cmMembers().forEach(function(mm){
      var u=U(mm.unit); var loc=_cmLocs[u]; if(!loc) return; seen[u]=1;
      var color=_cmMemberColor(u, loc);
      var mk=_cmMarkers[u];
      if(!mk){
        mk=new G.Marker({ map:_cmMap, icon:_transIcon() });
        mk.addListener('click', function(){ _cmMemberPopup(u); });
        _cmMarkers[u]=mk;
      }
      mk.setPosition({lat:loc.lat,lng:loc.lng});
      mk.setLabel({ text:'BC-'+u, color:color, fontWeight:'800', fontSize:'13px' });
    });
    Object.keys(_cmMarkers).forEach(function(u){ if(!seen[u]){ _cmMarkers[u].setMap(null); delete _cmMarkers[u]; } });
    // Calls (red labels)
    var cseen={};
    (STATE.calls||[]).forEach(function(c){
      if(c.status!=='open'&&c.status!=='active') return;
      var ll=_cmCallLatLng(c); if(!ll) return; cseen[c.id]=1;
      var lbl='📍 '+(c.callNum?('#'+c.callNum+' '):'')+(cardTown?cardTown(c):(c.town||''));
      var mk=_cmCallMarkers[c.id];
      if(!mk){
        mk=new G.Marker({ map:_cmMap, icon:_transIcon(), zIndex:999 });
        mk.addListener('click', function(){ _cmCallPopup(c.id); });
        _cmCallMarkers[c.id]=mk;
      }
      mk.setPosition(ll);
      mk.setLabel({ text:lbl, color:'#ef4444', fontWeight:'800', fontSize:'13px' });
    });
    Object.keys(_cmCallMarkers).forEach(function(id){ if(!cseen[id]){ _cmCallMarkers[id].setMap(null); delete _cmCallMarkers[id]; } });
    // Sectors
    var sseen={};
    ((_cmState&&_cmState.sectors)||[]).forEach(function(s){
      sseen[s.id]=1;
      var mk=_cmSectorMarkers[s.id];
      if(!mk){ mk=new G.Marker({ map:_cmMap, icon:_transIcon() }); _cmSectorMarkers[s.id]=mk; }
      mk.setPosition({lat:s.lat,lng:s.lng});
      mk.setLabel({ text:'⬡ '+s.label, color:'#a78bfa', fontWeight:'800', fontSize:'13px' });
    });
    Object.keys(_cmSectorMarkers).forEach(function(id){ if(!sseen[id]){ _cmSectorMarkers[id].setMap(null); delete _cmSectorMarkers[id]; } });
    // Lead auto-logs new calls once
    if(myUnit()===cmLeadUnit()){
      (STATE.calls||[]).forEach(function(c){
        if((c.status==='open'||c.status==='active') && !_cmLoggedCalls[c.id] && (c.createdAt||0) >= ((_cmState&&_cmState.startedAt)||0)){
          _cmLoggedCalls[c.id]=1;
          var tl=cleanLabel ? cleanLabel(CALL_TYPE_LABELS[c.type]||c.type||'') : (c.type||'');
          _cmAddLog('🔴 Call '+(c.callNum?('#'+c.callNum+' '):'')+tl+' — '+(c.town||''),'call');
        }
      });
    }
    _cmBuildSidebar();
  }

  // ── Sidebar: roster + log + actions ──────────────────────────────────────────
  function _cmBuildSidebar(){
    var sb=document.getElementById('cmSidebar'); if(!sb) return;
    var mem=cmMembers();
    var onCall=0,idle=0,stale=0;
    mem.forEach(function(mm){ var u=U(mm.unit); var loc=_cmLocs[u]; var col=_cmMemberColor(u,loc); if(col==='#22c55e')onCall++; else if(col==='#eab308')idle++; else if(col==='#9ca3af')stale++; });
    var hc=document.getElementById('cmHeadcount'); if(hc) hc.textContent=mem.length+' members · '+onCall+' on call · '+idle+' idle';
    sb.innerHTML=''
      +'<div style="padding:12px;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,.08);">'
        +'<button onclick="cmAddMembers()" style="flex:1;min-width:0;background:#1e3a5f;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">＋ Members</button>'
        +'<button onclick="cmArmSector()" id="cmSectorBtn" style="flex:1;min-width:0;background:#3730a3;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">⬡ Sector</button>'
        +'<button onclick="cmBroadcast()" style="flex:1;min-width:0;background:#065f46;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">📣 Broadcast</button>'
        +'<button onclick="cmAddNote()" style="flex:1;min-width:0;background:#374151;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">✎ Note</button>'
      +'</div>'
      +'<div style="flex:1;overflow-y:auto;">'
        +'<div style="padding:10px 12px 4px;font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;">Roster ('+mem.length+')</div>'
        +'<div>'+mem.map(function(mm){
            var u=U(mm.unit); var loc=_cmLocs[u]; var col=_cmMemberColor(u,loc);
            var lbl = col==='#22c55e'?'on call':col==='#eab308'?'idle':col==='#9ca3af'?'no signal':'lead';
            return '<div onclick="cmFocusMember(\''+u+'\')" style="display:flex;align-items:center;gap:9px;padding:8px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);">'
              +'<span style="width:9px;height:9px;border-radius:50%;background:'+col+';flex-shrink:0;"></span>'
              +'<span style="font-weight:800;color:'+col+';">BC-'+u+'</span>'
              +'<span style="color:#94a3b8;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">'+escapeHTML(mm.name||'')+'</span>'
              +'<span style="color:#64748b;font-size:11px;flex-shrink:0;">'+lbl+'</span></div>';
          }).join('')||'<div style="padding:12px;color:#64748b;font-size:12px;">No members yet — tap ＋ Members.</div>'+'</div>'
        +'<div style="padding:12px 12px 4px;font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;">Incident Log</div>'
        +'<div id="cmLogList"></div>'
      +'</div>';
    _cmRenderLog();
  }
  function _cmRenderLog(){
    var el=document.getElementById('cmLogList'); if(!el) return;
    el.innerHTML=(_cmLog||[]).map(function(e){
      var t=new Date(e.at||0).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
      return '<div style="padding:6px 12px;font-size:12px;color:#cbd5e1;border-bottom:1px solid rgba(255,255,255,.04);"><span style="color:#64748b;">'+t+'</span> · '+escapeHTML(e.text||'')+'</div>';
    }).join('')||'<div style="padding:8px 12px;color:#64748b;font-size:12px;">No events yet.</div>';
  }

  function cmFocusMember(u){ var loc=_cmLocs[u]; if(loc&&_cmMap&&_cmMap._isGoogle){ _cmMap.panTo({lat:loc.lat,lng:loc.lng}); _cmMap.setZoom(15); } _cmMemberPopup(u); }
  function _cmMemberPopup(u){
    var mm=cmMembers().find(function(x){ return U(x.unit)===u; }); var loc=_cmLocs[u];
    var m=(STATE.members||[]).find(function(x){ return U(x.unit||x.id)===u; });
    var phone=m&&m.phone?m.phone:'';
    var onCall=_cmUnitOnCall(u);
    var status = u===cmLeadUnit()?'Command Lead':(!loc||(Date.now()-(loc.at||0))>CM_STALE_MS?'No recent signal':(onCall?'On an active call':'Idle / available'));
    var when=loc&&loc.at?new Date(loc.at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'—';
    _cmSheet('BC-'+u+(mm&&mm.name?' · '+escapeHTML(mm.name):''),
      '<div style="font-size:13px;color:#374151;margin-bottom:4px;">'+status+'</div>'
      +'<div style="font-size:12px;color:#6b7280;margin-bottom:14px;">Last update: '+when+'</div>'
      +(phone?'<div style="display:flex;gap:8px;"><a href="tel:'+phone+'" style="flex:1;text-align:center;background:#065f46;color:#fff;text-decoration:none;border-radius:10px;padding:12px;font-weight:800;">📞 Call</a>'
        +'<a href="sms:'+phone+'" style="flex:1;text-align:center;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:10px;padding:12px;font-weight:800;">💬 Text</a></div>':'<div style="color:#9ca3af;font-size:12px;">No phone on file</div>'));
  }
  function _cmCallPopup(id){
    var c=(STATE.calls||[]).find(function(x){ return x.id===id; }); if(!c) return;
    var tl=cleanLabel?cleanLabel(CALL_TYPE_LABELS[c.type]||c.type||''):(c.type||'');
    var nearest=_cmNearestIdle(id);
    var body='<div style="font-size:13px;color:#374151;margin-bottom:3px;">'+escapeHTML(c.town||'')+(c.address?(' · '+escapeHTML(String(c.address).replace(/\s*—?\s*📍.*$/,''))):'')+'</div>'
      +'<div style="font-size:12px;color:#6b7280;margin-bottom:14px;">'+(c.responders&&c.responders.length?(c.responders.length+' responding'):'No units yet')+'</div>';
    if(nearest) body+='<button onclick="cmAssignNearest(\''+id+'\')" style="width:100%;background:#b45309;color:#fff;border:none;border-radius:10px;padding:13px;font-weight:800;font-size:14px;cursor:pointer;">Assign nearest idle unit → BC-'+nearest.unit+' ('+nearest.miles.toFixed(1)+' mi)</button>';
    else body+='<div style="color:#9ca3af;font-size:12px;">No idle units with a live location to assign.</div>';
    _cmSheet('🔴 Call '+(c.callNum?('#'+c.callNum+' '):'')+tl, body);
  }

  function _cmSheet(title, bodyHtml){
    var old=document.getElementById('cmSheet'); if(old) old.remove();
    var ov=document.createElement('div'); ov.id='cmSheet';
    ov.style.cssText='position:fixed;inset:0;z-index:10060;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;';
    ov.onclick=function(e){ if(e.target===ov) ov.remove(); };
    ov.innerHTML='<div style="background:#fff;border-radius:18px 18px 0 0;max-width:440px;width:100%;padding:18px 18px calc(18px + env(safe-area-inset-bottom));">'
      +'<div style="font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">'+title+'</div>'+bodyHtml
      +'<button onclick="document.getElementById(\'cmSheet\').remove()" style="width:100%;margin-top:12px;background:transparent;border:none;color:#6b7280;font-size:14px;font-weight:700;padding:8px;cursor:pointer;">Close</button></div>';
    document.body.appendChild(ov);
  }

  // ── Nearest idle unit / assign ────────────────────────────────────────────────
  function _miles(a,b){ var R=3959,dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180,la=a.lat*Math.PI/180,lb=b.lat*Math.PI/180; var h=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(la)*Math.cos(lb)*Math.sin(dLng/2)*Math.sin(dLng/2); return R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)); }
  function _cmNearestIdle(callId){
    var c=(STATE.calls||[]).find(function(x){ return x.id===callId; }); if(!c) return null;
    var ll=_cmCallLatLng(c); if(!ll) return null;
    var best=null;
    cmMembers().forEach(function(mm){
      var u=U(mm.unit); var loc=_cmLocs[u];
      if(!loc||(Date.now()-(loc.at||0))>CM_STALE_MS) return;
      if(u===cmLeadUnit()) return; if(_cmUnitOnCall(u)) return;
      var mi=_miles(ll,{lat:loc.lat,lng:loc.lng});
      if(!best||mi<best.miles) best={unit:u,miles:mi};
    });
    return best;
  }
  function cmAssignNearest(callId){
    var n=_cmNearestIdle(callId); if(!n){ showToast('No idle unit to assign'); return; }
    var c=(STATE.calls||[]).find(function(x){ return x.id===callId; }); if(!c) return;
    var m=(STATE.members||[]).find(function(x){ return U(x.unit||x.id)===n.unit; });
    var resp={ unit:n.unit, name:m?((m.firstName||m.name||'')+' '+(m.lastName||'')).trim():'', time:Date.now(), status:'approved', approvedBy:myUnit(), approvedAt:Date.now(), viaCommand:true };
    c.responders=c.responders||[]; if(c.responders.some(function(r){return U(r.unit)===n.unit;})){ showToast('BC-'+n.unit+' already on this call'); document.getElementById('cmSheet')&&document.getElementById('cmSheet').remove(); return; }
    c.responders.push(resp);
    try{ db().collection('calls').doc(String(c.id)).update({ responders:c.responders }); }catch(e){}
    try{ if(typeof save==='function') save(); if(typeof renderCalls==='function') renderCalls(); }catch(e){}
    try{ sendPush({ target:'unit', unit:n.unit, title:'🎖️ Command assignment', body:'You\'ve been assigned to Call '+(c.callNum?('#'+c.callNum):'')+' — '+(c.town||''), url:'/cobc-dispatch/?page=dispatch', urgent:'true' }); }catch(e){}
    _cmAddLog('➡️ BC-'+n.unit+' assigned to call '+(c.callNum?('#'+c.callNum):'')+' ('+n.miles.toFixed(1)+' mi)','assign');
    showToast('Assigned BC-'+n.unit);
    var s=document.getElementById('cmSheet'); if(s) s.remove();
  }

  // ── Add members mid-night ──────────────────────────────────────────────────────
  function cmAddMembers(){
    _cmStartSetupExisting();
  }
  function _cmStartSetupExisting(){
    var have={}; cmMembers().forEach(function(m){ have[U(m.unit)]=1; });
    var members=(STATE.members||[]).filter(function(m){ return !have[U(m.unit||m.id)]; })
      .sort(function(a,b){ return (parseInt(U(a.unit||a.id))||0)-(parseInt(U(b.unit||b.id))||0); });
    var body='<input id="cmAddSearch" placeholder="Filter…" oninput="cmFilterAdd(this.value)" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:10px;box-sizing:border-box;"/>'
      +'<div id="cmAddPick" style="max-height:44vh;overflow-y:auto;">'+members.map(function(m){
        var u=U(m.unit||m.id); var nm=((m.firstName||m.name||'')+' '+(m.lastName||'')).trim();
        return '<label class="cmAddRow" data-u="'+u+'" data-n="'+escapeHTML(nm.toLowerCase())+'" style="display:flex;align-items:center;gap:10px;padding:9px 6px;border-bottom:1px solid #f2f2f2;cursor:pointer;"><input type="checkbox" value="'+u+'" style="width:18px;height:18px;"/><span style="font-weight:700;color:#1a3a5c;">BC-'+u+'</span><span style="color:#666;font-size:13px;">'+escapeHTML(nm)+'</span></label>';
      }).join('')||'<div style="color:#9ca3af;padding:8px;">Everyone is already added.</div>'+'</div>'
      +'<button onclick="cmConfirmAdd()" style="width:100%;margin-top:12px;background:#1e3a5f;color:#fff;border:none;border-radius:10px;padding:13px;font-weight:800;font-size:14px;cursor:pointer;">Add selected</button>';
    _cmSheet('Add members', body);
  }
  function cmFilterAdd(q){ q=(q||'').toLowerCase().trim(); document.querySelectorAll('#cmAddPick .cmAddRow').forEach(function(el){ var hit=!q||el.dataset.u.indexOf(q)>=0||(el.dataset.n||'').indexOf(q)>=0; el.style.display=hit?'flex':'none'; }); }
  function cmConfirmAdd(){
    var picked=[].slice.call(document.querySelectorAll('#cmAddPick input:checked')).map(function(c){return c.value;});
    if(!picked.length){ showToast('Select members'); return; }
    var mem=(STATE.members||[]);
    var add=picked.map(function(u){ var m=mem.find(function(x){return U(x.unit||x.id)===u;}); return { unit:u, name:m?((m.firstName||m.name||'')+' '+(m.lastName||'')).trim():'' }; });
    var next=cmMembers().concat(add);
    db().collection('config').doc('commandMode').update({ members:next }).then(function(){
      _cmAddLog('➕ Added '+add.map(function(a){return 'BC-'+a.unit;}).join(', '),'roster');
      var s=document.getElementById('cmSheet'); if(s) s.remove(); showToast('Added '+add.length);
    }).catch(function(){ showToast('Could not add'); });
  }

  // ── Sectors ────────────────────────────────────────────────────────────────────
  var _cmSectorArm=false;
  function cmArmSector(){ _cmSectorArm=!_cmSectorArm; var b=document.getElementById('cmSectorBtn'); if(b){ b.style.background=_cmSectorArm?'#a78bfa':'#3730a3'; b.textContent=_cmSectorArm?'⬡ Tap map…':'⬡ Sector'; } showToast(_cmSectorArm?'Tap the map to drop a search sector':'Sector drop off'); }
  function _cmDropSector(lat,lng){
    var label=prompt('Sector label (e.g. A, North Woods):'); if(label===null) return;
    var sectors=((_cmState&&_cmState.sectors)||[]).concat([{ id:'s'+Date.now(), label:(label||'Zone').trim(), lat:lat, lng:lng }]);
    db().collection('config').doc('commandMode').update({ sectors:sectors }).then(function(){ _cmAddLog('⬡ Sector "'+(label||'Zone')+'" added','sector'); });
    _cmSectorArm=false; var b=document.getElementById('cmSectorBtn'); if(b){ b.style.background='#3730a3'; b.textContent='⬡ Sector'; }
  }

  // ── Command broadcast (separate message to command members) ──────────────────────
  function cmBroadcast(){
    var msg=prompt('Broadcast a message to all command members:'); if(!msg||!msg.trim()) return;
    var text='🎖️ COMMAND: '+msg.trim();
    cmMembers().forEach(function(mm){ try{ sendPush({ target:'unit', unit:U(mm.unit), title:'🎖️ Command Center', body:msg.trim(), url:'/cobc-dispatch/?page=dispatch', urgent:'true' }); }catch(e){} });
    try{ sendWA({ target:'all', message:text }); }catch(e){}
    _cmAddLog('📣 Broadcast: '+msg.trim(),'broadcast');
    showToast('📣 Sent to command members');
  }

  // ── End the night ───────────────────────────────────────────────────────────────
  function cmEndNight(){
    if(!((myUnit()===cmLeadUnit())||cmAmAdmin())){ showToast('Only the lead or an admin can end it'); return; }
    if(!confirm('End the command night? Members stop sharing location and a summary is saved.')) return;
    var summary={
      startedAt:(_cmState&&_cmState.startedAt)||null, endedAt:Date.now(),
      leadUnit:cmLeadUnit(), members:cmMembers(),
      sectors:(_cmState&&_cmState.sectors)||[], log:_cmLog.slice(0,500), endedBy:myUnit()
    };
    try{ db().collection('commandHistory').add(summary); }catch(e){}
    _cmAddLog('🏁 Command night ended by BC-'+myUnit(),'end');
    db().collection('config').doc('commandMode').set({ active:false, endedAt:Date.now(), lastSummaryAt:Date.now() }, {merge:true}).then(function(){
      // clear live locations
      try{ db().collection('commandLocations').get().then(function(s){ s.forEach(function(d){ d.ref.delete().catch(function(){}); }); }); }catch(e){}
      closeCommandView(); showToast('🏁 Command night ended — summary saved');
    });
  }

  // Expose the handful of functions referenced by inline onclick + index.html.
  Object.assign(window, {
    initCommandMode: initCommandMode, openCommandModeAdmin: openCommandModeAdmin,
    openCommandView: openCommandView, closeCommandView: closeCommandView,
    cmMemberSignOut: cmMemberSignOut, cmConfirmStart: cmConfirmStart, cmFilterSetup: cmFilterSetup,
    cmAddMembers: cmAddMembers, cmFilterAdd: cmFilterAdd, cmConfirmAdd: cmConfirmAdd,
    cmFocusMember: cmFocusMember, cmAssignNearest: cmAssignNearest, cmArmSector: cmArmSector,
    cmBroadcast: cmBroadcast, cmAddNote: cmAddNote, cmEndNight: cmEndNight,
    _cmSyncSettingsButton: _cmSyncSettingsButton
  });

  // Kick off once the page + firebase are ready.
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(initCommandMode, 1200); });
  else setTimeout(initCommandMode, 1200);
})();
