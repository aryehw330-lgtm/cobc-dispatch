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
  var _cmPick={};   // start/add member selection: unit → true

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
  function cmAmAdmin(){ return typeof SESSION!=='undefined'&&SESSION&&SESSION.role==='admin'; }
  function cmAmOnDuty(){ try{ return (_onDutyDispatchUnits()||[]).map(U).indexOf(myUnit())>=0; }catch(e){ return false; } }
  function cmCanView(){ return cmIsActive()&&(cmAmAdmin()||myUnit()===cmLeadUnit()||cmAmOnDuty()); }

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
    _cmRenderBanner(); _cmSyncSettingsButton();
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
      _cmUnsub.log=db().collection('commandLog').orderBy('at','desc').limit(200).onSnapshot(function(snap){
        _cmLog=snap.docs.map(function(d){ return d.data(); });
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
      +'<button onclick="cmMemberSignOut()" style="flex-shrink:0;background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:800;cursor:pointer;">Sign out</button>';
    if(!document.getElementById('cmPulseStyle')){ var s=document.createElement('style'); s.id='cmPulseStyle'; s.textContent='@keyframes cmPulse{0%,100%{opacity:1}50%{opacity:.35}}'; document.head.appendChild(s); }
  }
  function cmMemberSignOut(){
    if(!confirm('Sign out? You will stop sharing your location.')) return;
    var u=myUnit(); _cmStopShare();
    try{ db().collection('commandLocations').doc(u).delete().catch(function(){}); }catch(e){}
    try{ db().collection('config').doc('commandMode').update({ members:cmMembers().filter(function(m){ return U(m.unit)!==u; }) }); }catch(e){}
    showToast('Signed out');
  }

  // ── Settings entry points ──────────────────────────────────────────────────
  function _cmSyncSettingsButton(){
    var active=cmIsActive(), t=cmType();
    var cs=document.getElementById('cmSettingsStatus'); if(cs) cs.textContent=(active&&t==='command')?'ACTIVE':'Off';
    var ms=document.getElementById('mpSettingsStatus'); if(ms) ms.textContent=(active&&t==='missing')?'ACTIVE':'Off';
    var co=document.getElementById('cmOpenBtn'); if(co) co.style.display=(cmCanView()&&t==='command')?'block':'none';
    var mo=document.getElementById('mpOpenBtn'); if(mo) mo.style.display=(cmCanView()&&t==='missing')?'block':'none';
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
      +   '<label id="mpPhotoBox" style="width:78px;height:78px;border-radius:12px;background:#f1f5f9;border:1.5px dashed #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:11px;color:#64748b;text-align:center;cursor:pointer;flex-shrink:0;overflow:hidden;">Add photo<input id="mpPhoto" type="file" accept="image/*" capture="environment" onchange="cmPhotoPick(event)" style="display:none;"/></label>'
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
        var box=document.getElementById('mpPhotoBox'); if(box) box.style.backgroundImage='url('+_cmPhotoData+')', box.style.backgroundSize='cover', box.innerHTML='<input id="mpPhoto" type="file" accept="image/*" capture="environment" onchange="cmPhotoPick(event)" style="display:none;"/>';
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
  }
  function cmFilterSetup(q){ q=(q||'').toLowerCase().trim(); document.querySelectorAll('#cmMemberPick .cmPick').forEach(function(el){ var hit=!q||el.dataset.u.indexOf(q)>=0||(el.dataset.n||'').indexOf(q)>=0; el.style.display=hit?'flex':'none'; }); }

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
  function _cmAddLog(text,kind){ try{ db().collection('commandLog').add({ at:Date.now(), text:String(text||''), kind:kind||'note', by:myUnit() }).catch(function(){}); }catch(e){} }
  function cmAddNote(){ var t=prompt('Add a note to the log:'); if(t&&t.trim()) _cmAddLog(t.trim(),'note'); }

  // ── Full-screen view ──────────────────────────────────────────────────────────
  function openCommandView(){
    if(!cmCanView()){ showToast('Not available'); return; }
    var old=document.getElementById('cmOverlay'); if(old) old.remove();
    var canEnd=(myUnit()===cmLeadUnit())||cmAmAdmin();
    var missing=cmIsMissing();
    var ov=document.createElement('div'); ov.id='cmOverlay';
    ov.style.cssText='position:fixed;inset:0;z-index:9700;background:#0f172a;display:flex;flex-direction:column;';
    ov.innerHTML=''
      +'<div style="flex-shrink:0;background:#0b1220;color:#fff;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid rgba(255,255,255,.1);">'
        +'<div style="display:flex;align-items:center;gap:10px;min-width:0;"><span style="font-size:18px;">'+(missing?'🔍':'🎖️')+'</span><div style="min-width:0;"><div style="font-size:15px;font-weight:800;">'+(missing?'Missing Person Search':'Command Center')+'</div><div style="font-size:11px;color:#94a3b8;">Lead: BC-'+cmLeadUnit()+' · <span id="cmHeadcount"></span></div></div></div>'
        +'<div style="display:flex;gap:8px;flex-shrink:0;">'
          +(canEnd?'<button onclick="cmEndNight()" style="background:#7f1d1d;color:#fff;border:none;border-radius:9px;padding:8px 12px;font-size:12px;font-weight:800;cursor:pointer;">End</button>':'')
          +'<button onclick="closeCommandView()" style="background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:9px;padding:8px 14px;font-size:13px;font-weight:800;cursor:pointer;">✕</button>'
        +'</div>'
      +'</div>'
      +(missing?'<div id="cmSubjectBar" style="flex-shrink:0;background:#1a1000;border-bottom:1px solid rgba(255,255,255,.08);"></div>':'')
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
    _cmRenderSubjectBar(); _cmBuildSidebar();
    loadGoogleMapsAPI().then(_cmInitMap).catch(function(){ _cmMapFallback(); });
  }
  function closeCommandView(){ var o=document.getElementById('cmOverlay'); if(o) o.remove(); _cmMap=null; _cmMarkers={}; _cmCallMarkers={}; _cmGridShapes={}; _cmTrails={}; _cmLastSeenMk=null; }

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
    _cmMap.addListener('click', function(e){ if(_cmSectorArm){ _cmDropSector(e.latLng.lat(),e.latLng.lng()); } });
    _cmRefreshView();
  }
  function _cmMapFallback(){ var el=document.getElementById('cmMap'); if(el) el.innerHTML='<div style="color:#94a3b8;padding:20px;font-size:13px;">Map unavailable — check connection.</div>'; }
  function _transIcon(){ return { url:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'), size:new google.maps.Size(1,1), anchor:new google.maps.Point(0,0) }; }
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
    _cmRenderSubjectBar();
    if(!_cmMap||!_cmMap._isGoogle){ _cmBuildSidebar(); return; }
    var G=google.maps, seen={};
    // Members + breadcrumb trails
    cmMembers().forEach(function(mm){
      var u=U(mm.unit); var loc=_cmLocs[u]; if(!loc) return; seen[u]=1;
      var color=_cmMemberColor(u,loc);
      var mk=_cmMarkers[u];
      if(!mk){ mk=new G.Marker({ map:_cmMap, icon:_transIcon() }); mk.addListener('click', function(){ _cmMemberPopup(u); }); _cmMarkers[u]=mk; }
      mk.setPosition({lat:loc.lat,lng:loc.lng});
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
      var lbl='📍 '+(c.callNum?('#'+c.callNum+' '):'')+(cardTown?cardTown(c):(c.town||''));
      var mk=_cmCallMarkers[c.id];
      if(!mk){ mk=new G.Marker({ map:_cmMap, icon:_transIcon(), zIndex:999 }); mk.addListener('click', function(){ _cmCallPopup(c.id); }); _cmCallMarkers[c.id]=mk; }
      mk.setPosition(ll); mk.setLabel({ text:lbl, color:'#ef4444', fontWeight:'800', fontSize:'13px' });
    });
    Object.keys(_cmCallMarkers).forEach(function(id){ if(!cseen[id]){ _cmCallMarkers[id].setMap(null); delete _cmCallMarkers[id]; } });
    // Missing: last-seen pin + auto grid
    if(cmIsMissing()){
      var sub=(_cmState&&_cmState.subject)||{};
      if(sub.lastSeenLat!=null){
        if(!_cmLastSeenMk){ _cmLastSeenMk=new G.Marker({ map:_cmMap, icon:_transIcon(), zIndex:1200 }); _cmMap.setCenter({lat:sub.lastSeenLat,lng:sub.lastSeenLng}); _cmMap.setZoom(15); }
        _cmLastSeenMk.setPosition({lat:sub.lastSeenLat,lng:sub.lastSeenLng});
        _cmLastSeenMk.setLabel({ text:'★ Last seen', color:'#f59e0b', fontWeight:'800', fontSize:'14px' });
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
          _cmAddLog('🔴 Call '+(c.callNum?('#'+c.callNum+' '):'')+tl+' — '+(c.town||''),'call');
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
        +'<button onclick="cmAddMembers()" style="flex:1;min-width:0;background:#1e3a5f;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">＋ Members</button>'
        +(missing?'':'<button onclick="cmArmSector()" id="cmSectorBtn" style="flex:1;min-width:0;background:#3730a3;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">⬡ Sector</button>')
        +'<button onclick="cmBroadcast()" style="flex:1;min-width:0;background:#065f46;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">📣 Broadcast</button>'
        +'<button onclick="cmAddNote()" style="flex:1;min-width:0;background:#374151;color:#fff;border:none;border-radius:8px;padding:9px;font-size:12px;font-weight:700;cursor:pointer;">✎ Note</button>'
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
  function _cmRenderLog(){ var el=document.getElementById('cmLogList'); if(!el) return; el.innerHTML=(_cmLog||[]).map(function(e){ var t=new Date(e.at||0).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}); return '<div style="padding:6px 12px;font-size:12px;color:#cbd5e1;border-bottom:1px solid rgba(255,255,255,.04);"><span style="color:#64748b;">'+t+'</span> · '+escapeHTML(e.text||'')+'</div>'; }).join('')||'<div style="padding:8px 12px;color:#64748b;font-size:12px;">No events yet.</div>'; }

  function cmFocusMember(u){ var loc=_cmLocs[u]; if(loc&&_cmMap&&_cmMap._isGoogle){ _cmMap.panTo({lat:loc.lat,lng:loc.lng}); _cmMap.setZoom(16); } _cmMemberPopup(u); }
  function _cmMemberPopup(u){
    var mm=cmMembers().find(function(x){ return U(x.unit)===u; }); var loc=_cmLocs[u];
    var m=(STATE.members||[]).find(function(x){ return U(x.unit||x.id)===u; }); var phone=m&&m.phone?m.phone:'';
    var status=u===cmLeadUnit()?'Command Lead':(!loc||(Date.now()-(loc.at||0))>CM_STALE_MS?'No recent signal':(_cmUnitOnCall(u)?'On an active call':'Idle / available'));
    var when=loc&&loc.at?new Date(loc.at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}):'—';
    _cmSheet('BC-'+u+(mm&&mm.name?' · '+escapeHTML(mm.name):''),
      '<div style="font-size:13px;color:#374151;margin-bottom:4px;">'+status+'</div><div style="font-size:12px;color:#6b7280;margin-bottom:14px;">Last update: '+when+'</div>'
      +(phone?'<div style="display:flex;gap:8px;"><a href="tel:'+phone+'" style="flex:1;text-align:center;background:#065f46;color:#fff;text-decoration:none;border-radius:10px;padding:12px;font-weight:800;">📞 Call</a><a href="sms:'+phone+'" style="flex:1;text-align:center;background:#1e3a5f;color:#fff;text-decoration:none;border-radius:10px;padding:12px;font-weight:800;">💬 Text</a></div>':'<div style="color:#9ca3af;font-size:12px;">No phone on file</div>'));
  }
  function _cmCallPopup(id){
    var c=(STATE.calls||[]).find(function(x){ return x.id===id; }); if(!c) return;
    var tl=cleanLabel?cleanLabel(CALL_TYPE_LABELS[c.type]||c.type||''):(c.type||'');
    var nearest=_cmNearestIdle(id);
    var body='<div style="font-size:13px;color:#374151;margin-bottom:3px;">'+escapeHTML(c.town||'')+(c.address?(' · '+escapeHTML(String(c.address).replace(/\s*—?\s*📍.*$/,''))):'')+'</div><div style="font-size:12px;color:#6b7280;margin-bottom:14px;">'+(c.responders&&c.responders.length?(c.responders.length+' responding'):'No units yet')+'</div>';
    if(nearest) body+='<button onclick="cmAssignNearest(\''+id+'\')" style="width:100%;background:#b45309;color:#fff;border:none;border-radius:10px;padding:13px;font-weight:800;font-size:14px;cursor:pointer;">Assign nearest idle unit → BC-'+nearest.unit+' ('+nearest.miles.toFixed(1)+' mi)</button>';
    else body+='<div style="color:#9ca3af;font-size:12px;">No idle units with a live location to assign.</div>';
    _cmSheet('🔴 Call '+(c.callNum?('#'+c.callNum+' '):'')+tl, body);
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
    try{ db().collection('calls').doc(String(c.id)).update({ responders:c.responders }); }catch(e){}
    try{ if(typeof save==='function') save(); if(typeof renderCalls==='function') renderCalls(); }catch(e){}
    try{ sendPush({ target:'unit', unit:n.unit, title:'🎖️ Command assignment', body:'Assigned to Call '+(c.callNum?('#'+c.callNum):'')+' — '+(c.town||''), url:'/cobc-dispatch/?page=dispatch', urgent:'true' }); }catch(e){}
    _cmAddLog('➡️ BC-'+n.unit+' assigned to call '+(c.callNum?('#'+c.callNum):'')+' ('+n.miles.toFixed(1)+' mi)','assign');
    showToast('Assigned BC-'+n.unit); var s=document.getElementById('cmSheet'); if(s) s.remove();
  }

  // ── Add members mid-op (click-to-toggle, robust) ────────────────────────────
  function cmAddMembers(){
    _cmPick={};
    var have={}; cmMembers().forEach(function(m){ have[U(m.unit)]=1; });
    var members=(STATE.members||[]).filter(function(m){ return !have[U(m.unit||m.id)]; }).sort(function(a,b){ return (parseInt(U(a.unit||a.id))||0)-(parseInt(U(b.unit||b.id))||0); });
    var body='<input id="cmAddSearch" placeholder="Filter…" oninput="cmFilterAdd(this.value)" style="width:100%;padding:9px 11px;border:1.5px solid #ddd;border-radius:9px;font-size:14px;margin-bottom:10px;box-sizing:border-box;"/>'
      +'<div id="cmAddPick" style="max-height:44vh;overflow-y:auto;">'+members.map(function(m){ var u=U(m.unit||m.id); var nm=((m.firstName||m.name||'')+' '+(m.lastName||'')).trim();
        return '<div class="cmAddRow" data-u="'+u+'" data-n="'+escapeHTML(nm.toLowerCase())+'" onclick="cmTogglePick(\''+u+'\',this)" style="display:flex;align-items:center;gap:10px;padding:10px 8px;border-bottom:1px solid #f2f2f2;cursor:pointer;border-radius:8px;"><span class="cmChk" style="width:20px;height:20px;border-radius:6px;border:2px solid #cbd5e1;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;flex-shrink:0;"></span><span style="font-weight:700;color:#1a3a5c;">BC-'+u+'</span><span style="color:#666;font-size:13px;">'+escapeHTML(nm)+'</span></div>';
      }).join('')||'<div style="color:#9ca3af;padding:8px;">Everyone is already added.</div>'+'</div>'
      +'<button onclick="cmConfirmAdd()" style="width:100%;margin-top:12px;background:#1e3a5f;color:#fff;border:none;border-radius:10px;padding:13px;font-weight:800;font-size:14px;cursor:pointer;">Add selected</button>';
    _cmSheet('Add members', body);
  }
  function cmFilterAdd(q){ q=(q||'').toLowerCase().trim(); document.querySelectorAll('#cmAddPick .cmAddRow').forEach(function(el){ var hit=!q||el.dataset.u.indexOf(q)>=0||(el.dataset.n||'').indexOf(q)>=0; el.style.display=hit?'flex':'none'; }); }
  function cmConfirmAdd(){
    var picked=Object.keys(_cmPick); if(!picked.length){ showToast('Tap members to select'); return; }
    var mem=(STATE.members||[]); var add=picked.map(function(u){ var m=mem.find(function(x){ return U(x.unit||x.id)===u; }); return { unit:u, name:m?((m.firstName||m.name||'')+' '+(m.lastName||'')).trim():'' }; });
    db().collection('config').doc('commandMode').update({ members:cmMembers().concat(add) }).then(function(){ _cmAddLog('➕ Added '+add.map(function(a){ return 'BC-'+a.unit; }).join(', '),'roster'); var s=document.getElementById('cmSheet'); if(s) s.remove(); _cmPick={}; showToast('Added '+add.length); }).catch(function(){ showToast('Could not add'); });
  }

  // ── Manual sectors (command only) ──────────────────────────────────────────
  function cmArmSector(){ _cmSectorArm=!_cmSectorArm; var b=document.getElementById('cmSectorBtn'); if(b){ b.style.background=_cmSectorArm?'#a78bfa':'#3730a3'; b.textContent=_cmSectorArm?'⬡ Tap map…':'⬡ Sector'; } showToast(_cmSectorArm?'Tap the map to drop a sector':'Sector off'); }
  function _cmDropSector(lat,lng){ var label=prompt('Sector label:'); if(label===null) return; var sectors=((_cmState&&_cmState.sectors)||[]).concat([{ id:'s'+Date.now(), label:(label||'Zone').trim(), lat:lat, lng:lng }]); db().collection('config').doc('commandMode').update({ sectors:sectors }).then(function(){ _cmAddLog('⬡ Sector "'+(label||'Zone')+'" added','sector'); }); _cmSectorArm=false; var b=document.getElementById('cmSectorBtn'); if(b){ b.style.background='#3730a3'; b.textContent='⬡ Sector'; } }

  // ── Broadcast ───────────────────────────────────────────────────────────────
  function cmBroadcast(){ var msg=prompt('Broadcast to all members:'); if(!msg||!msg.trim()) return; cmMembers().forEach(function(mm){ try{ sendPush({ target:'unit', unit:U(mm.unit), title:(cmIsMissing()?'🔍 Search':'🎖️ Command'), body:msg.trim(), url:'/cobc-dispatch/?page=dispatch', urgent:'true' }); }catch(e){} }); try{ sendWA({ target:'all', message:(cmIsMissing()?'🔍 SEARCH: ':'🎖️ COMMAND: ')+msg.trim() }); }catch(e){} _cmAddLog('📣 Broadcast: '+msg.trim(),'broadcast'); showToast('📣 Sent'); }

  // ── End ─────────────────────────────────────────────────────────────────────
  function cmEndNight(){
    if(!((myUnit()===cmLeadUnit())||cmAmAdmin())){ showToast('Only the lead or an admin can end it'); return; }
    if(!confirm('End this operation? Members stop sharing and a summary is saved.')) return;
    var summary={ type:cmType(), startedAt:(_cmState&&_cmState.startedAt)||null, endedAt:Date.now(), leadUnit:cmLeadUnit(), members:cmMembers(), subject:(_cmState&&_cmState.subject)||null, sectors:(_cmState&&_cmState.sectors)||[], grid:(_cmState&&_cmState.grid)||[], linkedCallId:(_cmState&&_cmState.linkedCallId)||null, log:_cmLog.slice(0,500), endedBy:myUnit() };
    try{ db().collection('commandHistory').add(summary); }catch(e){}
    _cmAddLog('🏁 Operation ended by BC-'+myUnit(),'end');
    db().collection('config').doc('commandMode').set({ active:false, endedAt:Date.now() }, {merge:true}).then(function(){ try{ db().collection('commandLocations').get().then(function(s){ s.forEach(function(d){ d.ref.delete().catch(function(){}); }); }); }catch(e){} closeCommandView(); showToast('🏁 Ended — summary saved'); });
  }

  Object.assign(window, {
    initCommandMode:initCommandMode, openCommandModeAdmin:openCommandModeAdmin, openMissingPersonAdmin:openMissingPersonAdmin,
    openCommandView:openCommandView, closeCommandView:closeCommandView, cmMemberSignOut:cmMemberSignOut,
    cmSetLinkMode:cmSetLinkMode, cmPhotoPick:cmPhotoPick, cmTogglePick:cmTogglePick, cmConfirmStart:cmConfirmStart,
    cmFilterSetup:cmFilterSetup, cmAddMembers:cmAddMembers, cmFilterAdd:cmFilterAdd, cmConfirmAdd:cmConfirmAdd,
    cmFocusMember:cmFocusMember, cmAssignNearest:cmAssignNearest, cmArmSector:cmArmSector, cmBroadcast:cmBroadcast,
    cmAddNote:cmAddNote, cmEndNight:cmEndNight, _cmSyncSettingsButton:_cmSyncSettingsButton
  });
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', function(){ setTimeout(initCommandMode,1200); });
  else setTimeout(initCommandMode,1200);
})();
