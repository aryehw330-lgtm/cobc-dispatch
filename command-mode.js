// ═══════════════════════════════════════════════════════════════════════════
// COMMAND MODE — live command-center map for large ops. Two operation types:
//   • 'command' (General Command)  — flood night, big multi-call events
//   • 'missing' (Missing Person)   — adds a subject profile, last-seen pin,
//                                     auto search grid, and member breadcrumb trails
// Admin starts an op; added members auto-share GPS; the lead + any admin +
// on-duty dispatchers see the live map. Runs alongside normal dispatch.
//
// Globals from index.html (shared classic-script scope): SESSION, STATE, firebase,
// showToast, loadGoogleMapsAPI, MAPS_API_KEY, _onDutyDispatchUnits, geocodeCallAddress,
// cardTown, escapeHTML, cleanLabel, CALL_TYPE_LABELS, sendWA, sendPush, save, renderCalls,
// _nextCallNumAtomic (optional).
// ═══════════════════════════════════════════════════════════════════════════
(function(){
  'use strict';
  var CM_STALE_MS = 10*60*1000;
  var CM_SHARE_MS = 30*1000;
  var CM_TRAIL_MAX = 40;
  var _cmState=null, _cmLocs={}, _cmLog=[];
  var _cmMap=null, _cmMarkers={}, _cmCallMarkers={}, _cmSectorMarkers={}, _cmGridShapes={}, _cmTrails={}, _cmLastSeenMk=null;
  var _cmShareTimer=null, _cmUnsub={}, _cmCallCoords={}, _cmLoggedCalls={}, _cmReady=false, _cmSectorArm=false;
  var _cmView='calls', _cmCallFilter='all', _cmCallSearch='', _cmTick=null, _cmSelCall=null, _cmNewCallArm=false;
  var _cmPick={};   // start/add member selection: unit → true
  var _cmHist=[];   // loaded commandHistory records for the Logs viewer
  var _cmSeenStatus={}, _cmClosedHandled={};   // detect calls that flip to done while an op is open
  var _cmDrawMode='off';   // 'off' | 'draw' | 'erase'
  var _cmDrawLines=[];      // live google Polyline objects keyed by drawing id
  var _cmDrawObjs={};       // id → Polyline
  var _cmCurDraw=null;      // in-progress {id,points,poly}

  function U(u){ return String(u||'').replace(/^BC-?/i,'').trim(); }
  function myUnit(){ return (typeof SESSION!=='undefined'&&SESSION&&SESSION.unit)?U(SESSION.unit):''; }
  function db(){ return firebase.firestore(); }
  function fsReady(){ return typeof firebase!=='undefined'&&firebase.apps&&firebase.apps.length; }

  function cmIsActive(){ return !!(_cmState&&_cmState.active); }
  function cmType(){ return (_cmState&&_cmState.type)||'command'; }
  function cmIsMissing(){ return cmType()==='missing'; }
  function cmLeadUnit(){ return _cmState?U(_cmState.leadUnit):''; }
  function cmMembers(){ return (_cmState&&Array.isArray(_cmState.members))?_cmState.members:[]; }
  function cmIsMember(){ var u=myUnit(); return cmMembers().some(function(m){ return U(m.unit)===u; }); }
  function cmViewers(){ return (_cmState&&Array.isArray(_cmState.viewers))?_cmState.viewers:[]; }
  function cmIsViewer(){ var u=myUnit(); return cmViewers().some(function(v){ return U(v.unit)===u; }); }
  function cmAmAdmin(){ return typeof SESSION!=='undefined'&&SESSION&&SESSION.role==='admin'; }
  function cmAmDispatcher(){ return typeof SESSION!=='undefined'&&SESSION&&SESSION.role==='dispatch'; }
  function cmAmOnDuty(){ try{ return (_onDutyDispatchUnits()||[]).map(U).indexOf(myUnit())>=0; }catch(e){ return false; } }
  function cmCanView(){ return cmIsActive()&&(cmAmAdmin()||cmAmDispatcher()||myUnit()===cmLeadUnit()||cmAmOnDuty()||cmIsViewer()); }

  // ── Init ──────────────────────────────────────────────────────────────────
  function initCommandMode(){
    if(_cmReady) return; if(!fsReady()){ setTimeout(initCommandMode,800); return; }
    _cmReady=true;
    try{
      db().collection('config').doc('commandMode').onSnapshot(function(doc){
        _cmState=doc.exists?doc.data():null; _cmOnStateChange();
      }, function(e){ console.warn('[command] state sub',e); });
    }catch(e){ console.warn('[command] init',e); }
  }
  function _cmOnStateChange(){
    var shouldShare=cmIsActive()&&(cmIsMember()||myUnit()===cmLeadUnit());
    if(shouldShare) _cmStartShare(); else _cmStopShare();
    if(cmIsActive()) _cmAttachLive(); else _cmDetachLive();
    _cmRenderBanner(); _cmSyncSettingsButton(); _cmSyncCommsButton();
    if(document.getElementById('cmOverlay')){ if(!cmCanView()) closeCommandView(); else _cmRefreshView(); }
  }
  function _cmAttachLive(){
    if(!_cmUnsub.locs){
      _cmUnsub.locs=db().collection('commandLocations').onSnapshot(function(snap){
        _cmLocs={}; snap.forEach(function(d){ var v=d.data(); if(v&&v.unit!=null) _cmLocs[U(v.unit)]=v; });
        if(document.getElementById('cmOverlay')) _cmRefreshView();
      }, function(e){ console.warn('[command] locs',e); });
    }
    if(!_cmUnsub.log){
      _cmUnsub.log=db().collection('commandLog').orderBy('at','desc').limit(500).onSnapshot(function(snap){
        _cmLog=snap.docs.map(function(d){ return d.data(); });
        try{ _cmDetectNewComms(); }catch(e){}
        if(document.getElementById('cmLogList')) _cmRenderLog();
      }, function(e){ console.warn('[command] log',e); });
    }
  }
  function _cmDetachLive(){ ['locs','log'].forEach(function(k){ if(_cmUnsub[k]){ try{_cmUnsub[k]();}catch(e){} _cmUnsub[k]=null; } }); _cmLocs={}; _cmLog=[]; }

  // ── Location sharing + breadcrumb trail ────────────────────────────────────
  function _cmStartShare(){
    if(_cmShareTimer||!navigator.geolocation) return;
    var write=function(){
      navigator.geolocation.getCurrentPosition(function(pos){
        var u=myUnit(); if(!u) return;
        var ref=db().collection('commandLocations').doc(u);
        var pt={lat:pos.coords.latitude,lng:pos.coords.longitude,at:Date.now()};
        var base={unit:u,name:(SESSION&&SESSION.name)||'',lat:pt.lat,lng:pt.lng,at:pt.at};
        // append to trail (capped) for breadcrumbs
        base.trail=firebase.firestore.FieldValue.arrayUnion(pt);
        ref.set(base,{merge:true}).then(function(){
          // trim trail length occasionally
          ref.get().then(function(d){ var t=(d.data()||{}).trail||[]; if(t.length>CM_TRAIL_MAX){ ref.update({trail:t.slice(-CM_TRAIL_MAX)}).catch(function(){}); } });
        }).catch(function(){});
      }, function(){}, {enableHighAccuracy:true,maximumAge:20000,timeout:30000});
    };
    write(); _cmShareTimer=setInterval(write,CM_SHARE_MS);
  }
  function _cmStopShare(){ if(_cmShareTimer){ clearInterval(_cmShareTimer); _cmShareTimer=null; } }

  // ── Member banner ──────────────────────────────────────────────────────────
  function _cmRenderBanner(){
    var show=cmIsActive()&&cmIsMember()&&!cmCanView();
    var el=document.getElementById('cmMemberBanner');
    if(!show){ if(el) el.remove(); return; }
    if(!el){ el=document.createElement('div'); el.id='cmMemberBanner';
      el.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9600;background:linear-gradient(90deg,#7f1d1d,#b91c1c);color:#fff;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      document.body.appendChild(el);
    }
    var label=cmIsMissing()?'Missing Person search active':'Command Mode active';
    el.innerHTML='<span style="display:flex;align-items:center;gap:8px;min-width:0;"><span style="width:9px;height:9px;border-radius:50%;background:#fca5a5;box-shadow:0 0 0 3px rgba(252,165,165,.35);flex-shrink:0;animation:cmPulse 1.6s infinite;"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+label+' — sharing your location</span></span>'
      +'<span style="display:flex;gap:8px;flex-shrink:0;"><button onclick="cmMemberChat()" id="cmBannerChatBtn" style="background:#fff;color:#b91c1c;border:none;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:800;cursor:pointer;">💬 Join Chat</button><button onclick="cmMemberSignOut()" style="background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:800;cursor:pointer;">Sign out</button></span>';
    if(!document.getElementById('cmPulseStyle')){ var s=document.createElement('style'); s.id='cmPulseStyle'; s.textContent='@keyframes cmPulse{0%,100%{opacity:1}50%{opacity:.35}}'
      +'@keyframes cmSlideDown{from{transform:translateY(-16px);opacity:0}to{transform:translateY(0);opacity:1}}'
      +'@keyframes cmGrad{0%{background-position:0% 50%}100%{background-position:200% 50%}}'
      +'.cmCommsPulse{background-image:linear-gradient(90deg,#1d4ed8,#22d3ee,#1d4ed8,#22d3ee)!important;background-size:200% 100%!important;animation:cmGrad 1.1s linear infinite!important;box-shadow:0 0 0 2px rgba(34,211,238,.5)!important;}';
      document.head.appendChild(s); }
  }
  function cmMemberSignOut(){
    if(!confirm('Sign out? You will stop sharing your location.')) return;
    var u=myUnit(); _cmStopShare();
    try{ db().collection('commandLocations').doc(u).delete().catch(function(){}); }catch(e){}
    try{ db().collection('config').doc('commandMode').update({ members:cmMembers().filter(function(m){ return U(m.unit)!==u; }) }); }catch(e){}
    showToast('Signed out');
  }

  // ── Member/dispatcher chat panel (bottom-half popup from the banner) ─────────
  var _cmMChatTab='members';
  // Who can see all three channels (Dispatch · Members · Notes): admin, dispatch, equipment.
  function _cmCanSeeAllChats(){ try{ var r=(SESSION&&SESSION.role||'').toLowerCase(); if(r==='admin'||r==='dispatch'||r==='equipment') return true; var me=(STATE.members||[]).find(function(m){ return U(m.unit||m.id)===myUnit(); }); var rr=me?String(me.role||'').toLowerCase():''; return rr.indexOf('admin')>=0||rr.indexOf('dispatch')>=0||rr.indexOf('equipment')>=0; }catch(e){ return false; } }
  function cmMemberChat(){ var p=document.getElementById('cmMemberChatPanel'); if(p){ p.remove(); return; } p=document.createElement('div'); p.id='cmMemberChatPanel'; p.style.cssText='position:fixed;left:0;right:0;bottom:0;height:56vh;z-index:9650;background:#fff;border-radius:20px 20px 0 0;box-shadow:0 -8px 30px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden;'; document.body.appendChild(p); ['cmBannerChatBtn','cmChatBtn','cmNoteBtn'].forEach(_cmClearPulse); document.querySelectorAll('.cmChatTopBtn').forEach(function(b){ b.classList.remove('cmCommsPulse'); }); _cmRenderMemberChat(); }
  function cmMemberChatTab(t){ _cmMChatTab=t; _cmRenderMemberChat(); }
  function _cmRenderMemberChat(){
    var p=document.getElementById('cmMemberChatPanel'); if(!p) return;
    var defs=_cmCanSeeAllChats()?[{k:'dispatch',label:'💬 Dispatch'},{k:'members',label:'👥 Members'},{k:'note',label:'📝 Notes'}]:[{k:'members',label:'👥 Members'}];
    if(!defs.some(function(d){ return d.k===_cmMChatTab; })) _cmMChatTab=defs[0].k;
    var tabs=defs.map(function(d){ var on=_cmMChatTab===d.k; return '<button onclick="cmMemberChatTab(\''+d.k+'\')" style="flex:1;padding:9px 6px;border:none;border-radius:9px;font-family:inherit;font-size:12px;font-weight:800;cursor:pointer;background:'+(on?'#1e3a5f':'#f1f5f9')+';color:'+(on?'#fff':'#64748b')+';">'+d.label+'</button>'; }).join('');
    var msgs=(_cmLog||[]).filter(function(e){ return (e.channel||'note')===_cmMChatTab; }).slice().reverse();
    var list=msgs.map(function(e){ var t=new Date(e.at||0).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); var mine=U(e.by)===myUnit(); return '<div style="display:flex;flex-direction:column;align-items:'+(mine?'flex-end':'flex-start')+';margin-bottom:8px;"><div style="max-width:82%;background:'+(mine?'#dbeafe':'#f1f5f9')+';color:#0f172a;border-radius:12px;padding:8px 11px;font-size:13px;line-height:1.4;">'+_cmBoldCalls(escapeHTML(e.text||''))+'</div><div style="font-size:10px;color:#94a3b8;margin-top:2px;">'+(e.by?'BC-'+U(e.by)+' · ':'')+t+'</div></div>'; }).join('')||'<div style="padding:16px;color:#9ca3af;font-size:13px;text-align:center;">No messages yet.</div>';
    p.innerHTML='<div style="flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #eef2f7;"><div style="font-size:15px;font-weight:800;color:#0f172a;">🎖️ Command Chat</div><button onclick="cmMemberChat()" style="background:#f1f5f9;border:none;border-radius:50%;width:30px;height:30px;font-size:15px;cursor:pointer;color:#64748b;">✕</button></div>'
      +'<div style="flex-shrink:0;display:flex;gap:6px;padding:10px 12px 0;">'+tabs+'</div>'
      +'<div id="cmMChatList" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px;">'+list+'</div>'
      +'<div style="flex-shrink:0;display:flex;gap:8px;padding:10px 12px calc(env(safe-area-inset-bottom) + 12px);border-top:1px solid #eef2f7;"><input id="cmMChatInput" placeholder="Message '+(_cmMChatTab==='dispatch'?'dispatch':'members')+'…" onkeydown="if(event.key===\'Enter\')cmMemberChatSend()" style="flex:1;padding:12px;border:1.5px solid #ddd;border-radius:10px;font-size:14px;box-sizing:border-box;"/><button onclick="cmMemberChatSend()" style="background:#1e3a5f;color:#fff;border:none;border-radius:10px;padding:0 18px;font-weight:800;font-size:14px;cursor:pointer;">Send</button></div>';
    setTimeout(function(){ var l=document.getElementById('cmMChatList'); if(l) l.scrollTop=l.scrollHeight; var i=document.getElementById('cmMChatInput'); if(i) i.focus(); },30);
  }
  function cmMemberChatSend(){ var i=document.getElementById('cmMChatInput'); if(!i) return; var t=(i.value||'').trim(); if(!t) return; var isNote=_cmMChatTab==='note'; var entry={ at:Date.now(), text:t, kind:isNote?'note':'chat', channel:_cmMChatTab, by:myUnit() }; _cmLog=_cmLog||[]; _cmLog.unshift(entry); _cmAddLog(t,isNote?'note':'chat',_cmMChatTab); i.value=''; _cmRenderMemberChat(); }
  // Chat button pinned to the top of the Open Calls / Dispatch tabs during an active op.
  function _cmSyncCommsButton(){
    var on=cmIsActive(); var all=_cmCanSeeAllChats();
    var html=on?('<button class="cmChatTopBtn" onclick="cmMemberChat()" style="width:100%;display:flex;align-items:center;justify-content:center;gap:8px;background:linear-gradient(135deg,#1e3a5f,#2563eb);color:#fff;border:none;border-radius:12px;padding:12px;font-size:14px;font-weight:800;cursor:pointer;margin-bottom:12px;box-shadow:0 3px 12px rgba(37,99,235,.3);font-family:inherit;">💬 '+(cmIsMissing()?'Search Chat':'Command Chat')+(all?' · Dispatch·Members·Notes':'')+'</button>'):'';
    ['cmChatMountHome','cmChatMountDispatch'].forEach(function(id){ var el=document.getElementById(id); if(!el) return; el.innerHTML=html; el.style.display=on?'block':'none'; });
  }

  // ── Settings entry points ──────────────────────────────────────────────────
  function _cmSyncSettingsButton(){
    var active=cmIsActive(), t=cmType();
    var cs=document.getElementById('cmSettingsStatus'); if(cs) cs.textContent=(active&&t==='command')?'ACTIVE':'Off';
    var ms=document.getElementById('mpSettingsStatus'); if(ms) ms.textContent=(active&&t==='missing')?'ACTIVE':'Off';
    var co=document.getElementById('cmOpenBtn'); if(co) co.style.display=(cmCanView()&&t==='command')?'block':'none';
    var mo=document.getElementById('mpOpenBtn'); if(mo) mo.style.display=(cmCanView()&&t==='missing')?'block':'none';
    // Dispatcher (non-admin) watch card: show only when an op is live and they can view it
    var wc=document.getElementById('settingsCmWatch');
    if(wc){
      var showWatch=active&&cmCanView()&&!cmAmAdmin();
      wc.style.display=showWatch?'block':'none';
      if(showWatch){
        var wt=document.getElementById('cmWatchTitle'); if(wt) wt.textContent=cmIsMissing()?'🔍 Missing Person':'🎖️ Command Mode';
      }
    }
  }
  function openCommandModeAdmin(){ _cmEntry('command'); }
  function openMissingPersonAdmin(){ _cmEntry('missing'); }
  function _cmEntry(type){
    if(cmIsActive()){
      if(cmType()===type){ if(cmCanView()) openCommandView(); else showToast('Active — led by BC-'+cmLeadUnit()); }
      else showToast('A '+(cmIsMissing()?'Missing Person':'Command')+' op is already active — end it first.');
      return;
    }
    if(!cmAmAdmin()){ showToast('Admins only'); return; }
    _cmStartFlow(type);
  }

  // ── Start flow: choose call linkage, (missing) subject, members ─────────────
  function _cmStartFlow(type){
    _cmPick={};
    var old=document.getElementById('cmSetup'); if(old) old.remove();
    var openCalls=(STATE.calls||[]).filter(function(c){ return c.status==='open'||c.status==='active'; })
      .sort(function(a,b){ return (b.createdAt||0)-(a.createdAt||0); });
    var members=(STATE.members||[]).slice().sort(function(a,b){ return (parseInt(U(a.unit||a.id))||0)-(parseInt(U(b.unit||b.id))||0); });
    var missing=type==='missing';
    var ov=document.createElement('div'); ov.id='cmSetup';
    ov.style.cssText='position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:14px;';
    ov.onclick=function(e){ if(e.target===ov) ov.remove(); };
    var subjectHtml = missing ? (
        '<div style="font-size:12px;font-weight:800;color:#7f1d1d;margin:6px 0 8px;text-transform:uppercase;letter-spacing:.04em;">Missing Person</div>'
      + '<div style="display:flex;gap:10px;margin-bottom:10px;">'
      +   '<label id="mpPhotoBox" style="width:78px;height:78px;border-radius:12px;background:#f1f5f9;border:1.5px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:11px;color:#64748b;text-align:center;cursor:pointer;flex-shrink:0;overflow:hidden;">Add photo<input id="mpPhoto" type="file" accept="image/*" onchange="cmPhotoPick(event)" style="display:none;"/></label>'
      +   '<div style="flex:1;display:flex;flex-direction:column;gap:8px;">'
      +     '<input id="mpName" placeholder="Full name" style="padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;"/>'
      +     '<input id="mpAge" placeholder="Age" inputmode="numeric" style="padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;"/>'
      +   '</div>'
      + '</div>'
      + '<input id="mpDesc" placeholder="Physical description (height, build, hair)" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:8px;box-sizing:border-box;"/>'
      + '<input id="mpClothing" placeholder="Clothing last worn" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:8px;box-sizing:border-box;"/>'
      + '<input id="mpLastSeenAddr" placeholder="Last seen — address / place" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:8px;box-sizing:border-box;"/>'
      + '<input id="mpLastSeenTime" placeholder="Last seen — time (e.g. 6:30 PM)" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:8px;box-sizing:border-box;"/>'
      + '<textarea id="mpMedical" rows="2" placeholder="Medical / cognitive notes (dementia, autism, meds)" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:6px;box-sizing:border-box;resize:vertical;"></textarea>'
    ) : '';
    ov.innerHTML='<div style="background:#fff;border-radius:18px;max-width:460px;width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;">'
      +'<div style="padding:16px 18px 12px;border-bottom:1px solid #eee;">'
        +'<div style="font-size:18px;font-weight:800;color:#7f1d1d;">'+(missing?'🔍 Start a Missing Person Search':'🎖️ Start a Command Night')+'</div>'
        +'<div style="font-size:12px;color:#666;margin-top:3px;">Added members share live location. You are the lead.</div>'
      +'</div>'
      +'<div style="padding:12px 18px;overflow-y:auto;flex:1;">'
        // Call linkage — ask up front
        +'<div style="font-size:12px;font-weight:700;color:#444;margin-bottom:6px;">This operation is for…</div>'
        +'<div style="display:flex;gap:8px;margin-bottom:8px;">'
          +'<button id="cmLinkModeExisting" onclick="cmSetLinkMode(\'existing\')" style="flex:1;padding:10px;border:1.5px solid #1e3a5f;background:#1e3a5f;color:#fff;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;">🔗 An existing call</button>'
          +'<button id="cmLinkModeNew" onclick="cmSetLinkMode(\'new\')" style="flex:1;padding:10px;border:1.5px solid #ccc;background:#fff;color:#333;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;">＋ A new call</button>'
        +'</div>'
        +'<select id="cmLinkCall" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:12px;box-sizing:border-box;">'
          +'<option value="">Select an open call…</option>'
          +openCalls.map(function(c){ var tl=cleanLabel?cleanLabel(CALL_TYPE_LABELS[c.type]||c.type||''):(c.type||''); return '<option value="'+c.id+'">'+(c.callNum?('#'+c.callNum+' '):'')+escapeHTML(tl+' · '+(c.town||''))+'</option>'; }).join('')
        +'</select>'
        +subjectHtml
        +'<div style="font-size:12px;font-weight:700;color:#444;margin:6px 0 8px;">Add members <span id="cmPickCount" style="color:#888;font-weight:600;"></span></div>'
        +'<input id="cmMemberSearch" placeholder="Filter…" oninput="cmFilterSetup(this.value)" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:8px;box-sizing:border-box;"/>'
        +'<div id="cmMemberPick">'+members.map(function(m){
            var u=U(m.unit||m.id); var nm=((m.firstName||m.name||'')+' '+(m.lastName||'')).trim();
            return '<div class="cmPick" data-u="'+u+'" data-n="'+escapeHTML(nm.toLowerCase())+'" onclick="cmTogglePick(\''+u+'\',this)" style="display:flex;align-items:center;gap:10px;padding:10px 8px;border-bottom:1px solid #f2f2f2;cursor:pointer;border-radius:8px;">'
              +'<span class="cmChk" style="width:20px;height:20px;border-radius:6px;border:2px solid #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;flex-shrink:0;"></span>'
              +'<span style="font-weight:700;color:#1a3a5c;">BC-'+u+'</span>'
              +'<span style="color:#666;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escapeHTML(nm)+'</span></div>';
          }).join('')+'</div>'
      +'</div>'
      +'<div style="padding:12px 18px 16px;border-top:1px solid #eee;display:flex;gap:10px;">'
        +'<button onclick="document.getElementById(\'cmSetup\').remove()" style="flex:1;padding:13px;background:#f1f1f1;border:none;border-radius:11px;font-size:14px;font-weight:700;cursor:pointer;">Cancel</button>'
        +'<button onclick="cmConfirmStart(\''+type+'\')" style="flex:1.5;padding:13px;background:#b91c1c;color:#fff;border:none;border-radius:11px;font-size:15px;font-weight:800;cursor:pointer;">'+(missing?'Start Search':'Start Command Night')+'</button>'
      +'</div></div>';
    document.body.appendChild(ov);
    cmSetLinkMode('existing');
  }
  var _cmLinkMode='existing', _cmPhotoData='';
  function cmSetLinkMode(mode){
    _cmLinkMode=mode;
    var ex=document.getElementById('cmLinkModeExisting'), nw=document.getElementById('cmLinkModeNew'), sel=document.getElementById('cmLinkCall');
    if(ex&&nw){
      var on='1.5px solid #1e3a5f',onbg='#1e3a5f',onc='#fff',off='1.5px solid #ccc',offbg='#fff',offc='#333';
      ex.style.border=mode==='existing'?on:off; ex.style.background=mode==='existing'?onbg:offbg; ex.style.color=mode==='existing'?onc:offc;
      nw.style.border=mode==='new'?on:off; nw.style.background=mode==='new'?onbg:offbg; nw.style.color=mode==='new'?onc:offc;
    }
    if(sel) sel.style.display=mode==='existing'?'block':'none';
  }
  function cmPhotoPick(ev){
    var f=ev&&ev.target&&ev.target.files&&ev.target.files[0]; if(!f) return;
    var rd=new FileReader();
    rd.onload=function(){
      var img=new Image();
      img.onload=function(){
        var mx=600, sc=Math.min(1,mx/Math.max(img.width,img.height));
        var cv=document.createElement('canvas'); cv.width=img.width*sc; cv.height=img.height*sc;
        cv.getContext('2d').drawImage(img,0,0,cv.width,cv.height);
        _cmPhotoData=cv.toDataURL('image/jpeg',0.7);
        var box=document.getElementById('mpPhotoBox'); if(box) box.style.backgroundImage='url('+_cmPhotoData+')', box.style.backgroundSize='cover', box.innerHTML='<input id="mpPhoto" type="file" accept="image/*" onchange="cmPhotoPick(event)" style="display:none;"/>';
      };
      img.src=rd.result;
    };
    rd.readAsDataURL(f);
  }
  function cmTogglePick(u,el){
    if(_cmPick[u]){ delete _cmPick[u]; } else { _cmPick[u]=true; }
    var on=!!_cmPick[u];
    if(el){ el.style.background=on?'#eef6ff':'transparent'; var chk=el.querySelector('.cmChk'); if(chk){ chk.style.background=on?'#1e3a5f':'#fff'; chk.style.borderColor=on?'#1e3a5f':'#cbd5e1'; chk.textContent=on?'✓':''; } }
    var c=document.getElementById('cmPickCount'); if(c){ var n=Object.keys(_cmPick).length; c.textContent=n?('· '+n+' selected'):''; }
  }  function cmFilterSetup(q){ q=(q||'').toLowerCase().trim(); document.querySelectorAll('#cmMemberPick .cmPick').forEach(function(el){ var hit=!q||el.dataset.u.indexOf(q)>=0||(el.dataset.n||'').indexOf(q)>=0; el.style.display=hit?'flex':'none'; }); }

  function cmConfirmStart(type){
    var mem=(STATE.members||[]);
    var members=Object.keys(_cmPick).map(function(u){ var m=mem.find(function(x){ return U(x.unit||x.id)===u; }); return { unit:u, name:m?((m.firstName||m.name||'')+' '+(m.lastName||'')).trim():'' }; });
    var me=myUnit();
    var payload={ active:true, type:type, startedBy:me, startedByName:(SESSION&&SESSION.name)||'', leadUnit:me, leadName:(SESSION&&SESSION.name)||'', startedAt:Date.now(), members:members, sectors:[], grid:[], linkedCallId:null, subject:null, endedAt:null };
    if(type==='missing'){
      payload.subject={
        name:(val('mpName')||'Unknown'), age:val('mpAge'), photo:_cmPhotoData||'',
        desc:val('mpDesc'), clothing:val('mpClothing'),
        lastSeenAddr:val('mpLastSeenAddr'), lastSeenTime:val('mpLastSeenTime'), medical:val('mpMedical'),
        lastSeenLat:null, lastSeenLng:null
      };
    }
    var finish=function(){
      db().collection('config').doc('commandMode').set(payload).then(function(){
        _cmAddLog((type==='missing'?'🔍 Missing Person search':'🎖️ Command night')+' started by BC-'+me+(members.length?(' · '+members.length+' members'):''),'start');
        var s=document.getElementById('cmSetup'); if(s) s.remove();
        _cmPhotoData='';
        showToast(type==='missing'?'🔍 Search started':'🎖️ Command night started');
        // geocode last-seen → pin + grid
        if(type==='missing'&&payload.subject.lastSeenAddr){ _cmGeocodeLastSeen(payload.subject.lastSeenAddr); }
        setTimeout(openCommandView,300);
      }).catch(function(e){ showToast('Could not start'); console.warn(e); });
    };
    // Call linkage
    if(_cmLinkMode==='existing'){
      payload.linkedCallId=val('cmLinkCall')||null; finish();
    } else {
      _cmCreateNewCall(type,payload.subject).then(function(id){ payload.linkedCallId=id||null; finish(); }).catch(function(){ finish(); });
    }
  }
  function val(id){ var el=document.getElementById(id); return el?(el.value||'').trim():''; }

  // Create a lightweight dispatch call so the op shows in the normal call list too.
  function _cmCreateNewCall(type,subject){
    return new Promise(function(resolve){
      try{
        var addr=subject?subject.lastSeenAddr:'';
        var call={ id:(type==='missing'?'mp_':'cmd_')+Date.now(), type:(type==='missing'?'other:Missing Person':'other:Command Event'),
          address:addr||'', town:'', caller:subject?subject.name:'', phone:'', notes:subject?('Last seen: '+(subject.lastSeenTime||'')+(subject.medical?(' · '+subject.medical):'')):'',
          status:'open', priority:'urgent', createdAt:Date.now(), createdBy:myUnit(), responders:[], pendingResponders:[] };
        var writeIt=function(){
          try{ STATE.calls=STATE.calls||[]; STATE.calls.unshift(call); if(typeof save==='function') save(); if(typeof renderCalls==='function') renderCalls(); }catch(e){}
          try{ db().collection('calls').doc(String(call.id)).set(call); }catch(e){}
          resolve(call.id);
        };
        if(typeof _nextCallNumAtomic==='function'){ _nextCallNumAtomic().then(function(n){ call.callNum=n; writeIt(); }).catch(writeIt); }
        else writeIt();
      }catch(e){ resolve(null); }
    });
  }

  function _cmGeocodeLastSeen(addr){
    try{
      geocodeCallAddress({address:addr,town:''}).then(function(g){
        if(!g) return;
        var sub=(_cmState&&_cmState.subject)||{}; sub.lastSeenLat=g.lat; sub.lastSeenLng=g.lng;
        var grid=_cmBuildGrid(g.lat,g.lng);
        db().collection('config').doc('commandMode').update({ subject:sub, grid:grid }).catch(function(){});
        _cmAddLog('📍 Last seen located — search grid generated','grid');
      });
    }catch(e){}
  }
  // Command drags the ★ pin (e.g. a park with no street address) → persist + regrid.
  function _cmMoveLastSeen(lat,lng){
    var sub=Object.assign({}, (_cmState&&_cmState.subject)||{});
    sub.lastSeenLat=lat; sub.lastSeenLng=lng;
    var grid=_cmBuildGrid(lat,lng);
    db().collection('config').doc('commandMode').update({ subject:sub, grid:grid }).catch(function(){});
    _cmAddLog('📍 Last-seen pin moved by BC-'+myUnit()+' — grid updated','grid');
    showToast('📍 Last-seen pin moved');
  }
  // 3×3 grid of ~0.4mi lettered cells around the last-seen point.
  function _cmBuildGrid(lat,lng){
    var cellMi=0.4, dLat=cellMi/69, dLng=cellMi/(69*Math.cos(lat*Math.PI/180));
    var letters='ABCDEFGHI', out=[], i=0;
    for(var r=1;r>=-1;r--){ for(var c=-1;c<=1;c++){
      out.push({ id:'g'+i, label:letters[i], lat:lat+r*dLat, lng:lng+c*dLng,
        n:lat+(r+0.5)*dLat, s:lat+(r-0.5)*dLat, e:lng+(c+0.5)*dLng, w:lng+(c-0.5)*dLng });
      i++;
    }}
    return out;
  }

  // ── Incident log ────────────────────────────────────────────────────────────
  function _cmAddLog(text,kind,channel){ try{ db().collection('commandLog').add({ at:Date.now(), text:String(text||''), kind:kind||'note', channel:channel||'note', by:myUnit() }).catch(function(){}); }catch(e){} }
  function _cmBoldCalls(s){ return String(s==null?'':s).replace(/#(\d+)/g,'<b>#$1</b>'); }
  var _cmChatTab='dispatch';
  function cmChatTab(t){ _cmChatTab=t; cmAddNote(); }
  function cmAddNote(){
    var defs=[{k:'dispatch',label:'💬 Dispatch'},{k:'members',label:'👥 Members'},{k:'note',label:'📝 Notes'}];
    var tabs=defs.map(function(d){ var on=_cmChatTab===d.k; return '<button onclick="cmChatTab(\''+d.k+'\')" style="flex:1;padding:9px 6px;border:none;border-radius:9px;font-family:inherit;font-size:12px;font-weight:800;cursor:pointer;background:'+(on?'#1e3a5f':'#f1f5f9')+';color:'+(on?'#fff':'#64748b')+';">'+d.label+'</button>'; }).join('');
    var msgs=(_cmLog||[]).filter(function(e){ return (e.channel||'note')===_cmChatTab; }).slice().reverse();
    var list=msgs.map(function(e){ var t=new Date(e.at||0).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); var mine=U(e.by)===myUnit(); return '<div style="display:flex;flex-direction:column;align-items:'+(mine?'flex-end':'flex-start')+';margin-bottom:8px;"><div style="max-width:82%;background:'+(mine?'#dbeafe':'#f1f5f9')+';color:#0f172a;border-radius:12px;padding:8px 11px;font-size:13px;line-height:1.4;">'+_cmBoldCalls(escapeHTML(e.text||''))+'</div><div style="font-size:10px;color:#94a3b8;margin-top:2px;">'+(e.by?'BC-'+U(e.by)+' · ':'')+t+'</div></div>'; }).join('')||'<div style="padding:16px;color:#9ca3af;font-size:13px;text-align:center;">'+(_cmChatTab==='note'?'No notes yet.':'No messages yet.')+'</div>';
    var isNote=_cmChatTab==='note';
    var body='<div style="display:flex;gap:6px;margin-bottom:12px;">'+tabs+'</div>'
      +'<div id="cmChatList" style="height:44vh;overflow-y:auto;-webkit-overflow-scrolling:touch;background:#fff;border:1px solid #eef2f7;border-radius:12px;padding:10px;margin-bottom:10px;">'+list+'</div>'
      +'<div style="display:flex;gap:8px;"><input id="cmChatInput" placeholder="'+(isNote?'Add a note…':'Message '+(_cmChatTab==='dispatch'?'dispatch':'members')+'…')+'" onkeydown="if(event.key===\'Enter\')cmChatSend()" style="flex:1;padding:12px;border:1.5px solid #ddd;border-radius:10px;font-size:14px;box-sizing:border-box;"/><button onclick="cmChatSend()" style="background:#1e3a5f;color:#fff;border:none;border-radius:10px;padding:0 18px;font-weight:800;font-size:14px;cursor:pointer;">'+(isNote?'Add':'Send')+'</button></div>';
    _cmSheet('📋 Command Comms', body);
    setTimeout(function(){ var l=document.getElementById('cmChatList'); if(l) l.scrollTop=l.scrollHeight; var i=document.getElementById('cmChatInput'); if(i) i.focus(); },30);
  }
  function cmChatSend(){ var i=document.getElementById('cmChatInput'); if(!i) return; var t=(i.value||'').trim(); if(!t) return; var entry={ at:Date.now(), text:t, kind:_cmChatTab==='note'?'note':'chat', channel:_cmChatTab, by:myUnit() }; _cmLog=_cmLog||[]; _cmLog.unshift(entry); _cmAddLog(t,entry.kind,_cmChatTab); i.value=''; cmAddNote(); }
  function cmPromptNote(){ _cmChatTab='note'; cmAddNote(); }
  // Detect newly-arrived chat/notes and alert: animate the Chat/Note buttons in the
  // command view + drop a banner. Routing: members-chat → everyone; dispatch-chat →
  // dispatch/admin only (never members); notes → Note button only.
  var _cmCommsSeen=0, _cmCommsInit=false;
  function _cmIsDispatchOrAdmin(){ try{ var r=(SESSION&&SESSION.role||'').toLowerCase(); return r==='dispatch'||r==='admin'; }catch(e){ return false; } }
  function _cmDetectNewComms(){
    var comms=(_cmLog||[]).filter(function(e){ return e.channel==='dispatch'||e.channel==='members'||e.kind==='note'||e.channel==='note'; });
    var newest=comms.reduce(function(mx,e){ return Math.max(mx,e.at||0); },0);
    if(!_cmCommsInit){ _cmCommsInit=true; _cmCommsSeen=newest; return; }
    if(newest<=_cmCommsSeen) return;
    var fresh=comms.filter(function(e){ return (e.at||0)>_cmCommsSeen && U(e.by)!==myUnit(); });
    _cmCommsSeen=newest;
    if(!fresh.length) return;
    var hasDispatch=fresh.some(function(e){ return e.channel==='dispatch'; });
    var hasMembers=fresh.some(function(e){ return e.channel==='members'; });
    var hasNote=fresh.some(function(e){ return e.kind==='note'||e.channel==='note'; });
    // Animate command-view buttons
    if(hasDispatch||hasMembers) _cmPulse('cmChatBtn');
    if(hasNote) _cmPulse('cmNoteBtn');
    if(hasDispatch||hasMembers||hasNote){ document.querySelectorAll('.cmChatTopBtn').forEach(function(b){ b.classList.add('cmCommsPulse'); }); }
    // Animate the member banner's Join Chat button + drop a banner alert
    var last=fresh[fresh.length-1];
    if(hasMembers){ _cmCommsBanner('💬 New member chat', last.text||'', 'members'); _cmPulse('cmBannerChatBtn'); }
    if(hasDispatch && _cmIsDispatchOrAdmin()){ _cmCommsBanner('💬 Dispatch chat', last.text||'', 'dispatch'); _cmPulse('cmBannerChatBtn'); }
  }
  function _cmPulse(id){ var el=document.getElementById(id); if(!el) return; el.classList.add('cmCommsPulse'); }
  function _cmClearPulse(id){ var el=document.getElementById(id); if(el) el.classList.remove('cmCommsPulse'); }
  function _cmCommsBanner(title,body,tab){
    // Members only get member-chat banners; dispatch/admin get both (dispatch filtered above)
    if(tab==='dispatch' && !_cmIsDispatchOrAdmin()) return;
    var b=document.getElementById('cmCommsBanner'); if(b) b.remove();
    b=document.createElement('div'); b.id='cmCommsBanner';
    b.style.cssText='position:fixed;left:12px;right:12px;top:calc(env(safe-area-inset-top) + 10px);z-index:10000;background:linear-gradient(135deg,#1d4ed8,#3b82f6);color:#fff;border-radius:14px;padding:12px 14px;box-shadow:0 8px 26px rgba(0,0,0,.35);display:flex;align-items:center;gap:11px;cursor:pointer;animation:cmSlideDown .25s ease;';
    b.innerHTML='<span style="font-size:20px;flex-shrink:0;">💬</span><div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:800;">'+escapeHTML(title)+'</div><div style="font-size:12px;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+escapeHTML(body)+'</div></div>';
    b.onclick=function(){ b.remove(); try{ if(document.getElementById('cmOverlay')) cmOpenChat(tab); else if(typeof cmMemberChat==='function') cmMemberChat(); }catch(e){} };
    document.body.appendChild(b);
    setTimeout(function(){ if(b&&b.parentNode) b.remove(); },6000);
  }
  function cmOpenChat(tab){ var m=document.getElementById('cmSheet'); if(m) m.remove(); _cmChatTab=tab; cmAddNote(); }
  function cmChatMenu(){ function opt(k,label,bg){ return '<button onclick="cmOpenChat(\''+k+'\')" style="width:100%;background:'+bg+';color:#fff;border:none;border-radius:12px;padding:15px;font-weight:800;font-size:15px;cursor:pointer;text-align:left;margin-bottom:10px;">'+label+'</button>'; } _cmSheet('💬 Open Chat', opt('dispatch','💬 Dispatch chat','#1e3a5f')+opt('members','👥 Members chat','#0e7490')+opt('note','📝 Notes / log','#374151')); }

  // ── Full-screen view ──────────────────────────────────────────────────────────
  function openCommandView(){
    if(!cmCanView()){ showToast('Not available'); return; }
    var old=document.getElementById('cmOverlay'); if(old) old.remove();
    var canEnd=(myUnit()===cmLeadUnit())||cmAmAdmin();
    var missing=cmIsMissing();
    var ov=document.createElement('div'); ov.id='cmOverlay';
    ov.style.cssText='position:fixed;inset:0;z-index:9700;background:#0f172a;display:flex;flex-direction:column;';
    ov.innerHTML=''
      +'<div style="flex-shrink:0;background:#0b1220;color:#fff;padding:calc(8px + env(safe-area-inset-top)) 12px 8px;display:flex;align-items:center;gap:12px;border-bottom:1px solid rgba(255,255,255,.1);">'
        +'<div style="display:flex;align-items:center;gap:9px;min-width:0;flex-shrink:0;"><span style="font-size:18px;">'+(missing?'🔍':'🎖️')+'</span><div style="min-width:0;"><div style="font-size:15px;font-weight:800;white-space:nowrap;">'+(missing?'Missing Person Search':'Command Center')+'</div><div style="font-size:11px;color:#94a3b8;white-space:nowrap;">Lead: BC-'+cmLeadUnit()+'</div></div></div>'
        +(missing?'':'<div id="cmStats" style="flex:1;min-width:0;display:flex;gap:7px;overflow-x:auto;align-items:center;"></div>')
        +'<div style="display:flex;gap:8px;flex-shrink:0;margin-left:auto;">'
          +(((cmAmAdmin()||myUnit()===cmLeadUnit()))?'<button onclick="cmEndNight()" style="background:#7f1d1d;color:#fff;border:none;border-radius:10px;padding:8px 16px;min-height:38px;font-size:13px;font-weight:800;cursor:pointer;">End</button>':'')
          +'<button onclick="closeCommandView()" style="background:rgba(255,255,255,.14);color:#fff;border:none;border-radius:10px;padding:8px 14px;min-height:38px;font-size:16px;font-weight:800;cursor:pointer;">✕</button>'
        +'</div>'
      +'</div>'
      +'<div id="cmBody" style="flex:1;display:flex;min-height:0;">'
        +'<div id="cmLeftCol" style="width:44%;max-width:360px;min-width:150px;flex-shrink:0;display:flex;flex-direction:column;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;border-right:1px solid rgba(255,255,255,.08);">'
          +'<div id="cmCallsPanel" style="flex:1 1 58%;min-height:160px;background:#0e1424;color:#e5e7eb;display:flex;flex-direction:column;overflow:hidden;"></div>'
          +'<div id="cmSidebar" style="flex:1 1 42%;min-height:120px;background:#111827;color:#e5e7eb;display:flex;flex-direction:column;overflow:hidden;border-top:2px solid rgba(255,255,255,.1);"></div>'
        +'</div>'
        +'<div id="cmMapWrap" style="flex:1;position:relative;min-width:0;"><div id="cmMap" style="position:absolute;inset:0;"></div>'
          +'<button onclick="cmToggleMapExpand()" id="cmMapExpandBtn" title="Expand map" style="position:absolute;top:10px;right:10px;z-index:6;background:rgba(11,18,32,.9);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:9px;width:40px;height:40px;font-size:17px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4);">⤢</button>'
          +'<div style="position:absolute;left:10px;bottom:10px;z-index:5;background:rgba(11,18,32,.85);color:#fff;border-radius:10px;padding:8px 11px;font-size:11px;line-height:1.7;">'
            +'<div><b style="color:#22c55e;">BC-##</b> on call &nbsp; <b style="color:#eab308;">BC-##</b> idle</div>'
            +'<div><b style="color:#9ca3af;">BC-##</b> stale &nbsp; <b style="color:#3b82f6;">BC-##</b> lead &nbsp; <b style="color:#ef4444;">▮</b> call</div>'
          +'</div>'
        +'</div>'
      +'</div>';
    document.body.appendChild(ov);
    _cmInjectStyle(); _cmBuildCallsPanel(); _cmBuildSidebar(); if(!missing) _cmBuildStats();
    _cmSeenStatus={}; _cmClosedHandled={}; (STATE.calls||[]).forEach(function(c){ _cmSeenStatus[c.id]=c.status; });
    if(_cmTick) clearInterval(_cmTick);
    _cmTick=setInterval(function(){ if(document.getElementById('cmOverlay')){ _cmDetectCompletions(); if(!cmIsMissing()){ _cmBuildStats(); _cmRenderCallRows(); } else { _cmRenderMissingCard(); } } else { clearInterval(_cmTick); _cmTick=null; } }, 4000);
    loadGoogleMapsAPI().then(_cmInitMap).catch(function(){ _cmMapFallback(); });
  }
  function cmToggleMapExpand(){
    var w=document.getElementById('cmMapWrap'); if(!w) return;
    var on=w.getAttribute('data-expanded')==='1';
    var btn=document.getElementById('cmMapExpandBtn');
    if(on){
      w.style.cssText='flex:1;position:relative;min-width:0;'; w.removeAttribute('data-expanded');
      if(btn){ btn.textContent='⤢'; btn.title='Expand map'; btn.style.top='10px'; btn.style.zIndex='6'; btn.style.background='rgba(11,18,32,.9)'; btn.style.width='40px'; btn.style.height='40px'; btn.style.fontSize='17px'; }
    } else {
      w.style.cssText='position:fixed;inset:0;width:100vw;height:100vh;z-index:9999;min-width:0;'; w.setAttribute('data-expanded','1');
      if(btn){ btn.textContent='✕'; btn.title='Exit full screen'; btn.style.top='calc(10px + env(safe-area-inset-top))'; btn.style.zIndex='10001'; btn.style.background='#dc2626'; btn.style.width='46px'; btn.style.height='46px'; btn.style.fontSize='20px'; }
    }
    try{ if(_cmMap&&_cmMap._isGoogle){ setTimeout(function(){ google.maps.event.trigger(_cmMap,'resize'); },60); } }catch(e){}
  }
  function closeCommandView(){ if(_cmTick){ clearInterval(_cmTick); _cmTick=null; } var o=document.getElementById('cmOverlay'); if(o) o.remove(); _cmMap=null; _cmMarkers={}; _cmCallMarkers={}; _cmGridShapes={}; _cmTrails={}; _cmLastSeenMk=null; _cmSelCall=null; }

  // ── Responsive EOC layout: style + view toggle (Calls / Map / Roster on narrow) ──
  function _cmInjectStyle(){
    if(document.getElementById('cmRespStyle')) return;
    var s=document.createElement('style'); s.id='cmRespStyle';
    s.textContent='#cmOverlay .cmStat{flex-shrink:0;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:9px;padding:4px 9px;text-align:center;}'
      +'#cmOverlay .cmStat .n{font-size:15px;font-weight:800;line-height:1;font-family:"DM Mono",monospace;}'
      +'#cmOverlay .cmStat .l{font-size:9.5px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em;margin-top:3px;white-space:nowrap;}'
      +'#cmOverlay .cmCallRow{cursor:pointer;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);}'
      +'#cmOverlay .cmCallRow:hover{background:rgba(255,255,255,.04);}'
      +'#cmOverlay .cmCallRow.sel{background:rgba(59,130,246,.14);box-shadow:inset 3px 0 0 #3b82f6;}'
      +'#cmOverlay .cmChipF{padding:5px 11px;border-radius:20px;font-size:11px;font-weight:700;border:1px solid rgba(255,255,255,.14);background:transparent;color:#94a3b8;cursor:pointer;white-space:nowrap;}'
      +'#cmOverlay .cmChipF.on{background:#1e3a5f;border-color:#1e3a5f;color:#fff;}'
      +'#cmCallRows{padding:8px 8px 2px;}'
      +'#cmCallRows .call-card{background:linear-gradient(135deg,rgba(212,169,58,.22),rgba(20,16,8,.6));border:1px solid rgba(255,255,255,.14);border-left:4px solid #f59e0b;border-radius:16px;overflow:hidden;margin-bottom:10px;box-shadow:0 2px 10px rgba(0,0,0,.3);}'
      +'#cmCallRows .call-card.active{background:linear-gradient(135deg,rgba(34,197,94,.5),rgba(8,30,16,.66));border-color:rgba(74,222,128,.5);}'
      +'#cmCallRows .call-card.urgent{background:linear-gradient(135deg,rgba(220,38,38,.72),rgba(120,10,10,.6) 55%,rgba(8,4,4,.78));border:2px solid rgba(248,113,113,.7);}'
      +'#cmCallRows .call-card.sel{outline:2px solid #3b82f6;outline-offset:-2px;}'
      +'#cmCallRows .call-card-addr{color:#fff!important;text-shadow:0 1px 3px rgba(0,0,0,.5);font-size:15px;}'
      +'#cmCallRows .call-card-corner{color:rgba(255,255,255,.85)!important;padding:0 13px 8px;}'
      +'#cmCallRows .call-card.active .call-card-type,#cmCallRows .call-card.urgent .call-card-type{color:#fff!important;}'
      +'@media (max-width:600px){'
        +'#cmOverlay #cmBody{flex-direction:column;overflow-y:auto;-webkit-overflow-scrolling:touch;}'
        +'#cmOverlay #cmMapWrap{order:1;flex:none;height:38vh;min-height:220px;}'
        +'#cmOverlay #cmLeftCol{order:2;width:100%!important;max-width:none!important;min-width:0!important;flex:none!important;overflow:visible!important;border-right:none;background:linear-gradient(180deg,#0e1424,#0a1a2b);}'
        +'#cmOverlay #cmCallsFilterRow{flex-direction:row!important;justify-content:center;align-items:center;gap:10px;}'
        +'#cmOverlay #cmCallsPanel{flex:none!important;min-height:0;}'
        +'#cmOverlay #cmCallRows{max-height:52vh;}'
        +'#cmOverlay #cmSidebar{order:3;flex:none!important;min-height:0;border-top:8px solid rgba(0,0,0,.35);}'
      +'}'
      +'@media (min-width:601px) and (max-height:520px){'
        +'#cmOverlay #cmLeftCol{overflow-y:auto!important;-webkit-overflow-scrolling:touch;}'
        +'#cmOverlay #cmCallsPanel{flex:none!important;min-height:0;}'
        +'#cmOverlay #cmCallRows{max-height:none;}'
        +'#cmOverlay #cmSidebar{flex:none!important;min-height:0;}'
      +'}';
    document.head.appendChild(s);
  }
  // ── Live stat widgets ──────────────────────────────────────────────────────
  function _cmBuildStats(){
    var el=document.getElementById('cmStats'); if(!el) return;
    var calls=(STATE.calls||[]).filter(function(c){ return c.status==='open'||c.status==='active'; });
    var urgent=calls.filter(function(c){ return c.priority==='urgent'; }).length;
    var respSet={}; calls.forEach(function(c){ (c.responders||[]).forEach(function(r){ respSet[U(r.unit)]=1; }); });
    var mem=cmMembers(), idle=0, nosig=0; mem.forEach(function(mm){ var col=_cmMemberColor(U(mm.unit),_cmLocs[U(mm.unit)]); if(col==='#eab308')idle++; else if(col==='#9ca3af')nosig++; });
    var gps=0, now=Date.now(); Object.keys(_cmLocs).forEach(function(u){ var l=_cmLocs[u]; if(l&&(now-(l.at||0))<CM_STALE_MS) gps++; });
    var t0=new Date(); t0.setHours(0,0,0,0); t0=t0.getTime();
    var times=(STATE.calls||[]).filter(function(c){ return c.status==='done'&&c.completedAt>=t0&&c.createdAt; }).map(function(c){ return (c.completedAt-c.createdAt)/60000; }).filter(function(m){ return m>0&&m<300; });
    var avg=times.length?(times.reduce(function(s,m){return s+m;},0)/times.length):null;
    function stat(n,l,color){ return '<div class="cmStat"><div class="n" style="color:'+(color||'#fff')+';">'+n+'</div><div class="l">'+l+'</div></div>'; }
    el.innerHTML=stat(calls.length,'Active',calls.length?'#f87171':'#fff')
      +stat(urgent,'Urgent',urgent?'#ef4444':'#64748b')
      +stat(Object.keys(respSet).length,'Responding','#22c55e')
      +stat(idle,'Idle','#eab308')
      +stat(nosig,'No signal','#9ca3af')
      +stat(gps+'/'+mem.length,'GPS live','#3b82f6');
  }

  // ── Active Calls panel ──────────────────────────────────────────────────────
  function _cmBuildCallsPanel(){
    var el=document.getElementById('cmCallsPanel'); if(!el) return;
    if(cmIsMissing()){
      var canEdit=cmAmAdmin()||myUnit()===cmLeadUnit();
      el.innerHTML=''
        +'<div style="flex-shrink:0;padding:10px 12px 8px;border-bottom:1px solid rgba(255,255,255,.06);">'
          +(canEdit?'<button onclick="cmEditReport()" style="width:100%;background:#1d4ed8;color:#fff;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:800;cursor:pointer;box-shadow:0 2px 8px rgba(29,78,216,.35);">✎ Edit Missing Person Report</button>':'')
          +'<div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;text-align:center;margin-top:'+(canEdit?'10px':'0')+';">Active Search</div>'
        +'</div>'
        +'<div id="cmCallRows" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;"></div>';
      _cmRenderMissingCard();
      return;
    }
    el.innerHTML=''
      +'<div style="flex-shrink:0;padding:10px 12px 8px;border-bottom:1px solid rgba(255,255,255,.06);">'
        +'<button onclick="cmNewCall()" style="width:100%;background:#dc2626;color:#fff;border:none;border-radius:10px;padding:11px;font-size:14px;font-weight:800;cursor:pointer;margin-bottom:10px;box-shadow:0 2px 8px rgba(220,38,38,.35);">＋ New Call</button>'
        +'<div id="cmCallsFilterRow" style="display:flex;flex-direction:column;align-items:center;gap:8px;">'
          +'<div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;">Active Calls</div>'
          +'<div style="display:flex;gap:6px;overflow-x:auto;justify-content:center;">'+['all','urgent','open','active'].map(function(f){ return '<button data-f="'+f+'" class="cmChipF'+(_cmCallFilter===f?' on':'')+'" onclick="cmSetCallFilter(\''+f+'\')">'+(f==='all'?'All':f.charAt(0).toUpperCase()+f.slice(1))+'</button>'; }).join('')+'</div>'
        +'</div>'
      +'</div>'
      +'<div id="cmCallRows" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;"></div>';
    _cmRenderCallRows();
  }
  // Single subject card (the one “call” for a missing-person op), styled like an active call card.
  function _cmRenderMissingCard(){
    var el=document.getElementById('cmCallRows'); if(!el) return;
    var s=(_cmState&&_cmState.subject)||{};
    var linked=(STATE.calls||[]).find(function(c){ return c.id===((_cmState&&_cmState.linkedCallId)); });
    var callNo=linked&&linked.callNum?('#'+linked.callNum):'';
    var started=(_cmState&&_cmState.startedAt)?new Date(_cmState.startedAt):null;
    var elapsed=started?Math.round((Date.now()-started.getTime())/60000):0;
    var elapsedStr=elapsed>=60?(Math.floor(elapsed/60)+'h '+(elapsed%60)+'m'):(elapsed+' min');
    function row(icon,label,val,color){ return val?('<div style="display:flex;gap:8px;font-size:13px;line-height:1.4;margin-top:6px;"><span style="flex-shrink:0;">'+icon+'</span><span style="color:'+(color||'#e5e7eb')+';"><b style="color:#94a3b8;font-weight:700;">'+label+'</b> '+escapeHTML(val)+'</span></div>'):''; }
    el.innerHTML='<div style="margin:8px;border-radius:14px;overflow:hidden;background:linear-gradient(160deg,#7f1d1d,#b91c1c);border:1px solid rgba(248,113,113,.5);box-shadow:0 2px 12px rgba(0,0,0,.35);">'
      +'<div style="background:var(--red,#dc2626);color:#fff;font-size:11px;font-weight:800;padding:5px 13px;letter-spacing:.5px;display:flex;justify-content:space-between;"><span>🔍 MISSING PERSON</span><span>'+(callNo||'')+'</span></div>'
      +'<div style="padding:13px;">'
        +'<div style="display:flex;gap:12px;align-items:flex-start;">'
          +(s.photo?'<img src="'+s.photo+'" style="width:70px;height:70px;border-radius:11px;object-fit:cover;flex-shrink:0;border:2px solid rgba(255,255,255,.5);"/>':'<div style="width:70px;height:70px;border-radius:11px;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;font-size:30px;flex-shrink:0;">👤</div>')
          +'<div style="min-width:0;flex:1;"><div style="font-size:19px;font-weight:800;color:#fff;line-height:1.1;">'+escapeHTML(s.name||'Unknown')+(s.age?(' <span style=\'font-size:14px;opacity:.85;\'>· '+escapeHTML(s.age)+'</span>'):'')+'</div>'
            +'<div style="font-size:12px;color:#fecaca;margin-top:3px;">Searching '+elapsedStr+'</div></div>'
        +'</div>'
        +row('📍','Last seen',(s.lastSeenAddr||'')+(s.lastSeenTime?(' · '+s.lastSeenTime):''),'#fff')
        +row('👤','Description',s.desc,'#fff')
        +row('👕','Clothing',s.clothing,'#fde68a')
        +row('⚕️','Medical',s.medical,'#fca5a5')
        +(linked&&linked.phone?'<a href="tel:'+linked.phone+'" style="display:inline-block;margin-top:10px;background:rgba(34,197,94,.25);border:1px solid rgba(34,197,94,.55);color:#fff;text-decoration:none;border-radius:9px;padding:7px 13px;font-size:13px;font-weight:800;">📞 Caller</a>':'')
      +'</div></div>';
  }
  // Edit the missing-person report: subject fields → config.subject, re-geocode
  // last-seen if it changed, and keep the linked dispatch call in sync.
  function cmEditReport(){
    if(!(cmAmAdmin()||myUnit()===cmLeadUnit())){ showToast('Only the lead or an admin can edit'); return; }
    var s=(_cmState&&_cmState.subject)||{};
    function fld(id,label,val,ph){ return '<label style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.04em;display:block;margin-top:10px;">'+label+'</label><input id="'+id+'" value="'+escapeHTML(val||'')+'" placeholder="'+(ph||'')+'" style="width:100%;padding:10px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-top:4px;box-sizing:border-box;"/>'; }
    var body=''
      +'<div style="display:flex;gap:10px;align-items:center;">'
        +'<label id="mpEditPhotoBox" style="width:70px;height:70px;border-radius:11px;background:#f1f5f9;border:1.5px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:11px;color:#64748b;text-align:center;cursor:pointer;overflow:hidden;flex-shrink:0;">'+(s.photo?'<img src="'+s.photo+'" style="width:100%;height:100%;object-fit:cover;"/>':'Photo')+'<input type="file" accept="image/*" onchange="cmPhotoPick(event,\'mpEditPhotoBox\')" style="display:none;"/></label>'
        +'<div style="flex:1;">'+fld('mpeName','Name',s.name,'Full name')+'</div>'
      +'</div>'
      +'<div style="display:flex;gap:10px;"><div style="flex:1;">'+fld('mpeAge','Age',s.age,'e.g. 74')+'</div></div>'
      +fld('mpeAddr','Last seen — address',s.lastSeenAddr,'Street, town')
      +fld('mpeTime','Last seen — time',s.lastSeenTime,'e.g. 3:15 PM')
      +fld('mpeDesc','Description',s.desc,'Height, build, hair…')
      +fld('mpeClothing','Clothing',s.clothing,'What they were wearing')
      +fld('mpeMedical','Medical / notes',s.medical,'Conditions, meds, risk')
      +'<button onclick="cmSaveReport()" style="width:100%;margin-top:16px;background:#16a34a;color:#fff;border:none;border-radius:12px;padding:14px;font-weight:800;font-size:15px;cursor:pointer;">Save report</button>';
    _cmSheet('✎ Edit Missing Person Report', body);
  }
  function cmSaveReport(){
    var g=function(id){ var e=document.getElementById(id); return e?e.value.trim():''; };
    var s=Object.assign({}, (_cmState&&_cmState.subject)||{});
    var oldAddr=s.lastSeenAddr||'';
    s.name=g('mpeName')||'Unknown'; s.age=g('mpeAge'); s.lastSeenAddr=g('mpeAddr'); s.lastSeenTime=g('mpeTime');
    s.desc=g('mpeDesc'); s.clothing=g('mpeClothing'); s.medical=g('mpeMedical');
    if(_cmPhotoData){ s.photo=_cmPhotoData; }
    db().collection('config').doc('commandMode').update({ subject:s }).catch(function(){});
    // Keep the linked dispatch call in sync (caller name, address, notes)
    try{
      var linked=(STATE.calls||[]).find(function(c){ return c.id===((_cmState&&_cmState.linkedCallId)); });
      if(linked){ linked.caller=s.name; linked.address=s.lastSeenAddr||linked.address; linked.notes='Last seen: '+(s.lastSeenTime||'')+(s.medical?(' · '+s.medical):''); _cmSyncCall(linked); }
    }catch(e){}
    if(s.lastSeenAddr && s.lastSeenAddr!==oldAddr){ _cmGeocodeLastSeen(s.lastSeenAddr); }
    _cmPhotoData=''; _cmAddLog('✎ Report updated by BC-'+myUnit(),'note');
    var sh=document.getElementById('cmSheet'); if(sh) sh.remove(); showToast('✅ Report saved'); _cmRenderMissingCard();
  }
  function cmSetCallFilter(f){ _cmCallFilter=f; var p=document.getElementById('cmCallsPanel'); if(p) p.querySelectorAll('.cmChipF').forEach(function(b){ b.classList.toggle('on', b.getAttribute('data-f')===f); }); _cmRenderCallRows(); }
  function cmCallSearchInput(v){ _cmCallSearch=v; _cmRenderCallRows(); }
  function _cmActiveCalls(){
    var arr=(STATE.calls||[]).filter(function(c){ return c.status==='open'||c.status==='active'; });
    if(_cmCallFilter==='urgent') arr=arr.filter(function(c){ return c.priority==='urgent'; });
    else if(_cmCallFilter==='open') arr=arr.filter(function(c){ return c.status==='open'; });
    else if(_cmCallFilter==='active') arr=arr.filter(function(c){ return c.status==='active'; });
    var q=(_cmCallSearch||'').toLowerCase().trim();
    if(q) arr=arr.filter(function(c){ var tl=cleanLabel?cleanLabel(CALL_TYPE_LABELS[c.type]||c.type||''):(c.type||''); return (('#'+(c.callNum||''))+' '+tl+' '+(c.town||'')+' '+(c.address||'')+' bc-'+U(c.createdBy||'')).toLowerCase().indexOf(q)>=0; });
    arr.sort(function(a,b){ var au=a.priority==='urgent'?0:1, bu=b.priority==='urgent'?0:1; return au-bu||(b.createdAt||0)-(a.createdAt||0); });
    return arr;
  }
  function _cmRenderCallRows(){
    var el=document.getElementById('cmCallRows'); if(!el) return;
    var TC=(typeof TOWN_COLORS!=='undefined'&&TOWN_COLORS)?TOWN_COLORS:{};
    el.innerHTML=_cmActiveCalls().map(function(c){
      var urgent=c.priority==='urgent'&&c.status!=='done';
      var cls=urgent?'urgent':(c.status||'open');
      var typeRaw=c.type||'other';
      var tl=cleanLabel?cleanLabel(typeRaw.indexOf('other:')===0?typeRaw.replace('other:',''):(CALL_TYPE_LABELS[typeRaw]||typeRaw)):typeRaw;
      var town=cardTown?cardTown(c):(c.town||'');
      var tcol=(TC[town]||TC.Other||'#f59e0b');
      var ts=c.createdAt?new Date(c.createdAt):null;
      var timeStr=ts?((ts.toLocaleDateString('en-US',{month:'numeric',day:'numeric'}))+' · '+ts.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})):'';
      var addr=(typeof fmtLocCardHTML==='function')?fmtLocCardHTML(c):escapeHTML(String(c.address||'').replace(/\s*—?\s*📍.*$/,''));
      var badges=(typeof _respNumBadges==='function')?(_respNumBadges(c)||''):'';
      var pending=(c.pendingResponders||[]).length;
      var sc=c.status==='active'?'#16a34a':'#d97706';
      var townChip=town?'<span style="display:inline-flex;align-items:center;background:color-mix(in srgb,'+tcol+' 24%,transparent);border:1px solid color-mix(in srgb,'+tcol+' 55%,transparent);color:#fff;padding:2px 10px;border-radius:7px;font-size:13px;font-weight:700;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.45);">'+escapeHTML(town)+'</span>':'<span></span>';
      var cardBg=urgent?'linear-gradient(160deg,#7f1d1d,#b91c1c)':(c.status==='active'?'linear-gradient(160deg,#14532d,#16a34a)':'linear-gradient(160deg,#1e293b,#334155)');
      return '<div class="call-card '+cls+(_cmSelCall===c.id?' sel':'')+'" onclick="_cmCallPopup(\''+c.id+'\')" style="cursor:pointer;background:'+cardBg+';border-radius:12px;border-left:4px solid '+(urgent?'#ef4444':c.status==='active'?'#22c55e':'#64748b')+';">'
        +(urgent?'<div style="background:var(--red);color:#fff;font-size:11px;font-weight:800;padding:4px 13px;letter-spacing:.5px;">URGENT</div>':'')
        +'<div class="call-card-header">'
          +'<div style="flex:1;min-width:0;">'
            +'<div class="call-card-type" style="color:'+(urgent?'var(--red)':tcol)+';">'+escapeHTML(tl)+'</div>'
            +'<div class="call-card-addr">'+addr+'</div>'
            +(c.notes?'<div style="font-size:13px;font-weight:600;color:#fff;margin-top:6px;padding:7px 10px;background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.16);border-radius:9px;line-height:1.4;text-shadow:0 1px 2px rgba(0,0,0,.35);">'+escapeHTML(c.notes)+'</div>':'')
          +'</div>'
          +'<div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0;">'
            +'<div style="background:'+sc+';color:#fff;padding:4px 11px;border-radius:8px;font-size:12px;font-weight:800;letter-spacing:.4px;text-shadow:0 1px 1px rgba(0,0,0,.3);">'+(c.status||'open').toUpperCase()+'</div>'
            +(pending?'<div style="background:var(--amber);color:#fff;padding:3px 9px;border-radius:7px;font-size:11px;font-weight:800;white-space:nowrap;">⏳ '+pending+'</div>':'')
          +'</div>'
        +'</div>'
        +(badges?'<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:0 13px;margin:2px 0 4px;">'+badges+'</div>':'')
        +'<div class="call-card-corner">'+townChip+'<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap;">'+(c.phone?'<a href="tel:'+c.phone+'" onclick="event.stopPropagation()" title="Call caller" style="text-decoration:none;font-size:15px;background:rgba(34,197,94,.22);border:1px solid rgba(34,197,94,.5);border-radius:7px;padding:1px 7px;">📞</a>':'')+'<span style="font-family:\'DM Mono\',monospace;font-weight:700;">#'+(c.callNum||'—')+'</span><span style="opacity:.55;">·</span><span>'+timeStr+'</span></span></div>'
      +'</div>';
    }).join('')||'<div style="padding:16px 12px;color:#64748b;font-size:12px;">No active calls.</div>';
  }
  function _cmLogLabel(e){
    var who=e.responder?(' · BC-'+U(e.responder)):(e.dispatcher?(' · BC-'+U(e.dispatcher)):(e.by?(' · BC-'+U(e.by)):''));
    var m={ responder_pending:'Requested to respond', responder_approved:'Responder approved', auto_approved:'Auto-approved (urgent)', completed:'Call completed', cancelled:'Call cancelled', created:'Call created', escalated:'Escalated to urgent', deescalated:'De-escalated' };
    return (m[e.action]||String(e.action||'update').replace(/_/g,' '))+who;
  }
  function _cmSyncCall(c){ try{ if(typeof firestoreUpsertCall==='function') firestoreUpsertCall(c); else db().collection('calls').doc(String(c.id)).set(c,{merge:true}); }catch(e){} try{ if(typeof save==='function') save(); if(typeof renderCalls==='function') renderCalls(); }catch(e){} }
  function cmEscalate(id){
    var c=(STATE.calls||[]).find(function(x){ return x.id===id; }); if(!c) return;
    var to=c.priority==='urgent'?'normal':'urgent'; c.priority=to;
    try{ if(typeof logCallEvent==='function') logCallEvent(c, to==='urgent'?'escalated':'deescalated', {by:myUnit()}); }catch(e){}
    _cmSyncCall(c); _cmAddLog((to==='urgent'?'▲ Escalated':'▽ De-escalated')+' call #'+(c.callNum||'')+' by BC-'+myUnit(),'status');
    if(to==='urgent'){ cmMembers().forEach(function(mm){ try{ sendPush({ target:'unit', unit:U(mm.unit), title:'🚨 Escalated', body:'Call #'+(c.callNum||'')+' escalated to URGENT', url:'/cobc-dispatch/?page=dispatch', urgent:'true' }); }catch(e){} }); }
    showToast(to==='urgent'?'🚨 Escalated':'De-escalated'); _cmCallPopup(id);
  }
  function _cmCallTypeLabel(c){ var r=(c&&c.type)||''; return cleanLabel?cleanLabel(r.indexOf('other:')===0?r.replace('other:',''):(CALL_TYPE_LABELS[r]||r)):r; }
  function cmClearCall(id){
    var c=(STATE.calls||[]).find(function(x){ return x.id===id; }); if(!c) return;
    if(!confirm('Clear (complete) call #'+(c.callNum||'')+'? It leaves the active board.')) return;
    _cmClosedHandled[id]=1;   // this device owns the closing note; skip auto-detect
    c.status='done'; c.completedAt=Date.now(); c.completedBy=myUnit();
    try{ if(typeof logCallEvent==='function') logCallEvent(c,'completed',{by:myUnit(),responders:(c.responders||[]).length,durationMin:Math.round((c.completedAt-c.createdAt)/60000),viaCommand:true}); }catch(e){}
    _cmSyncCall(c);
    showToast('Call cleared'); _cmSelCall=null; _cmRefreshView();
    _cmCloseNotePrompt(id);   // ask command for a closing note
  }
  function _cmCloseNotePrompt(id){
    var c=(STATE.calls||[]).find(function(x){ return x.id===id; }); if(!c) return;
    var tl=_cmCallTypeLabel(c), phone=c.phone||c.callerPhone||'';
    var body=''
      +'<div style="font-size:13px;color:#111827;font-weight:800;margin-bottom:3px;">Call #'+(c.callNum||'')+' · '+escapeHTML(tl)+'</div>'
      +'<div style="font-size:12px;color:#6b7280;margin-bottom:12px;">'+(phone?('☎ '+escapeHTML(phone)):'no phone on file')+'</div>'
      +'<label style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.04em;">Closing notes</label>'
      +'<textarea id="cmCloseNote" rows="3" placeholder="Outcome / disposition / what happened…" style="width:100%;padding:11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin:6px 0 12px;box-sizing:border-box;resize:vertical;"></textarea>'
      +'<div style="display:flex;gap:8px;"><button onclick="cmSkipCloseNote(\''+id+'\')" style="flex:1;background:#f1f5f9;color:#475569;border:none;border-radius:10px;padding:13px;font-weight:800;font-size:14px;cursor:pointer;">Skip</button><button onclick="cmSaveCloseNote(\''+id+'\')" style="flex:1.5;background:#16a34a;color:#fff;border:none;border-radius:10px;padding:13px;font-weight:800;font-size:14px;cursor:pointer;">Save note</button></div>';
    _cmSheet('📝 Closing note — Call #'+(c.callNum||''), body);
  }
  function _cmClosingLog(c,note){
    var tl=_cmCallTypeLabel(c), phone=c.phone||c.callerPhone||'';
    _cmAddLog('✅ Call #'+(c.callNum||'')+' completed · '+tl+(phone?(' · ☎ '+phone):'')+(note?(' · “'+note+'”'):'')+' — by BC-'+myUnit(),'status');
    if(note){ try{ if(typeof logCallEvent==='function') logCallEvent(c,'note',{note:'Closing note: '+note, by:myUnit(), viaCommand:true}); }catch(e){} }
    try{ c.cmClosed=true; _cmSyncCall(c); }catch(e){}
  }
  // Fire the closing-note prompt whenever a call flips to done while an op is open —
  // whether command cleared it, a dispatcher completed it, or a member's close
  // request (CC/CNC) was approved. c.cmClosed (synced) dedupes across devices.
  function _cmDetectCompletions(){
    if(!cmIsActive()||!document.getElementById('cmOverlay')) return;
    (STATE.calls||[]).forEach(function(c){
      var prev=_cmSeenStatus[c.id]; _cmSeenStatus[c.id]=c.status;
      if(prev===undefined||c.status!=='done'||prev==='done') return;
      if(_cmClosedHandled[c.id]){ return; }
      if(c.cmClosed){ _cmClosedHandled[c.id]=1; return; }
      _cmClosedHandled[c.id]=1;
      _cmCloseNotePrompt(c.id);
    });
  }
  function cmSaveCloseNote(id){
    var c=(STATE.calls||[]).find(function(x){ return x.id===id; }); if(!c){ var s0=document.getElementById('cmSheet'); if(s0) s0.remove(); return; }
    var el=document.getElementById('cmCloseNote'); var note=el?(el.value||'').trim():'';
    if(note){ c.notes=(c.notes?(c.notes+' | '):'')+'Closing note (BC-'+myUnit()+'): '+note; try{ _cmSyncCall(c); }catch(e){} }
    _cmClosingLog(c,note); var s=document.getElementById('cmSheet'); if(s) s.remove(); showToast(note?'Note saved to log':'Call completed');
  }
  function cmSkipCloseNote(id){ var c=(STATE.calls||[]).find(function(x){ return x.id===id; }); if(c) _cmClosingLog(c,''); var s=document.getElementById('cmSheet'); if(s) s.remove(); }
  function cmCancelCallCmd(id){
    var c=(STATE.calls||[]).find(function(x){ return x.id===id; }); if(!c) return;
    if(typeof window.cancelCall==='function'){ var s=document.getElementById('cmSheet'); if(s) s.remove(); try{ window.cancelCall(id); }catch(e){} _cmAddLog('✕ Call #'+(c.callNum||'')+' cancel requested by BC-'+myUnit(),'status'); setTimeout(_cmRefreshView,400); return; }
    if(!confirm('Cancel call #'+(c.callNum||'')+'?')) return;
    c.status='cancelled'; c.cancelledAt=Date.now();
    try{ if(typeof logCallEvent==='function') logCallEvent(c,'cancelled',{by:myUnit(),viaCommand:true}); }catch(e){}
    _cmSyncCall(c); _cmAddLog('✕ Call #'+(c.callNum||'')+' cancelled by BC-'+myUnit(),'status');
    showToast('Call cancelled'); var s2=document.getElementById('cmSheet'); if(s2) s2.remove(); _cmSelCall=null; _cmRefreshView();
  }

  function _cmRenderSubjectBar(){
    if(!cmIsMissing()) return; var el=document.getElementById('cmSubjectBar'); if(!el) return;
    var s=(_cmState&&_cmState.subject)||{};
    el.innerHTML='<div style="display:flex;gap:12px;padding:10px 14px;color:#fde68a;align-items:center;">'
      +(s.photo?'<img src="'+s.photo+'" style="width:56px;height:56px;border-radius:10px;object-fit:cover;flex-shrink:0;border:2px solid #b45309;"/>':'<div style="width:56px;height:56px;border-radius:10px;background:#3f2d0a;display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0;">👤</div>')
      +'<div style="min-width:0;font-size:12px;line-height:1.5;">'
        +'<div style="font-size:15px;font-weight:800;color:#fff;">'+escapeHTML(s.name||'Unknown')+(s.age?(' · '+escapeHTML(s.age)):'')+'</div>'
        +(s.desc?'<div>'+escapeHTML(s.desc)+'</div>':'')
        +(s.clothing?'<div style="color:#fcd34d;">👕 '+escapeHTML(s.clothing)+'</div>':'')
        +(s.lastSeenAddr?'<div style="color:#fca5a5;">📍 Last seen '+escapeHTML(s.lastSeenAddr)+(s.lastSeenTime?(' · '+escapeHTML(s.lastSeenTime)):'')+'</div>':'')
        +(s.medical?'<div style="color:#f87171;font-weight:700;">⚕️ '+escapeHTML(s.medical)+'</div>':'')
      +'</div></div>';
  }

  function _cmInitMap(){
    var el=document.getElementById('cmMap'); if(!el) return;
    _cmMap=new google.maps.Map(el,{ center:{lat:40.8976,lng:-74.0160}, zoom:13, mapTypeControl:false, streetViewControl:false, fullscreenControl:false, styles:[{elementType:'geometry',stylers:[{color:'#1d2c4d'}]},{elementType:'labels.text.fill',stylers:[{color:'#8ec3b9'}]},{elementType:'labels.text.stroke',stylers:[{color:'#1a3646'}]},{featureType:'road',elementType:'geometry',stylers:[{color:'#304a7d'}]},{featureType:'water',elementType:'geometry',stylers:[{color:'#0e1626'}]},{featureType:'poi',stylers:[{visibility:'off'}]}] });
    _cmMap._isGoogle=true;
    // Freehand drawing (missing mode): mousedown starts a line, drag extends it.
    _cmMap.addListener('mousedown', function(e){ if(_cmDrawMode==='draw'){ _cmDrawStart(e.latLng); } });
    _cmMap.addListener('mousemove', function(e){ if(_cmDrawMode==='draw'&&_cmCurDraw){ _cmDrawExtend(e.latLng); } });
    _cmMap.addListener('mouseup', function(){ if(_cmDrawMode==='draw'&&_cmCurDraw){ _cmDrawEnd(); } });
    _cmRefreshView();
  }
  function _cmDrawStart(ll){ var id='d'+Date.now(); _cmCurDraw={ id:id, points:[{lat:ll.lat(),lng:ll.lng()}], poly:new google.maps.Polyline({ map:_cmMap, path:[{lat:ll.lat(),lng:ll.lng()}], strokeColor:'#f472b6', strokeWeight:4, strokeOpacity:0.95 }) }; }
  function _cmDrawExtend(ll){ _cmCurDraw.points.push({lat:ll.lat(),lng:ll.lng()}); _cmCurDraw.poly.setPath(_cmCurDraw.points); }
  function _cmDrawEnd(){
    if(!_cmCurDraw||_cmCurDraw.points.length<2){ if(_cmCurDraw&&_cmCurDraw.poly) _cmCurDraw.poly.setMap(null); _cmCurDraw=null; return; }
    var drawings=((_cmState&&_cmState.drawings)||[]).concat([{ id:_cmCurDraw.id, points:_cmCurDraw.points }]);
    _cmCurDraw.poly.setMap(null); _cmCurDraw=null;
    db().collection('config').doc('commandMode').update({ drawings:drawings }).catch(function(){});
  }
  function cmToggleDraw(){ _cmDrawMode=_cmDrawMode==='draw'?'off':'draw'; _cmDrawSync(); }
  function cmToggleErase(){ _cmDrawMode=_cmDrawMode==='erase'?'off':'erase'; _cmDrawSync(); }
  function _cmDrawSync(){
    if(_cmMap&&_cmMap._isGoogle) _cmMap.setOptions({ draggable:_cmDrawMode==='off', gestureHandling:_cmDrawMode==='off'?'auto':'none' });
    var d=document.getElementById('cmDrawBtn'), e=document.getElementById('cmEraseBtn');
    if(d){ d.style.background=_cmDrawMode==='draw'?'#db2777':'#7c3aed'; d.textContent=_cmDrawMode==='draw'?'✏️ Drawing…':'✏️ Draw'; }
    if(e){ e.style.background=_cmDrawMode==='erase'?'#dc2626':'#4b5563'; e.textContent=_cmDrawMode==='erase'?'🧹 Tap a line':'🧹 Erase'; }
    showToast(_cmDrawMode==='draw'?'Drag on the map to draw':_cmDrawMode==='erase'?'Tap a drawn line to erase it':'Drawing off');
  }
  function _cmEraseDrawing(id){
    var drawings=((_cmState&&_cmState.drawings)||[]).filter(function(x){ return x.id!==id; });
    db().collection('config').doc('commandMode').update({ drawings:drawings }).catch(function(){});
  }
  function _cmMapFallback(){ var el=document.getElementById('cmMap'); if(el) el.innerHTML='<div style="color:#94a3b8;padding:20px;font-size:13px;">Map unavailable — check connection.</div>'; }
  function _transIcon(){ return { url:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'), size:new google.maps.Size(1,1), anchor:new google.maps.Point(0,0) }; }
  function _cmDotIcon(color,big){ var r=big?7:6, s=big?20:18, c=s/2; var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+s+'" height="'+s+'"><circle cx="'+c+'" cy="'+c+'" r="'+r+'" fill="'+color+'" stroke="#fff" stroke-width="2.5"/></svg>'; return { url:'data:image/svg+xml;base64,'+btoa(svg), size:new google.maps.Size(s,s), anchor:new google.maps.Point(c,c), labelOrigin:new google.maps.Point(c,s+8) }; }
  function _cmUnitOnCall(u){ try{ return (STATE.calls||[]).some(function(c){ if(c.status!=='open'&&c.status!=='active') return false; return (c.responders||[]).some(function(r){ return U(r.unit)===u; }); }); }catch(e){ return false; } }
  function _cmMemberColor(u,loc){ if(u===cmLeadUnit()) return '#3b82f6'; if(!loc||(Date.now()-(loc.at||0))>CM_STALE_MS) return '#9ca3af'; return _cmUnitOnCall(u)?'#22c55e':'#eab308'; }
  function _cmCallLatLng(call){
    if(_cmCallCoords[call.id]) return _cmCallCoords[call.id];
    var m=String(call.address||'').match(/(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
    if(m){ var v={lat:parseFloat(m[1]),lng:parseFloat(m[2])}; _cmCallCoords[call.id]=v; return v; }
    try{ geocodeCallAddress(call).then(function(g){ if(g){ _cmCallCoords[call.id]=g; if(document.getElementById('cmOverlay')) _cmRefreshView(); } }); }catch(e){}
    return null;
  }

  function _cmRefreshView(){
    _cmDetectCompletions();
    if(!cmIsMissing()){ _cmBuildStats(); _cmRenderCallRows(); } else { _cmRenderMissingCard(); }
    if(!_cmMap||!_cmMap._isGoogle){ _cmBuildSidebar(); return; }
    var G=google.maps, seen={};
    // Members + breadcrumb trails
    cmMembers().forEach(function(mm){
      var u=U(mm.unit); var loc=_cmLocs[u]; if(!loc) return; seen[u]=1;
      var color=_cmMemberColor(u,loc);
      var mk=_cmMarkers[u];
      if(!mk){ mk=new G.Marker({ map:_cmMap }); mk.addListener('click', function(){ _cmMemberPopup(u); }); _cmMarkers[u]=mk; }
      mk.setPosition({lat:loc.lat,lng:loc.lng});
      mk.setIcon(_cmDotIcon(color));
      mk.setLabel({ text:'BC-'+u, color:color, fontWeight:'800', fontSize:'13px' });
      if(cmIsMissing() && Array.isArray(loc.trail) && loc.trail.length>1){
        var path=loc.trail.map(function(p){ return {lat:p.lat,lng:p.lng}; });
        if(_cmTrails[u]) _cmTrails[u].setPath(path);
        else _cmTrails[u]=new G.Polyline({ map:_cmMap, path:path, strokeColor:color, strokeOpacity:0.6, strokeWeight:3 });
        _cmTrails[u].setOptions({strokeColor:color});
      }
    });
    Object.keys(_cmMarkers).forEach(function(u){ if(!seen[u]){ _cmMarkers[u].setMap(null); delete _cmMarkers[u]; if(_cmTrails[u]){ _cmTrails[u].setMap(null); delete _cmTrails[u]; } } });
    // Calls
    var cseen={};
    (STATE.calls||[]).forEach(function(c){
      if(c.status!=='open'&&c.status!=='active') return;
      var ll=_cmCallLatLng(c); if(!ll) return; cseen[c.id]=1;
      var _street=String(c.address||'').replace(/\s*—?\s*📍.*$/,'').split(',')[0].trim();
      var lbl='#'+(c.callNum||'')+(_street?(' · '+_street):'');
      var mk=_cmCallMarkers[c.id];
      if(!mk){ mk=new G.Marker({ map:_cmMap, zIndex:999 }); mk.addListener('click', function(){ if(typeof openCallDetail==='function'){ openCallDetail(c.id); _cmRaise('callDetailModal'); } else _cmCallPopup(c.id); }); _cmCallMarkers[c.id]=mk; }
      mk.setPosition(ll); mk.setIcon(_cmDotIcon(c.priority==='urgent'?'#dc2626':'#ef4444',true)); mk.setLabel({ text:lbl, color:'#fff', fontWeight:'800', fontSize:'13px' });
    });
    Object.keys(_cmCallMarkers).forEach(function(id){ if(!cseen[id]){ _cmCallMarkers[id].setMap(null); delete _cmCallMarkers[id]; } });
    // Missing: last-seen pin + auto grid
    if(cmIsMissing()){
      var sub=(_cmState&&_cmState.subject)||{};
      if(sub.lastSeenLat!=null){
        var _canDragPin=(cmAmAdmin()||myUnit()===cmLeadUnit());
        if(!_cmLastSeenMk){ _cmLastSeenMk=new G.Marker({ map:_cmMap, icon:_transIcon(), zIndex:1200, draggable:_canDragPin, cursor:_canDragPin?'move':'default' }); _cmMap.setCenter({lat:sub.lastSeenLat,lng:sub.lastSeenLng}); _cmMap.setZoom(15);
          if(_canDragPin){ _cmLastSeenMk.addListener('dragend', function(e){ _cmMoveLastSeen(e.latLng.lat(), e.latLng.lng()); }); }
        }
        _cmLastSeenMk.setDraggable(_canDragPin);
        _cmLastSeenMk.setPosition({lat:sub.lastSeenLat,lng:sub.lastSeenLng});
        _cmLastSeenMk.setLabel({ text:(_canDragPin?'★ Last seen (drag)':'★ Last seen'), color:'#f59e0b', fontWeight:'800', fontSize:'14px' });
      }
      var gseen={};
      ((_cmState&&_cmState.grid)||[]).forEach(function(g){
        gseen[g.id]=1;
        if(!_cmGridShapes[g.id]){
          _cmGridShapes[g.id]={
            rect:new G.Rectangle({ map:_cmMap, bounds:{north:g.n,south:g.s,east:g.e,west:g.w}, strokeColor:'#a78bfa', strokeOpacity:0.7, strokeWeight:1, fillColor:'#a78bfa', fillOpacity:0.06 }),
            lbl:new G.Marker({ map:_cmMap, position:{lat:g.lat,lng:g.lng}, icon:_transIcon(), label:{ text:g.label, color:'#c4b5fd', fontWeight:'800', fontSize:'16px' } })
          };
        }
      });
      Object.keys(_cmGridShapes).forEach(function(id){ if(!gseen[id]){ _cmGridShapes[id].rect.setMap(null); _cmGridShapes[id].lbl.setMap(null); delete _cmGridShapes[id]; } });
      // Freehand drawings
      var dseen={};
      ((_cmState&&_cmState.drawings)||[]).forEach(function(d){
        dseen[d.id]=1;
        if(!_cmDrawObjs[d.id]){
          var pl=new G.Polyline({ map:_cmMap, path:d.points, strokeColor:'#f472b6', strokeWeight:4, strokeOpacity:0.95 });
          pl.addListener('click', function(){ if(_cmDrawMode==='erase') _cmEraseDrawing(d.id); });
          _cmDrawObjs[d.id]=pl;
        }
      });
      Object.keys(_cmDrawObjs).forEach(function(id){ if(!dseen[id]){ _cmDrawObjs[id].setMap(null); delete _cmDrawObjs[id]; } });
    }
    // Manual sectors (command)
    var sseen={};
    ((_cmState&&_cmState.sectors)||[]).forEach(function(s){ sseen[s.id]=1; var mk=_cmSectorMarkers[s.id]; if(!mk){ mk=new G.Marker({ map:_cmMap, icon:_transIcon() }); _cmSectorMarkers[s.id]=mk; } mk.setPosition({lat:s.lat,lng:s.lng}); mk.setLabel({ text:'⬡ '+s.label, color:'#a78bfa', fontWeight:'800', fontSize:'13px' }); });
    Object.keys(_cmSectorMarkers).forEach(function(id){ if(!sseen[id]){ _cmSectorMarkers[id].setMap(null); delete _cmSectorMarkers[id]; } });
    // Lead auto-logs new calls
    if(myUnit()===cmLeadUnit()){
      (STATE.calls||[]).forEach(function(c){
        if((c.status==='open'||c.status==='active')&&!_cmLoggedCalls[c.id]&&(c.createdAt||0)>=((_cmState&&_cmState.startedAt)||0)){
          _cmLoggedCalls[c.id]=1; var tl=cleanLabel?cleanLabel(CALL_TYPE_LABELS[c.type]||c.type||''):(c.type||'');
          _cmAddLog('🔴 Call '+(c.callNum?('#'+c.callNum+' '):'')+tl+' — '+(c.town||'')+(c.caller?(' · '+c.caller):'')+(c.phone?(' · ☎ '+c.phone):''),'call');
        }
      });
    }
    _cmBuildSidebar();
  }

  // ── Sidebar ────────────────────────────────────────────────────────────────
  function _cmBuildSidebar(){
    var sb=document.getElementById('cmSidebar'); if(!sb) return;
    var mem=cmMembers(), onCall=0,idle=0,stale=0;
    mem.forEach(function(mm){ var col=_cmMemberColor(U(mm.unit),_cmLocs[U(mm.unit)]); if(col==='#22c55e')onCall++; else if(col==='#eab308')idle++; else if(col==='#9ca3af')stale++; });
    var hc=document.getElementById('cmHeadcount'); if(hc) hc.textContent=mem.length+' members · '+onCall+' on call · '+idle+' idle';
    var missing=cmIsMissing();
    sb.innerHTML=''
      +'<div style="padding:12px;display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid rgba(255,255,255,.08);">'
        +'<button onclick="cmAddMembers()" style="flex:1 1 calc(50% - 6px);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#1e3a5f;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">＋ Members</button>'
        +((missing&&(cmAmAdmin()||myUnit()===cmLeadUnit()))?'<button onclick="cmManageViewers()" style="flex:1 1 calc(50% - 6px);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#0e7490;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">👁 Watchers</button>':'')
        +(missing?'<button onclick="cmToggleDraw()" id="cmDrawBtn" style="flex:1 1 calc(50% - 6px);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">✏️ Draw</button>':'')
        +(missing?'<button onclick="cmToggleErase()" id="cmEraseBtn" style="flex:1 1 calc(50% - 6px);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#4b5563;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">🧹 Erase</button>':'')
        +'<button onclick="cmBroadcast()" style="flex:1 1 calc(50% - 6px);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#065f46;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">📣 Broadcast</button>'
        +'<button onclick="cmAddNote()" id="cmNoteBtn" style="flex:1 1 calc(50% - 6px);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#374151;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;position:relative;">✎ Note/Log</button>'
        +'<button onclick="cmChatMenu()" id="cmChatBtn" style="flex:1 1 calc(50% - 6px);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:#1d4ed8;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;position:relative;">💬 Chat</button>'
      +'</div>'
      +'<div style="flex:1;overflow-y:auto;">'
        +'<div style="padding:10px 12px 4px;font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;">Roster ('+mem.length+')</div>'
        +'<div>'+mem.map(function(mm){ var u=U(mm.unit); var col=_cmMemberColor(u,_cmLocs[u]); var lbl=col==='#22c55e'?'on call':col==='#eab308'?'idle':col==='#9ca3af'?'no signal':'lead';
            return '<div onclick="cmFocusMember(\''+u+'\')" style="display:flex;align-items:center;gap:9px;padding:8px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);"><span style="width:9px;height:9px;border-radius:50%;background:'+col+';flex-shrink:0;"></span><span style="font-weight:800;color:'+col+';">BC-'+u+'</span><span style="color:#94a3b8;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">'+escapeHTML(mm.name||'')+'</span><span style="color:#64748b;font-size:11px;flex-shrink:0;">'+lbl+'</span></div>';
          }).join('')||'<div style="padding:12px;color:#64748b;font-size:12px;">No members yet — tap ＋ Members.</div>'+'</div>'
        +'<div style="padding:12px 12px 4px;font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;">Incident Log</div>'
        +'<div id="cmLogList"></div>'
      +'</div>';
    _cmRenderLog();
  }
  function _cmRenderLog(){ var el=document.getElementById('cmLogList'); if(!el) return; el.innerHTML=(_cmLog||[]).map(function(e){ var t=new Date(e.at||0).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); return '<div style="padding:6px 12px;font-size:12px;color:#cbd5e1;border-bottom:1px solid rgba(255,255,255,.04);"><span style="color:#64748b;">'+t+'</span> · '+_cmBoldCalls(escapeHTML(e.text||''))+'</div>'; }).join('')||'<div style="padding:8px 12px;color:#64748b;font-size:12px;">No events yet.</div>'; }

  function cmFocusMember(u){ var loc=_cmLocs[u]; if(loc&&_cmMap&&_cmMap._isGoogle){ _cmMap.panTo({lat:loc.lat,lng:loc.lng}); _cmMap.setZoom(16); } _cmMemberPopup(u); }
  function _cmMemberPopup(u){
    var mm=cmMembers().find(function(x){ return U(x.unit)===u; }); var loc=_cmLocs[u];
    var m=(STATE.members||[]).find(function(x){ return U(x.unit||x.id)===u; }); var phone=m&&m.phone?m.phone:'';
    var status=u===cmLeadUnit()?'Command Lead':(!loc||(Date.now()-(loc.at||0))>CM_STALE_MS?'No recent signal':(_cmUnitOnCall(u)?'On an active call':'Idle / available'));
    var when=loc&&loc.at?new Date(loc.at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'—';
    // Calls this member is currently on (kick-off targets)
    var onCalls=(STATE.calls||[]).filter(function(c){ return (c.status==='open'||c.status==='active')&&(c.responders||[]).some(function(r){ return U(r.unit)===u; }); });
    // Open/active calls the member is NOT on yet (assign targets)
    var openCalls=(STATE.calls||[]).filter(function(c){ return (c.status==='open'||c.status==='active')&&!(c.responders||[]).some(function(r){ return U(r.unit)===u; }); }).sort(function(a,b){ return (b.priority==='urgent'?1:0)-(a.priority==='urgent'?1:0); });
    function _clbl(c){ var tl=cleanLabel?cleanLabel(CALL_TYPE_LABELS[c.type]||c.type||''):(c.type||''); var st=String(c.address||'').replace(/\s*—?\s*📍.*$/,'').split(',')[0].trim(); return '#'+(c.callNum||'')+' '+tl+(st?(' · '+st):''); }
    var onHtml=onCalls.map(function(c){ return '<div style="display:flex;align-items:center;gap:8px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:9px;padding:8px 10px;margin-bottom:6px;"><span style="flex:1;min-width:0;font-size:12px;font-weight:700;color:#166534;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+escapeHTML(_clbl(c))+'</span><button onclick="cmRemoveResp(\''+c.id+'\',\''+u+'\')" style="flex-shrink:0;background:#fee2e2;color:#b91c1c;border:none;border-radius:7px;padding:7px 11px;font-size:12px;font-weight:800;cursor:pointer;">Remove</button></div>'; }).join('');
    var assignHtml=openCalls.slice(0,8).map(function(c){ var urg=c.priority==='urgent'; return '<div style="display:flex;align-items:center;gap:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:8px 10px;margin-bottom:6px;"><span style="flex:1;min-width:0;font-size:12px;font-weight:700;color:'+(urg?'#b91c1c':'#334155')+';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+(urg?'🔴 ':'')+escapeHTML(_clbl(c))+'</span><button onclick="cmAssignUnitToCall(\''+c.id+'\',\''+u+'\')" style="flex-shrink:0;background:#e0e7ff;color:#3730a3;border:none;border-radius:7px;padding:7px 11px;font-size:12px;font-weight:800;cursor:pointer;">Assign</button></div>'; }).join('');
    _cmSheet('BC-'+u+(mm&&mm.name?' · '+escapeHTML(mm.name):''),
      '<div style="font-size:13px;color:#374151;margin-bottom:4px;">'+status+'</div><div style="font-size:12px;color:#6b7280;margin-bottom:14px;">Last update: '+when+'</div>'
      +(phone?'<div style="display:flex;gap:8px;margin-bottom:16px;"><a href="tel:'+phone+'" style="flex:1;text-align:center;background:#065f46;color:#fff;text-decoration:none;border-radius:10px;padding:12px;font-weight:800;">📞 Call</a><a href="sms:'+phone+'" style="flex:1;text-align:center;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:10px;padding:12px;font-weight:800;">💬 Text</a></div>':'<div style="color:#9ca3af;font-size:12px;margin-bottom:16px;">No phone on file</div>')
      +(onHtml?'<div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">On call — tap to remove</div>'+onHtml:'')
      +'<div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin:12px 0 6px;">Assign to call</div>'
      +(assignHtml||'<div style="color:#9ca3af;font-size:12px;">No open calls to assign.</div>'));
  }
  function _cmCallPopup(id){
    var c=(STATE.calls||[]).find(function(x){ return x.id===id; }); if(!c) return;
    _cmSelCall=id; _cmRenderCallRows();
    var ll=_cmCallLatLng(c); if(ll&&_cmMap&&_cmMap._isGoogle){ _cmMap.panTo(ll); if(_cmMap.getZoom()<14) _cmMap.setZoom(15); }
    var tl=cleanLabel?cleanLabel(CALL_TYPE_LABELS[c.type]||c.type||''):(c.type||'');
    var urgent=c.priority==='urgent';
    var t=c.createdAt?new Date(c.createdAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'—';
    var durMin=c.createdAt?Math.round((Date.now()-c.createdAt)/60000):0;
    var loc=((cardTown?cardTown(c):(c.town||''))||'')+(c.address?(' · '+String(c.address).replace(/\s*—?\s*📍.*$/,'')):'');
    var nearest=_cmNearestIdle(id);
    function chip(label,v,color){ return '<div style="background:#f8fafc;border-radius:9px;padding:7px 9px;"><div style="font-size:9.5px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.03em;">'+label+'</div><div style="font-size:13px;font-weight:700;color:'+(color||'#111827')+';margin-top:2px;">'+v+'</div></div>'; }
    var body='<div style="max-height:64vh;overflow-y:auto;-webkit-overflow-scrolling:touch;">';
    body+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:12px;">'
      +chip('Status',(c.status==='active'?'Active':'Open'),c.status==='active'?'#16a34a':'#d97706')
      +chip('Priority',urgent?'URGENT':'Normal',urgent?'#dc2626':'#111827')
      +chip('Dispatched',t)
      +chip('Elapsed',durMin+' min')
      +chip('Dispatcher',c.createdBy?('BC-'+U(c.createdBy)):'—')
      +chip('Responding',((c.responders||[]).length)+' units')
    +'</div>';
    body+='<div style="font-size:12px;color:#374151;margin-bottom:12px;"><b>📍 </b>'+escapeHTML(loc||'No location')+'</div>';
    if(c.phone) body+='<a href="tel:'+c.phone+'" style="display:flex;align-items:center;gap:8px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:9px;padding:10px 12px;margin-bottom:12px;text-decoration:none;"><span style="font-size:16px;">📞</span><div style="min-width:0;"><div style="font-size:10px;font-weight:800;color:#059669;text-transform:uppercase;letter-spacing:.04em;">Caller</div><div style="font-size:14px;font-weight:800;color:#065f46;">'+escapeHTML((c.callerName?c.callerName+' · ':'')+c.phone)+'</div></div></a>';
    if(c.notes) body+='<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:9px;padding:9px 11px;font-size:12.5px;color:#78350f;margin-bottom:12px;">📝 '+escapeHTML(c.notes)+'</div>';
    var resp=(c.responders||[]);
    body+='<div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Responding members ('+resp.length+')</div>';
    body+= resp.length? resp.map(function(r){
      var u=U(r.unit); var when=(r.approvedAt||r.time)?new Date(r.approvedAt||r.time).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'';
      var badge=r.status==='pending'?'<span style="font-size:9px;font-weight:800;background:#fef3c7;color:#92400e;border-radius:5px;padding:2px 5px;">PENDING</span>':'<span style="font-size:9px;font-weight:800;background:#dcfce7;color:#166534;border-radius:5px;padding:2px 5px;">ON CALL</span>';
      var l2=_cmLocs[u]; var live=l2&&(Date.now()-(l2.at||0))<CM_STALE_MS;
      var mrec=(STATE.members||[]).find(function(x){ return U(x.unit||x.id)===u; }); var ph=(mrec&&mrec.phone)?mrec.phone:(r.phone||'');
      return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f1f5f9;">'
        +'<span title="'+(live?'GPS live':'no signal')+'" style="width:8px;height:8px;border-radius:50%;background:'+(live?'#22c55e':'#cbd5e1')+';flex-shrink:0;"></span>'
        +'<span onclick="cmCallResp(\''+u+'\')" style="font-weight:800;color:#1a3a5c;font-size:13px;'+(ph?'cursor:pointer;text-decoration:underline;text-decoration-color:#cbd5e1;text-underline-offset:2px;':'')+'">BC-'+u+'</span>'
        +'<span onclick="cmCallResp(\''+u+'\')" style="color:#64748b;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;'+(ph?'cursor:pointer;':'')+'">'+escapeHTML(r.name||'')+'</span>'
        +badge+(r.eta?'<span style="font-size:11px;color:#64748b;">'+r.eta+'m</span>':'')+(when?'<span style="font-size:11px;color:#94a3b8;">'+when+'</span>':'')
        +(ph?'<a href="tel:'+ph+'" onclick="event.stopPropagation()" title="Call BC-'+u+'" style="flex-shrink:0;text-decoration:none;font-size:15px;padding:0 2px;">📞</a>':'')
        +'<button onclick="cmRemoveResp(\''+id+'\',\''+u+'\')" title="Take off call" style="flex-shrink:0;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:6px;width:24px;height:24px;font-size:13px;font-weight:800;cursor:pointer;line-height:1;">✕</button>'
      +'</div>';
    }).join(''):'<div style="color:#9ca3af;font-size:12px;padding:4px 0 8px;">No responders yet.</div>';
    var pend=(c.pendingResponders||[]);
    if(pend.length){
      body+='<div style="font-size:11px;font-weight:800;color:#b45309;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 6px;">⏳ Pending approval ('+pend.length+')</div>';
      body+=pend.map(function(r){ var u=U(r.unit); return '<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:9px;padding:8px 10px;margin-bottom:6px;">'
        +'<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;"><span style="font-weight:800;color:#92400e;font-size:13px;">BC-'+u+'</span><span style="color:#78350f;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">'+escapeHTML(r.name||'')+'</span>'+(r.eta?'<span style="font-size:11px;color:#92400e;">ETA '+r.eta+'m</span>':'')+'</div>'
        +'<div style="display:flex;gap:6px;"><button onclick="cmApproveResp(\''+c.id+'\',\''+u+'\')" style="flex:1;background:#16a34a;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:800;cursor:pointer;">✓ Approve</button><button onclick="cmRejectResp(\''+c.id+'\',\''+u+'\')" style="flex:1;background:#dc2626;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:800;cursor:pointer;">✕ Reject</button></div>'
      +'</div>'; }).join('');
    }
    var lg=(STATE.callLog||[]).filter(function(e){ return e.callId===c.id; }).slice(-12);
    body+='<div style="font-size:11px;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin:14px 0 6px;">Timeline</div>';
    body+= lg.length? lg.map(function(e){ var tt=new Date(e.ts||0).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); return '<div style="font-size:12px;color:#334155;padding:4px 0;border-bottom:1px solid #f5f5f5;"><span style="color:#94a3b8;">'+tt+'</span> · '+escapeHTML(_cmLogLabel(e))+'</div>'; }).join(''):'<div style="color:#9ca3af;font-size:12px;">No timeline events recorded.</div>';
    body+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;">';
    if(nearest) body+='<button onclick="cmAssignNearest(\''+id+'\')" style="grid-column:1/-1;background:#b45309;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:800;font-size:13px;cursor:pointer;">⚡ Assign nearest idle → BC-'+nearest.unit+' ('+nearest.miles.toFixed(1)+' mi)</button>';
    body+='<button onclick="cmAssignMember(\''+id+'\')" style="background:#1e3a5f;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:800;font-size:13px;cursor:pointer;">👥 Assign member</button>';
    body+='<button onclick="cmEscalate(\''+id+'\')" style="background:'+(urgent?'#475569':'#dc2626')+';color:#fff;border:none;border-radius:10px;padding:12px;font-weight:800;font-size:13px;cursor:pointer;">'+(urgent?'▽ De-escalate':'▲ Escalate')+'</button>';
    body+='<button onclick="cmClearCall(\''+id+'\')" style="background:#7c3aed;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:800;font-size:13px;cursor:pointer;">✓ Clear call</button>';
    body+='<button onclick="cmCancelCallCmd(\''+id+'\')" style="background:#334155;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:800;font-size:13px;cursor:pointer;">✕ Cancel</button>';
    body+='</div></div>';
    _cmSheet('🔴 Call #'+(c.callNum||'—')+' · '+tl, body);
  }
  function _cmSheet(title,bodyHtml){
    var old=document.getElementById('cmSheet'); if(old) old.remove();
    var ov=document.createElement('div'); ov.id='cmSheet'; ov.style.cssText='position:fixed;inset:0;z-index:10060;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;';
    ov.onclick=function(e){ if(e.target===ov) ov.remove(); };
    ov.innerHTML='<div style="background:#fff;border-radius:18px 18px 0 0;max-width:440px;width:100%;padding:18px 18px calc(18px + env(safe-area-inset-bottom));"><div style="font-size:16px;font-weight:800;color:#111827;margin-bottom:10px;">'+title+'</div>'+bodyHtml+'<button onclick="document.getElementById(\'cmSheet\').remove()" style="width:100%;margin-top:12px;background:transparent;border:none;color:#6b7280;font-size:14px;font-weight:700;padding:8px;cursor:pointer;">Close</button></div>';
    document.body.appendChild(ov);
  }
  function _miles(a,b){ var R=3959,dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180,la=a.lat*Math.PI/180,lb=b.lat*Math.PI/180; var h=Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(la)*Math.cos(lb)*Math.sin(dLng/2)*Math.sin(dLng/2); return R*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)); }
  function _cmNearestIdle(callId){
    var c=(STATE.calls||[]).find(function(x){ return x.id===callId; }); if(!c) return null;
    var ll=_cmCallLatLng(c); if(!ll) return null; var best=null;
    cmMembers().forEach(function(mm){ var u=U(mm.unit); var loc=_cmLocs[u]; if(!loc||(Date.now()-(loc.at||0))>CM_STALE_MS) return; if(u===cmLeadUnit()) return; if(_cmUnitOnCall(u)) return; var mi=_miles(ll,{lat:loc.lat,lng:loc.lng}); if(!best||mi<best.miles) best={unit:u,miles:mi}; });
    return best;
  }
  function cmAssignNearest(callId){
    var n=_cmNearestIdle(callId); if(!n){ showToast('No idle unit to assign'); return; }
    var c=(STATE.calls||[]).find(function(x){ return x.id===callId; }); if(!c) return;
    var m=(STATE.members||[]).find(function(x){ return U(x.unit||x.id)===n.unit; });
    c.responders=c.responders||[]; if(c.responders.some(function(r){ return U(r.unit)===n.unit; })){ showToast('BC-'+n.unit+' already on this call'); var sh=document.getElementById('cmSheet'); if(sh) sh.remove(); return; }
    c.responders.push({ unit:n.unit, name:m?((m.firstName||m.name||'')+' '+(m.lastName||'')).trim():'', time:Date.now(), status:'approved', approvedBy:myUnit(), approvedAt:Date.now(), viaCommand:true });
    if(c.status!=='done'&&c.status!=='cancelled') c.status='active';   // flip to active like the normal assign flow
    try{ db().collection('calls').doc(String(c.id)).update({ responders:c.responders, status:c.status }); }catch(e){}
    try{ if(typeof save==='function') save(); if(typeof renderCalls==='function') renderCalls(); if(typeof renderHome==='function') renderHome(); }catch(e){}
    try{ if(!cmIsMissing()){ _cmBuildStats(); _cmRenderCallRows(); } }catch(e){}
    // Direct heads-up to the assigned unit + the standard "Assigned to Call" broadcast everyone sees
    try{ sendPush({ target:'unit', unit:n.unit, title:'🎖️ Command assignment', body:'Assigned to Call '+(c.callNum?('#'+c.callNum):'')+' — '+(c.town||''), url:'/cobc-dispatch/?page=dispatch', urgent:'true' }); }catch(e){}
    try{ sendPush({ target:'all', title:'Assigned to Call', body:'#'+(c.callNum||'')+' · BC-'+n.unit+' is responding — '+(c.town||''), url:'/cobc-dispatch/?page=dispatch', callId:c.id }); }catch(e){}
    _cmAddLog('➡️ BC-'+n.unit+' assigned to call '+(c.callNum?('#'+c.callNum):'')+' ('+n.miles.toFixed(1)+' mi)','assign');
    showToast('Assigned BC-'+n.unit); var s=document.getElementById('cmSheet'); if(s) s.remove();
  }
  // Assign a SPECIFIC unit to a call (from the member map popup)
  function cmAssignUnitToCall(callId,unit){
    unit=U(unit);
    var c=(STATE.calls||[]).find(function(x){ return x.id===callId; }); if(!c) return;
    var m=(STATE.members||[]).find(function(x){ return U(x.unit||x.id)===unit; });
    c.responders=c.responders||[];
    if(c.responders.some(function(r){ return U(r.unit)===unit; })){ showToast('BC-'+unit+' already on this call'); return; }
    c.responders.push({ unit:unit, name:m?((m.firstName||m.name||'')+' '+(m.lastName||'')).trim():'', time:Date.now(), status:'approved', approvedBy:myUnit(), approvedAt:Date.now(), viaCommand:true });
    if(c.status!=='done'&&c.status!=='cancelled') c.status='active';
    try{ db().collection('calls').doc(String(c.id)).update({ responders:c.responders, status:c.status }); }catch(e){}
    try{ if(typeof save==='function') save(); if(typeof renderCalls==='function') renderCalls(); if(typeof renderHome==='function') renderHome(); }catch(e){}
    try{ if(!cmIsMissing()){ _cmBuildStats(); _cmRenderCallRows(); } }catch(e){}
    try{ sendPush({ target:'unit', unit:unit, title:'🎖️ Command assignment', body:'Assigned to Call '+(c.callNum?('#'+c.callNum):'')+' — '+(c.town||''), url:'/cobc-dispatch/?page=dispatch', urgent:'true' }); }catch(e){}
    try{ sendPush({ target:'all', title:'Assigned to Call', body:'#'+(c.callNum||'')+' · BC-'+unit+' is responding — '+(c.town||''), url:'/cobc-dispatch/?page=dispatch', callId:c.id }); }catch(e){}
    _cmAddLog('➡️ BC-'+unit+' assigned to call '+(c.callNum?('#'+c.callNum):'')+' by BC-'+myUnit(),'assign');
    showToast('Assigned BC-'+unit); setTimeout(function(){ _cmMemberPopup(unit); },300);
  }
  // Assign / approve / reject — reuse the app's REAL dispatcher flows so every change
  // shows on the normal Open Calls cards for all members (push + WA fire from there).
  function _cmRaise(id){ var m=document.getElementById(id); if(m){ m.style.zIndex='9800'; } return m; }
  function cmNewCall(){ _cmRaise('newCallModal'); try{ if(typeof showModal==='function') showModal('newCallModal'); else { var m=document.getElementById('newCallModal'); if(m) m.classList.remove('hidden'); } }catch(e){ showToast('New call unavailable'); } }
  function cmAssignMember(callId){ var s=document.getElementById('cmSheet'); if(s) s.remove(); _cmRaise('radioModal'); try{ if(typeof openRadioModal==='function'){ openRadioModal(callId); } else { showToast('Assign unavailable'); } }catch(e){ showToast('Assign unavailable'); } }
  function cmApproveResp(callId,unit){ try{ if(typeof approveResponder==='function') approveResponder(callId,U(unit)); }catch(e){} _cmAddLog('✔️ Approved BC-'+U(unit)+' on call by BC-'+myUnit(),'assign'); setTimeout(function(){ _cmRenderCallRows(); if(document.getElementById('cmSheet')) _cmCallPopup(callId); },350); }
  function cmRejectResp(callId,unit){ try{ if(typeof rejectResponder==='function') rejectResponder(callId,U(unit)); }catch(e){} _cmAddLog('✖️ Rejected BC-'+U(unit)+' on call by BC-'+myUnit(),'assign'); setTimeout(function(){ _cmRenderCallRows(); if(document.getElementById('cmSheet')) _cmCallPopup(callId); },350); }

  // ── Add members mid-op (click-to-toggle, robust) ────────────────────────────
  function cmAddMembers(){
    _cmPick={};
    var have={}; cmMembers().forEach(function(m){ have[U(m.unit)]=1; });
    var members=(STATE.members||[]).filter(function(m){ return !have[U(m.unit||m.id)]; }).sort(function(a,b){ return (parseInt(U(a.unit||a.id))||0)-(parseInt(U(b.unit||b.id))||0); });
    var body='<input id="cmAddSearch" placeholder="Filter…" oninput="cmFilterAdd(this.value)" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:10px;box-sizing:border-box;"/>'
      +'<div id="cmAddPick" style="max-height:38vh;overflow-y:auto;-webkit-overflow-scrolling:touch;">'+(members.map(function(m){ var u=U(m.unit||m.id); var nm=((m.firstName||m.name||'')+' '+(m.lastName||'')).trim();
        return '<div class="cmAddRow" data-u="'+u+'" data-n="'+escapeHTML(nm.toLowerCase())+'" onclick="cmTogglePick(\''+u+'\',this)" style="display:flex;align-items:center;gap:10px;padding:10px 8px;border-bottom:1px solid #f2f2f2;cursor:pointer;border-radius:8px;"><span class="cmChk" style="width:20px;height:20px;border-radius:6px;border:2px solid #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;flex-shrink:0;"></span><span style="font-weight:700;color:#1a3a5c;">BC-'+u+'</span><span style="color:#666;font-size:13px;">'+escapeHTML(nm)+'</span></div>';
      }).join('')||'<div style="color:#9ca3af;padding:8px;">Everyone is already added.</div>')+'</div>'
      +'<button onclick="cmConfirmAdd()" style="width:100%;margin-top:12px;background:#1e3a5f;color:#fff;border:none;border-radius:10px;padding:15px;font-weight:800;font-size:15px;cursor:pointer;">＋ Add to roster <span id="cmPickCount"></span></button>';
    _cmSheet('Add members', body);
  }
  function cmFilterAdd(q){ q=(q||'').toLowerCase().trim(); document.querySelectorAll('#cmAddPick .cmAddRow').forEach(function(el){ var hit=!q||el.dataset.u.indexOf(q)>=0||(el.dataset.n||'').indexOf(q)>=0; el.style.display=hit?'flex':'none'; }); }
  function cmConfirmAdd(){
    var picked=Object.keys(_cmPick); if(!picked.length){ showToast('Tap members to select'); return; }
    var mem=(STATE.members||[]); var add=picked.map(function(u){ var m=mem.find(function(x){ return U(x.unit||x.id)===u; }); return { unit:u, name:m?((m.firstName||m.name||'')+' '+(m.lastName||'')).trim():'' }; });
    var next=cmMembers().concat(add);
    db().collection('config').doc('commandMode').set({ members:next }, {merge:true}).then(function(){
      if(_cmState) _cmState.members=next;   // optimistic — the snapshot reconciles
      _cmAddLog('➕ Added '+add.map(function(a){ return 'BC-'+a.unit; }).join(', '),'roster');
      add.forEach(function(a){ try{ sendPush({ target:'unit', unit:a.unit, title:(cmIsMissing()?'🔍 Search':'🎖️ Command'), body:'You\'ve been added — location sharing is on. Open the app.', url:'/cobc-dispatch/?page=dispatch', urgent:'true' }); }catch(e){} });
      var s=document.getElementById('cmSheet'); if(s) s.remove(); _cmPick={}; _cmBuildSidebar(); showToast('Added '+add.length);
    }).catch(function(e){ console.warn('[command] add members failed',e); showToast('Could not add — '+((e&&e.code)||'error')); });
  }

  // ── Watchers: extra view-only access beyond admins + on-duty dispatchers ──────────────
  // Admins & on-duty dispatchers can ALWAYS watch. Here the admin/lead grants extra
  // people view access to the live op. Watchers see the map & calls but do NOT share GPS.
  function cmManageViewers(){
    if(!(cmAmAdmin()||myUnit()===cmLeadUnit())){ showToast('Admins or lead only'); return; }
    _cmPick={};
    var have={}; cmViewers().forEach(function(v){ have[U(v.unit)]=1; });
    var onduty=[]; try{ onduty=(_onDutyDispatchUnits()||[]).map(U); }catch(e){}
    var pickable=(STATE.members||[]).filter(function(m){ return !have[U(m.unit||m.id)]; }).sort(function(a,b){ return (parseInt(U(a.unit||a.id))||0)-(parseInt(U(b.unit||b.id))||0); });
    var curHtml=cmViewers().length? cmViewers().map(function(v){ var u=U(v.unit); return '<div style="display:flex;align-items:center;gap:9px;padding:8px 10px;border-bottom:1px solid #f2f2f2;"><span style="width:9px;height:9px;border-radius:50%;background:#0e7490;flex-shrink:0;"></span><span style="font-weight:800;color:#1a3a5c;">BC-'+u+'</span><span style="color:#666;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">'+escapeHTML(v.name||'')+'</span><button onclick="cmRemoveViewer(\''+u+'\')" style="background:#fee2e2;color:#b91c1c;border:none;border-radius:7px;padding:5px 10px;font-size:12px;font-weight:800;cursor:pointer;flex-shrink:0;">Remove</button></div>'; }).join('') : '<div style="color:#9ca3af;font-size:12px;padding:10px;">No extra watchers added yet.</div>';
    var ondutyChips=onduty.length? onduty.map(function(u){ return '<span style="display:inline-block;background:#eef2ff;color:#3730a3;border-radius:20px;padding:3px 10px;font-size:12px;font-weight:700;margin:0 4px 4px 0;">BC-'+u+'</span>'; }).join('') : '<span style="color:#9ca3af;font-size:12px;">none on duty right now</span>';
    var body=''
      +'<div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:10px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:#0f766e;line-height:1.5;">Admins and on-duty dispatchers can always watch. Add anyone else below — watchers see the live map &amp; calls but don\'t share their location.</div>'
      +'<div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Always watching</div>'
      +'<div style="margin-bottom:16px;">'+ondutyChips+'</div>'
      +'<div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Added watchers</div>'
      +'<div style="margin-bottom:16px;border:1px solid #eef2f7;border-radius:10px;overflow:hidden;">'+curHtml+'</div>'
      +'<div style="font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">Add watchers</div>'
      +'<input placeholder="Filter…" oninput="cmFilterViewers(this.value)" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:8px;box-sizing:border-box;"/>'
      +'<div id="cmVwPick" style="max-height:32vh;overflow-y:auto;-webkit-overflow-scrolling:touch;">'+(pickable.map(function(m){ var u=U(m.unit||m.id); var nm=((m.firstName||m.name||'')+' '+(m.lastName||'')).trim(); return '<div class="cmVwRow" data-u="'+u+'" data-n="'+escapeHTML(nm.toLowerCase())+'" onclick="cmTogglePick(\''+u+'\',this)" style="display:flex;align-items:center;gap:10px;padding:10px 8px;border-bottom:1px solid #f2f2f2;cursor:pointer;border-radius:8px;"><span class="cmChk" style="width:20px;height:20px;border-radius:6px;border:2px solid #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;flex-shrink:0;"></span><span style="font-weight:700;color:#1a3a5c;">BC-'+u+'</span><span style="color:#666;font-size:13px;">'+escapeHTML(nm)+'</span></div>'; }).join('')||'<div style="color:#9ca3af;padding:8px;">No members to add.</div>')+'</div>'
      +'<button onclick="cmConfirmViewers()" style="position:sticky;bottom:0;width:100%;margin-top:12px;background:#0e7490;color:#fff;border:none;border-radius:10px;padding:15px;font-weight:800;font-size:15px;cursor:pointer;box-shadow:0 -6px 12px rgba(255,255,255,.9);">＋ Add as watchers <span id="cmPickCount"></span></button>';
    _cmSheet('👁 Watchers', body);
  }
  function cmFilterViewers(q){ q=(q||'').toLowerCase().trim(); document.querySelectorAll('#cmVwPick .cmVwRow').forEach(function(el){ var hit=!q||el.dataset.u.indexOf(q)>=0||(el.dataset.n||'').indexOf(q)>=0; el.style.display=hit?'flex':'none'; }); }
  function cmConfirmViewers(){
    var picked=Object.keys(_cmPick); if(!picked.length){ showToast('Tap members to select'); return; }
    var mem=(STATE.members||[]); var add=picked.map(function(u){ var m=mem.find(function(x){ return U(x.unit||x.id)===u; }); return { unit:u, name:m?((m.firstName||m.name||'')+' '+(m.lastName||'')).trim():'', addedBy:myUnit(), at:Date.now() }; });
    db().collection('config').doc('commandMode').update({ viewers:cmViewers().concat(add) }).then(function(){
      _cmAddLog('👁 Added watcher'+(add.length>1?'s':'')+' '+add.map(function(a){ return 'BC-'+a.unit; }).join(', '),'roster');
      add.forEach(function(a){ try{ sendPush({ target:'unit', unit:a.unit, title:(cmIsMissing()?'🔍 Search':'🎖️ Command')+' — watch access', body:'You can now watch the live '+(cmIsMissing()?'search':'command center')+'. Open the app → Settings.', url:'/cobc-dispatch/?page=more', urgent:'false' }); }catch(e){} });
      _cmPick={}; showToast('Added '+add.length+' watcher'+(add.length>1?'s':'')); cmManageViewers();
    }).catch(function(){ showToast('Could not add'); });
  }
  function cmRemoveViewer(u){
    db().collection('config').doc('commandMode').update({ viewers:cmViewers().filter(function(v){ return U(v.unit)!==U(u); }) }).then(function(){ _cmAddLog('👁 Removed watcher BC-'+U(u),'roster'); showToast('Removed'); cmManageViewers(); }).catch(function(){ showToast('Could not remove'); });
  }

  // ── Broadcast ───────────────────────────────────────────────────────────────
  function cmBroadcast(){ var msg=prompt('Broadcast to all members:'); if(!msg||!msg.trim()) return; cmMembers().forEach(function(mm){ try{ sendPush({ target:'unit', unit:U(mm.unit), title:(cmIsMissing()?'🔍 Search':'🎖️ Command'), body:msg.trim(), url:'/cobc-dispatch/?page=dispatch', urgent:'true' }); }catch(e){} }); try{ sendWA({ target:'all', message:(cmIsMissing()?'🔍 SEARCH: ':'🎖️ COMMAND: ')+msg.trim() }); }catch(e){} _cmAddLog('📣 Broadcast: '+msg.trim(),'broadcast'); showToast('📣 Sent'); }

  // ── End + incident report + Command Center Logs ─────────────────────────────
  function _cmOpCalls(start){ var s=start||0; return (STATE.calls||[]).filter(function(c){ if(!c) return false; return (c.createdAt&&c.createdAt>=s)||(c.completedAt&&c.completedAt>=s)||(c.status==='active'||c.status==='open'); }).sort(function(a,b){ return (a.createdAt||0)-(b.createdAt||0); }); }
  function cmLogExternal(text,channel){ try{ if(cmIsActive()) _cmAddLog(String(text||''),'status',channel||'note'); }catch(e){} }
  // Called from the normal Dispatch tab when a call is completed while a command op
  // is running: log it to the command Notes, then prompt dispatch for a closing note.
  function cmExternalComplete(callId){
    if(!cmIsActive()) return;
    var c=(STATE.calls||[]).find(function(x){ return x.id===callId; }); if(!c) return;
    if(_cmClosedHandled[callId]) return; _cmClosedHandled[callId]=1;
    var verb=(c.status==='cancelled')?'cancelled':'completed';
    try{ _cmAddLog('✅ Call #'+(c.callNum||'')+' '+verb+' in Dispatch — by BC-'+myUnit(),'status','note'); }catch(e){}
    try{ _cmCloseNotePrompt(callId); }catch(e){}
  }
  function _cmReportText(){
    var t=cmIsMissing()?'Missing Person Search':'Command Operation';
    var start=(_cmState&&_cmState.startedAt)||null, end=Date.now();
    var dur=start?Math.round((end-start)/60000):0;
    var fmt=function(ms){ return ms?new Date(ms).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—'; };
    var lines=[];
    lines.push(t.toUpperCase()+' — INCIDENT REPORT');
    lines.push('Lead: BC-'+cmLeadUnit()+((_cmState&&_cmState.leadName)?(' ('+_cmState.leadName+')'):''));
    lines.push('Start: '+fmt(start));
    lines.push('End:   '+fmt(end)+'  ('+dur+' min)');
    var mem=cmMembers().map(function(m){ return 'BC-'+U(m.unit); }).join(', ');
    lines.push('Members ('+cmMembers().length+'): '+(mem||'none'));
    if(cmIsMissing()&&_cmState&&_cmState.subject){ var s=_cmState.subject; lines.push('Subject: '+(s.name||'Unknown')+(s.age?(', '+s.age):'')); }
    var opCalls=_cmOpCalls(start);
    if(opCalls.length){
      lines.push('');
      lines.push('— CALLS HANDLED ('+opCalls.length+') —');
      opCalls.forEach(function(c){
        var tl=_cmCallTypeLabel(c);
        var loc=cleanLabel((c.town||'')+(c.address?(' '+String(c.address).replace(/\s*—?\s*📍.*$/,'')):''));
        var st=(c.status==='done')?'COMPLETED':(c.status==='cancelled')?'CANCELLED':(c.status||'open').toUpperCase();
        var resp=(c.responders||[]).map(function(r){ return 'BC-'+U(r.unit); }).join(', ')||'none';
        var dur=(c.completedAt&&c.createdAt)?('  ('+Math.round((c.completedAt-c.createdAt)/60000)+' min)'):'';
        lines.push('#'+(c.callNum||'—')+'  '+tl+'  ['+st+']'+dur);
        lines.push('   '+(loc||'no location'));
        lines.push('   Responders: '+resp);
        if(c.notes) lines.push('   Notes: '+cleanLabel(c.notes));
      });
    }
    lines.push('');
    lines.push('— LOG —');
    var log=(_cmLog||[]).slice().sort(function(a,b){ return (a.at||0)-(b.at||0); });
    log.forEach(function(e){ var tm=new Date(e.at||0).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); var ch=(e.channel==='dispatch')?'[DISPATCH] ':(e.channel==='members')?'[MEMBERS] ':''; lines.push(tm+'  '+ch+cleanLabel(e.text||'')+(e.by?('  (BC-'+U(e.by)+')'):'')); });
    if(!log.length) lines.push('(no entries)');
    return lines.join('\n');
  }
  function _cmHistText(v){ if(v&&v.reportText) return v.reportText; var lines=[]; (v.log||[]).slice().sort(function(a,b){ return (a.at||0)-(b.at||0); }).forEach(function(e){ var tm=new Date(e.at||0).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); lines.push(tm+'  '+cleanLabel(e.text||'')); }); return lines.join('\n')||'(no log)'; }
  function _cmSaveHistory(cb){
    var start=(_cmState&&_cmState.startedAt)||null;
    var title=(cmIsMissing()?'Missing Person Search':'Command Operation')+' · '+(start?new Date(start).toLocaleDateString('en-US',{month:'short',day:'numeric'}):new Date().toLocaleDateString('en-US',{month:'short',day:'numeric'}));
    var _opCallsSnap=_cmOpCalls(start).map(function(c){ return { callNum:c.callNum||'', type:c.type||'', typeLabel:_cmCallTypeLabel(c), town:c.town||'', address:String(c.address||'').replace(/\s*—?\s*📍.*$/,''), status:c.status||'open', createdAt:c.createdAt||null, completedAt:c.completedAt||null, notes:c.notes||'', responders:(c.responders||[]).map(function(r){ return 'BC-'+U(r.unit); }) }; });
    var summary={ type:cmType(), title:title, startedAt:start, endedAt:Date.now(), leadUnit:cmLeadUnit(), leadName:(_cmState&&_cmState.leadName)||'', members:cmMembers(), calls:_opCallsSnap, subject:(_cmState&&_cmState.subject)||null, sectors:(_cmState&&_cmState.sectors)||[], grid:(_cmState&&_cmState.grid)||[], linkedCallId:(_cmState&&_cmState.linkedCallId)||null, log:(_cmLog||[]).slice(0,500), reportText:_cmReportText(), endedBy:myUnit(), savedAt:Date.now() };
    try{ db().collection('commandHistory').add(summary).then(function(ref){ if(cb) cb(ref); }).catch(function(){ if(cb) cb(null); }); }catch(e){ if(cb) cb(null); }
  }
  // Verify-then-clear: only delete raw commandLog entries AFTER the archive doc is
  // confirmed saved AND read back with a populated log. Zero-loss by construction.
  function _cmVerifyAndClearLog(ref, endedAt){
    if(!ref||!ref.id){ return; }
    try{
      db().collection('commandHistory').doc(ref.id).get().then(function(doc){
        var ok=doc && doc.exists && doc.data() && Array.isArray(doc.data().log) && doc.data().log.length>0;
        if(!ok){ showToast('⚠️ Log kept (archive not confirmed)'); return; }
        // Delete only entries from BEFORE this op ended, in batches — never touch a new op's fresh entries
        db().collection('commandLog').where('at','<',endedAt).get().then(function(snap){
          if(snap.empty) return;
          var docs=snap.docs, n=docs.length, i=0;
          function batchNext(){
            if(i>=n){ showToast('🧹 Archived '+n+' log entries'); return; }
            var b=db().batch(), end=Math.min(i+400,n);
            for(;i<end;i++) b.delete(docs[i].ref);
            b.commit().then(batchNext).catch(function(){});
          }
          batchNext();
        }).catch(function(){});
      }).catch(function(){});
    }catch(e){}
  }
  function cmEndNight(){
    if(!((myUnit()===cmLeadUnit())||cmAmAdmin())){ showToast('Only the lead or an admin can end it'); return; }
    var report=_cmReportText();
    var body=''
      +'<div style="font-size:12px;color:#6b7280;margin-bottom:10px;">Send or save the full incident report — every note and log entry — then end the operation. Ending also saves a copy to Command Logs automatically.</div>'
      +'<pre style="background:#0b1220;color:#cbd5e1;border-radius:10px;padding:12px;font-size:11px;line-height:1.5;white-space:pre-wrap;max-height:30vh;overflow:auto;font-family:\'DM Mono\',monospace;margin-bottom:14px;">'+escapeHTML(report)+'</pre>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">'
        +'<button onclick="cmReportWhatsApp()" style="background:#075e54;color:#fff;border:none;border-radius:10px;padding:13px;font-weight:800;font-size:13px;cursor:pointer;">📱 WhatsApp</button>'
        +'<button onclick="cmReportEmail()" style="background:#1e3a5f;color:#fff;border:none;border-radius:10px;padding:13px;font-weight:800;font-size:13px;cursor:pointer;">✉️ Email</button>'
        +'<button onclick="cmReportSave()" style="grid-column:1/-1;background:#7c3aed;color:#fff;border:none;border-radius:10px;padding:13px;font-weight:800;font-size:13px;cursor:pointer;">💾 Save to Command Logs</button>'
      +'</div>'
      +'<button onclick="cmReportEndConfirm()" style="width:100%;background:#7f1d1d;color:#fff;border:none;border-radius:12px;padding:15px;font-weight:800;font-size:15px;cursor:pointer;margin-top:6px;">🏁 End Operation</button>';
    _cmSheet((cmIsMissing()?'🔍':'🎖️')+' End & Report', body);
  }
  function cmReportWhatsApp(){ var txt=_cmReportText(); try{ sendWA({ target:'all', message:txt }); showToast('📱 Report sent to WhatsApp'); }catch(e){ try{ window.open('https://wa.me/?text='+encodeURIComponent(txt),'_blank'); }catch(_){} } _cmAddLog('📱 Report sent via WhatsApp by BC-'+myUnit(),'end'); }
  function cmReportEmail(){ var txt=_cmReportText(); var subj=(cmIsMissing()?'Missing Person Search':'Command Operation')+' Report — '+new Date().toLocaleDateString(); try{ window.location.href='mailto:?subject='+encodeURIComponent(subj)+'&body='+encodeURIComponent(txt); }catch(e){} _cmAddLog('✉️ Report emailed by BC-'+myUnit(),'end'); }
  function cmReportSave(){ _cmSaveHistory(function(){ alert('✅ Saved.\n\nThis end-of-operation report is stored in Command Operation Logs (Settings → Command Center Logs), where you can reopen, WhatsApp, or email it anytime.'); showToast('💾 Saved to Command Logs'); }); }
  function cmReportEndConfirm(){ if(!confirm('End this operation? Members stop sharing their location.')) return; _cmDoEnd(); }
  function _cmDoEnd(){
    _cmAddLog('🏁 Operation ended by BC-'+myUnit(),'end');
    var _endTs=Date.now();
    // Save the permanent archive, then verify-then-clear the raw commandLog (admin/lead only)
    _cmSaveHistory(function(ref){
      if(ref && (cmAmAdmin()||myUnit()===cmLeadUnit())){ setTimeout(function(){ _cmVerifyAndClearLog(ref,_endTs); },600); }
    });
    db().collection('config').doc('commandMode').set({ active:false, endedAt:_endTs }, {merge:true}).then(function(){ try{ db().collection('commandLocations').get().then(function(s){ s.forEach(function(d){ d.ref.delete().catch(function(){}); }); }); }catch(e){} var sh=document.getElementById('cmSheet'); if(sh) sh.remove(); closeCommandView(); showToast('🏁 Ended — saved to Command Logs'); });
  }

  // Command Center Logs — every past incident's notes + log, re-sendable.
  function openCommandLogs(){
    _cmSheet('📚 Command Center Logs','<div id="cmLogsList" style="max-height:66vh;overflow-y:auto;-webkit-overflow-scrolling:touch;"><div style="padding:16px;color:#9ca3af;font-size:13px;">Loading…</div></div>');
    try{
      db().collection('commandHistory').orderBy('endedAt','desc').limit(100).get().then(function(snap){
        var items=[]; snap.forEach(function(d){ var v=d.data()||{}; v._id=d.id; items.push(v); });
        _cmRenderLogsList(items);
      }).catch(function(e){ var el=document.getElementById('cmLogsList'); if(el) el.innerHTML='<div style="padding:16px;color:#dc2626;font-size:13px;">Could not load — '+((e&&e.code)||'error')+'</div>'; });
    }catch(e){ var el=document.getElementById('cmLogsList'); if(el) el.innerHTML='<div style="padding:16px;color:#dc2626;font-size:13px;">Unavailable</div>'; }
  }
  function _cmRenderLogsList(items){
    _cmHist=items||[]; var el=document.getElementById('cmLogsList'); if(!el) return;
    if(!_cmHist.length){ el.innerHTML='<div style="padding:16px;color:#9ca3af;font-size:13px;">No saved incidents yet. They appear here after an operation ends.</div>'; return; }
    el.innerHTML=_cmHist.map(function(v,i){ var when=v.endedAt?new Date(v.endedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):''; var dur=(v.startedAt&&v.endedAt)?Math.round((v.endedAt-v.startedAt)/60000):null; var icon=v.type==='missing'?'🔍':'🎖️'; return '<div onclick="cmOpenLog('+i+')" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;margin-bottom:8px;cursor:pointer;"><div style="display:flex;align-items:center;gap:8px;"><span style="font-size:16px;">'+icon+'</span><span style="font-weight:800;color:#111827;font-size:14px;flex:1;">'+escapeHTML(v.title||(v.type==='missing'?'Missing Person Search':'Command Operation'))+'</span><span style="color:#94a3b8;font-size:18px;">›</span></div><div style="font-size:12px;color:#64748b;margin-top:4px;">'+when+(dur!=null?(' · '+dur+' min'):'')+' · Lead BC-'+U(v.leadUnit||'')+' · '+((v.members||[]).length)+' members · '+((v.log||[]).length)+' log entries</div></div>'; }).join('');
  }
  var _cmArchTab='calls';
  function cmArchTab(i,t){ _cmArchTab=t; cmOpenLog(i); }
  function cmOpenLog(i){
    var v=_cmHist[i]; if(!v) return;
    var defs=[{k:'calls',label:'🚨 Calls'},{k:'chats',label:'💬 Chats'},{k:'log',label:'📝 Notes/Log'}];
    var tabs=defs.map(function(d){ var on=_cmArchTab===d.k; return '<button onclick="cmArchTab('+i+',\''+d.k+'\')" style="flex:1;padding:9px 6px;border:none;border-radius:9px;font-family:inherit;font-size:12px;font-weight:800;cursor:pointer;background:'+(on?'#1e3a5f':'#f1f5f9')+';color:'+(on?'#fff':'#64748b')+';">'+d.label+'</button>'; }).join('');
    var section='';
    if(_cmArchTab==='calls'){
      var calls=v.calls||[];
      section=calls.length? calls.map(function(c){ var st=(c.status==='done')?'COMPLETED':(c.status==='cancelled')?'CANCELLED':(c.status||'open').toUpperCase(); var sc=(c.status==='done')?'#16a34a':(c.status==='cancelled')?'#6b7280':'#d97706'; var dur=(c.completedAt&&c.createdAt)?(' · '+Math.round((c.completedAt-c.createdAt)/60000)+' min'):''; return '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:11px 12px;margin-bottom:8px;"><div style="display:flex;align-items:center;gap:8px;"><span style="font-weight:800;color:#0f172a;font-size:14px;">#'+(c.callNum||'—')+' '+escapeHTML(c.typeLabel||c.type||'')+'</span><span style="margin-left:auto;font-size:10px;font-weight:800;color:#fff;background:'+sc+';padding:2px 8px;border-radius:6px;">'+st+'</span></div><div style="font-size:12px;color:#64748b;margin-top:3px;">'+escapeHTML(((c.town||'')+' '+(c.address||'')).trim()||'no location')+dur+'</div><div style="font-size:12px;color:#334155;margin-top:3px;">Responders: '+((c.responders||[]).join(', ')||'none')+'</div>'+(c.notes?'<div style="font-size:12px;color:#78350f;background:#fffbeb;border-radius:7px;padding:6px 8px;margin-top:5px;">📝 '+escapeHTML(c.notes)+'</div>':'')+'</div>'; }).join('') : '<div style="padding:16px;color:#9ca3af;font-size:13px;text-align:center;">No calls recorded for this operation.</div>';
    } else if(_cmArchTab==='chats'){
      var msgs=(v.log||[]).filter(function(e){ return e.channel==='dispatch'||e.channel==='members'; }).slice().sort(function(a,b){ return (a.at||0)-(b.at||0); });
      section=msgs.length? msgs.map(function(e){ var t=new Date(e.at||0).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); var tag=e.channel==='dispatch'?'Dispatch':'Members'; var col=e.channel==='dispatch'?'#1e3a5f':'#0e7490'; return '<div style="margin-bottom:8px;"><span style="font-size:9.5px;font-weight:800;color:#fff;background:'+col+';padding:1px 7px;border-radius:5px;">'+tag+'</span> <span style="font-size:13px;color:#0f172a;">'+_cmBoldCalls(escapeHTML(e.text||''))+'</span><div style="font-size:10px;color:#94a3b8;">'+(e.by?'BC-'+U(e.by)+' · ':'')+t+'</div></div>'; }).join('') : '<div style="padding:16px;color:#9ca3af;font-size:13px;text-align:center;">No chat messages in this operation.</div>';
    } else {
      section='<pre style="background:#0b1220;color:#cbd5e1;border-radius:10px;padding:12px;font-size:11px;line-height:1.5;white-space:pre-wrap;font-family:\'DM Mono\',monospace;margin:0;">'+escapeHTML(_cmHistText(v))+'</pre>';
    }
    var body='<div style="display:flex;gap:6px;margin-bottom:12px;">'+tabs+'</div>'
      +'<div style="max-height:44vh;overflow-y:auto;-webkit-overflow-scrolling:touch;margin-bottom:12px;">'+section+'</div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;"><button onclick="cmHistWhatsApp('+i+')" style="background:#075e54;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:800;font-size:13px;cursor:pointer;">📱 WhatsApp</button><button onclick="cmHistEmail('+i+')" style="background:#1e3a5f;color:#fff;border:none;border-radius:10px;padding:12px;font-weight:800;font-size:13px;cursor:pointer;">✉️ Email</button></div>'
      +'<button onclick="cmHistDelete('+i+')" style="width:100%;margin-top:8px;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:10px;padding:12px;font-weight:800;font-size:13px;cursor:pointer;">🗑️ Delete this log</button>'
      +'<button onclick="openCommandLogs()" style="width:100%;margin-top:8px;background:transparent;border:none;color:#6b7280;font-size:13px;font-weight:700;padding:6px;cursor:pointer;">‹ Back to all logs</button>';
    _cmSheet('📄 '+escapeHTML(v.title||'Incident'), body);
  }
  function cmCallResp(u){ var m=(STATE.members||[]).find(function(x){ return U(x.unit||x.id)===U(u); }); var ph=m&&m.phone?m.phone:''; if(!ph){ showToast('No phone on file for BC-'+U(u)); return; } try{ window.location.href='tel:'+ph; }catch(e){} }
  function cmRemoveResp(callId,u){ u=U(u); var c=(STATE.calls||[]).find(function(x){ return x.id===callId; }); if(!c) return; var r=(c.responders||[]).find(function(x){ return U(x.unit)===u; }); var nm=r&&r.name?(' '+r.name):''; if(!confirm('Take BC-'+u+nm+' off this call?\n\nThey will be notified not to respond.')) return; try{ if(typeof removeApprovedResponder==='function'){ removeApprovedResponder(callId,u); } else { c.responders=(c.responders||[]).filter(function(x){ return U(x.unit)!==u; }); try{ db().collection('calls').doc(String(callId)).update({ responders:c.responders }); }catch(e){} if(typeof save==='function') save(); } }catch(e){}
    _cmAddLog('➖ BC-'+u+' taken off call '+(c.callNum?('#'+c.callNum):'')+' by BC-'+myUnit(),'assign');
    setTimeout(function(){ if(document.getElementById('cmSheet')) _cmCallPopup(callId); _cmRenderCallRows(); },350); }
  function cmHistDelete(i){ var v=_cmHist[i]; if(!v||!v._id) return; if(!(cmAmAdmin()||myUnit()===U(v.leadUnit||''))){ showToast('Only an admin or the op lead can delete a log'); return; } if(!confirm('⚠️ Delete this log permanently?\n\n“'+((v.title||'Incident'))+'”\n\nThis removes the full report, notes, and activity log from Command Operation Logs for everyone. This cannot be undone.')) return; try{ db().collection('commandHistory').doc(v._id).delete().then(function(){ _cmHist.splice(i,1); showToast('🗑️ Log deleted'); openCommandLogs(); }).catch(function(e){ showToast('Delete failed — '+((e&&e.code)||'error')); }); }catch(e){ showToast('Delete failed'); } }
  function cmHistWhatsApp(i){ var v=_cmHist[i]; if(!v) return; var txt=_cmHistText(v); try{ sendWA({ target:'all', message:txt }); showToast('📱 Sent'); }catch(e){ try{ window.open('https://wa.me/?text='+encodeURIComponent(txt),'_blank'); }catch(_){} } }
  function cmHistEmail(i){ var v=_cmHist[i]; if(!v) return; var txt=_cmHistText(v); try{ window.location.href='mailto:?subject='+encodeURIComponent(v.title||'Incident Report')+'&body='+encodeURIComponent(txt); }catch(e){} }

  Object.assign(window, {
    initCommandMode:initCommandMode, openCommandModeAdmin:openCommandModeAdmin, openMissingPersonAdmin:openMissingPersonAdmin,
    openCommandView:openCommandView, closeCommandView:closeCommandView, cmToggleMapExpand:cmToggleMapExpand, cmMemberSignOut:cmMemberSignOut, cmMemberChat:cmMemberChat, cmMemberChatTab:cmMemberChatTab, cmMemberChatSend:cmMemberChatSend,
    cmSetLinkMode:cmSetLinkMode, cmPhotoPick:cmPhotoPick, cmTogglePick:cmTogglePick, cmConfirmStart:cmConfirmStart,
    cmFilterSetup:cmFilterSetup, cmAddMembers:cmAddMembers, cmFilterAdd:cmFilterAdd, cmConfirmAdd:cmConfirmAdd,
    cmFocusMember:cmFocusMember, cmAssignNearest:cmAssignNearest, cmAssignUnitToCall:cmAssignUnitToCall, cmAssignMember:cmAssignMember, cmApproveResp:cmApproveResp, cmRejectResp:cmRejectResp, cmBroadcast:cmBroadcast,
    cmPromptNote:cmPromptNote, cmChatTab:cmChatTab, cmChatSend:cmChatSend, cmOpenChat:cmOpenChat, cmChatMenu:cmChatMenu, cmEditReport:cmEditReport, cmSaveReport:cmSaveReport,
    cmAddNote:cmAddNote, cmEndNight:cmEndNight, cmToggleDraw:cmToggleDraw, cmToggleErase:cmToggleErase, _cmSyncSettingsButton:_cmSyncSettingsButton, _cmSyncCommsButton:_cmSyncCommsButton,
    cmSetCallFilter:cmSetCallFilter, cmCallSearchInput:cmCallSearchInput, _cmCallPopup:_cmCallPopup, cmCallResp:cmCallResp, cmRemoveResp:cmRemoveResp, cmEscalate:cmEscalate, cmClearCall:cmClearCall, cmCancelCallCmd:cmCancelCallCmd, cmSaveCloseNote:cmSaveCloseNote, cmSkipCloseNote:cmSkipCloseNote,
    cmManageViewers:cmManageViewers, cmFilterViewers:cmFilterViewers, cmConfirmViewers:cmConfirmViewers, cmRemoveViewer:cmRemoveViewer,
    cmNewCall:cmNewCall,
    cmReportWhatsApp:cmReportWhatsApp, cmReportEmail:cmReportEmail, cmReportSave:cmReportSave, cmReportEndConfirm:cmReportEndConfirm,
    openCommandLogs:openCommandLogs, cmOpenLog:cmOpenLog, cmArchTab:cmArchTab, cmHistWhatsApp:cmHistWhatsApp, cmHistEmail:cmHistEmail, cmHistDelete:cmHistDelete, cmLogExternal:cmLogExternal, cmExternalComplete:cmExternalComplete
  });
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(initCommandMode,1200); });
  else setTimeout(initCommandMode,1200);
})();
