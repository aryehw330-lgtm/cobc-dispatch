// COBC Equipment Dashboard - Apps Script v77
// v77: Added COBC 4 Car Schedule system
//      - CarSchedule sheet (auto-created) tracks all bookings
//      - doGet: getCarSchedule action
//      - doPost: bookCarShift, startCarShift, endCarShift, cancelCarShift, approveCarShift, setCarAccess
//      - getMembersJSON / getMemberByPinJSON: now include carAccess field (col G of member sheet)

var SSID        = '1iOE4c-BBatkH8zljpQTFmrzZZe_Q4uvBDWAQCos51PE';
var MEMBER_SSID = '1Leh-KVqnLai650Se4JftnG1zTz6FbuCcbOUqUGmlfEk';
var SHEET       = 'Inventory';
var BASE_URL    = 'https://script.google.com/macros/s/AKfycbwjnEHbt8v1aVKUO7361uc8XTodz5yBWGKoRgQ3H26UFOJeAQarVQAGaEuYj277Ed14rw/exec';

// ── Sheet Column Map (0-indexed) ──────────────────────────────────────────────
// A(0)=IN  B(1)=OUT  C(2)=Item Name  D(3)=Home Location  E(4)=Member#
// F(5)=Call#  G(6)=Last Updated  H(7)=CC/CNC Note  I(8)=Open Form  J(9)=Print QR
// K(10)=Equipment Status  L(11)=Equipment Note  M(12)=Last Checked

// ── Member Sheet Column Map (0-indexed, MEMBER_SSID) ─────────────────────────
// A(0)=BC#  B(1)=LastName  C(2)=FirstName  D(3)=Phone  E(4)=StatusLevel
// F(5)=PIN  G(6)=CarAccess (TRUE/FALSE)

// ── CarSchedule Sheet Column Map (0-indexed) ─────────────────────────────────
// A(0)=ID  B(1)=MemberID  C(2)=MemberName  D(3)=Date(YYYY-MM-DD)
// E(4)=StartTime  F(5)=EndTime  G(6)=Status  H(7)=Notes
// I(8)=NeedsApproval  J(9)=CreatedTimestamp

// ── Sheet Menu ────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚙️ COBC Tools')
    .addItem('🔗 Make QR Codes for New Items',     'addQRLinks')
    .addItem('📋 Setup Equipment Status Column',   'setupEquipmentStatusColumn')
    .addItem('🔄 Rebuild Cache Only',              'warmup')
    .addItem('🔧 Fix Col H from Col K',            'fixColH')
    .addItem('🚗 Setup CarSchedule Sheet',         'setupCarScheduleSheet')
    .addToUi();
}

// ── Auto-update col H and col L when col K changes in the sheet ───────────────
function onEdit(e) {
  if (!e) return;
  var range = e.range;
  var sheet = range.getSheet();
  if (sheet.getName() !== SHEET) return;
  if (range.getColumn() !== 11) return; // only col K
  var row    = range.getRow();
  if (row < 2) return;
  var newVal = (range.getValue() || '').toString().trim();
  if (newVal === 'OK') {
    sheet.getRange(row, 12).setValue(''); // clear col L note
    sheet.getRange(row, 8).setValue('CC'); // reset col H to CC
  }
}

// ── v75: Setup Equipment Status column K ─────────────────────────────────────
function setupEquipmentStatusColumn() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET);
  var last  = sheet.getLastRow();

  var hdr = sheet.getRange(1, 11);
  hdr.setValue('Equipment Status');
  hdr.setFontWeight('bold');
  hdr.setBackground('#1a3a5c');
  hdr.setFontColor('#ffffff');

  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['OK', 'Missing', 'Damaged', 'Need More'], true)
    .setAllowInvalid(false)
    .build();
  if (last > 1) {
    sheet.getRange(2, 11, last - 1, 1).setDataValidation(rule);
  }

  var statusRange = sheet.getRange('K2:K' + last);
  var rules = sheet.getConditionalFormatRules();

  var okRule = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('OK')
    .setBackground('#EAF3DE').setFontColor('#2d6a4f')
    .setRanges([statusRange]).build();

  var missingRule = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('Missing')
    .setBackground('#fdecea').setFontColor('#c0392b')
    .setRanges([statusRange]).build();

  var damagedRule = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('Damaged')
    .setBackground('#fff3cd').setFontColor('#856404')
    .setRanges([statusRange]).build();

  var needRule = SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo('Need More')
    .setBackground('#e8f4f8').setFontColor('#0c5460')
    .setRanges([statusRange]).build();

  rules.push(okRule, missingRule, damagedRule, needRule);
  sheet.setConditionalFormatRules(rules);

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][2] && !data[i][10]) {
      sheet.getRange(i + 1, 11).setValue('OK');
    }
  }

  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert('✅ Equipment Status column (K) is set up!');
}

// ── Fix col H to match col K for Missing/Damaged rows ────────────────────────
function fixColH() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET);
  var data  = sheet.getDataRange().getValues();
  var fixed = 0;
  if (!data[0][11] || data[0][11].toString().trim() === '') {
    sheet.getRange(1, 12).setValue('Equipment Note');
    sheet.getRange(1, 12).setFontWeight('bold').setBackground('#1a3a5c').setFontColor('#ffffff');
  }
  for (var i = 1; i < data.length; i++) {
    var colK = data[i][10] ? data[i][10].toString().trim() : '';
    var colH = data[i][7]  ? data[i][7].toString().trim()  : '';
    var colL = data[i][11] ? data[i][11].toString().trim()  : '';
    if ((colK === 'Missing' || colK === 'Damaged' || colK === 'Need More') && !colL) {
      var prefix = colK.toUpperCase();
      if (colH.toUpperCase().indexOf(prefix) === 0) {
        sheet.getRange(i+1, 12).setValue(colH);
        sheet.getRange(i+1, 8).setValue('CC');
        fixed++;
      } else if (colH !== 'CC' && colH !== '') {
        sheet.getRange(i+1, 12).setValue(prefix);
        fixed++;
      }
    }
  }
  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert('Migrated ' + fixed + ' rows to col L. Col H preserved.');
}

function addQRLinks() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET);
  var data  = sheet.getDataRange().getValues();
  var count = 0;
  for (var i = 1; i < data.length; i++) {
    var item = data[i][2];
    if (!item) continue;
    var name    = item.toString().trim();
    var formUrl = 'https://aryehw330-lgtm.github.io/chaverim-equipment/form.html?name=' + encodeURIComponent(name);
    var qrUrl   = BASE_URL + '?item=' + encodeURIComponent(name) + '&view=qr';
    sheet.getRange(i+1, 9).setFormula('=HYPERLINK("' + formUrl + '","Open Form")');
    sheet.getRange(i+1,10).setFormula('=HYPERLINK("' + qrUrl   + '","🖨️ Print QR Sticker")');
    count++;
  }
  SpreadsheetApp.getUi().alert('Done! Added QR links for ' + count + ' new items.');
}

function warmup() {
  SpreadsheetApp.getUi().alert('Cache rebuild triggered.');
}

// ── v77: Setup CarSchedule sheet ─────────────────────────────────────────────
function setupCarScheduleSheet() {
  var ss = SpreadsheetApp.openById(SSID);
  getOrCreateCarScheduleSheet(ss);
  SpreadsheetApp.getUi().alert('✅ CarSchedule sheet is ready!');
}

// ── v77: Get or create CarSchedule sheet ─────────────────────────────────────
function getOrCreateCarScheduleSheet(ss) {
  var sheet = ss.getSheetByName('CarSchedule');
  if (!sheet) {
    sheet = ss.insertSheet('CarSchedule');
    var headers = ['ID', 'MemberID', 'MemberName', 'Date', 'StartTime', 'EndTime', 'Status', 'Notes', 'NeedsApproval', 'CreatedTimestamp', 'ActualSignOut', 'ActualSignIn'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#1a3a5c')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);  // ID
    sheet.setColumnWidth(3, 160);  // MemberName
    sheet.setColumnWidth(4, 110);  // Date
    sheet.setColumnWidth(7, 100);  // Status
    sheet.setColumnWidth(8, 220);  // Notes
  }
  return sheet;
}

// ── Main doGet ────────────────────────────────────────────────────────────────
function doGet(e) {
  var item   = ep(e, 'item');
  var view   = ep(e, 'view');
  var action = ep(e, 'action');

  // ── PWA data endpoints ──
  if (!item) {
    if (action === 'getInventory' || action === 'getall') return getInventoryJSON();
    if (action === 'getMembers')                          return getMembersJSON();
    if (action === 'getLocations')                        return getLocationsJSON();
    if (action === 'getChecklist')                        return getChecklistJSON();
    if (action === 'getMemberByPin')                      return getMemberByPinJSON(ep(e,'pin'));
    if (action === 'getCarSchedule')                      return getCarScheduleJSON();
    return HtmlService.createHtmlOutput('<h2 style="font-family:Arial;padding:2rem">COBC Equipment API v77</h2>');
  }

  // ── Check-in/out pixel (from QR scan form) ──
  var chkAction = ep(e, 'action');
  if (chkAction === 'in' || chkAction === 'out') {
    try {
      var ss    = SpreadsheetApp.openById(SSID);
      var sheet = ss.getSheetByName(SHEET);
      var data  = sheet.getDataRange().getValues();
      var row   = -1;
      for (var i = 1; i < data.length; i++) {
        if (data[i][2] && data[i][2].toString().trim().toLowerCase() === item.trim().toLowerCase()) {
          row = i + 1; break;
        }
      }
      if (row > 0) {
        var now    = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yy h:mm a');
        var member = ep(e, 'member');
        var call   = ep(e, 'phone');
        var ccnc   = ep(e, 'ccnc');
        sheet.getRange(row, 1, 1, 2).clearContent();
        sheet.getRange(row, 1).setValue(chkAction === 'in' ? 'IN' : '');
        sheet.getRange(row, 2).setValue(chkAction === 'out' ? 'OUT' : '');
        sheet.getRange(row, 5).setValue(member);
        sheet.getRange(row, 6).setValue(call);
        sheet.getRange(row, 7).setValue(now);
        sheet.getRange(row, 8).setValue(ccnc);
        SpreadsheetApp.flush();
      }
    } catch(err) {}
    return HtmlService.createHtmlOutput('OK');
  }

  // ── QR page (printable sticker) ──
  if (view === 'qr') {
    var si   = esc(item);
    var fUrl = 'https://aryehw330-lgtm.github.io/chaverim-equipment/form.html?name=' + encodeURIComponent(item);
    var qrSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(fUrl);
    var loc2 = '';
    try {
      var ss3   = SpreadsheetApp.openById(SSID);
      var sh3   = ss3.getSheetByName(SHEET);
      var d3    = sh3.getDataRange().getValues();
      for (var k = 1; k < d3.length; k++) {
        if (d3[k][2] && d3[k][2].toString().trim() === item.toString().trim()) {
          loc2 = d3[k][3] ? d3[k][3].toString() : ''; break;
        }
      }
    } catch(e3) {}
    var logoB64 = '';
    try {
      var logoResp = UrlFetchApp.fetch('https://raw.githubusercontent.com/aryehw330-lgtm/chaverim-equipment/main/logo.jpg');
      logoB64 = 'data:image/jpeg;base64,' + Utilities.base64Encode(logoResp.getContent());
    } catch(el) {}
    var html = '<!DOCTYPE html><html><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>QR: ' + si + '</title>'
      + '<style>'
      + '*{box-sizing:border-box;margin:0;padding:0}'
      + 'body{font-family:Arial,sans-serif;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px}'
      + '.card{background:#fff;max-width:420px;width:100%;text-align:center;padding:30px 20px}'
      + '.header{display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:28px}'
      + '.logo{width:80px;height:80px;object-fit:contain}'
      + '.org-name{text-align:center}'
      + '.org-name h1{font-size:13px;font-weight:600;color:#1a3a5c;line-height:1.2;text-transform:uppercase;text-align:center}'
      + '.qr-wrap{margin:10px auto 20px}'
      + '.qr-wrap img{width:320px;height:320px}'
      + '.item-name{font-size:32px;font-weight:900;color:#1a1a1a;margin-bottom:6px}'
      + '.scan-text{font-size:16px;color:#aaa;margin-bottom:24px}'
      + '.print-btn{padding:14px 32px;background:#1a3a5c;color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer}'
      + '@media print{.print-btn{display:none}}'
      + '</style></head><body>'
      + '<div class="card">'
      + '<div class="header">'
      + (logoB64 ? '<img class="logo" src="' + logoB64 + '">' : '')
      + '<div class="org-name"><h1>Bergen County<br>Chaverim</h1></div>'
      + '</div>'
      + '<div class="qr-wrap"><img src="' + qrSrc + '" alt="QR Code"></div>'
      + '<div class="item-name">' + si + '</div>'
      + '<div class="scan-text">Scan to check in / out</div>'
      + '<button class="print-btn" onclick="window.print()">🖨️ Print</button>'
      + '</div></body></html>';
    return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // ── QR Scan form (PIN gate) ──
  var loc = '', status = 'IN';
  try {
    var ss2    = SpreadsheetApp.openById(SSID);
    var sheet2 = ss2.getSheetByName(SHEET);
    var data2  = sheet2.getDataRange().getValues();
    for (var j = 1; j < data2.length; j++) {
      if (data2[j][2] && data2[j][2].toString().trim().toLowerCase() === item.trim().toLowerCase()) {
        loc    = data2[j][3] ? data2[j][3].toString() : '';
        status = data2[j][1] === 'OUT' ? 'OUT' : 'IN';
        break;
      }
    }
  } catch(e2) {}

  var isIn    = (status === 'IN');
  var bgBadge = isIn ? '#EAF3DE' : '#fdecea';
  var colBadge= isIn ? '#2d6a4f' : '#c0392b';
  var label   = isIn ? 'Currently IN' : 'Currently OUT';
  var si2     = esc(item);
  var sl      = esc(loc);

  var h2 = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">'
    + '<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}'
    + '.card{background:white;border-radius:20px;padding:2rem 1.5rem;max-width:480px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08)}'
    + '.org{font-size:15px;font-weight:700;color:#1a3a5c;letter-spacing:.06em;text-transform:uppercase;text-align:center;margin-bottom:1rem}'
    + '.itm{font-size:22px;font-weight:700;text-align:center;margin-bottom:4px}.loc{font-size:13px;color:#888;text-align:center;margin-bottom:12px}'
    + '.badge{padding:5px 16px;border-radius:20px;font-size:13px;font-weight:600;margin:0 auto 1.5rem;display:block;width:fit-content}'
    + '.sep{height:1px;background:#f0f0f0;margin-bottom:1.25rem}'
    + 'label{font-size:12px;font-weight:600;color:#555;display:block;margin-bottom:5px}'
    + 'input,select{width:100%;padding:18px 16px;border:1.5px solid #e8e8e8;border-radius:10px;font-size:18px;margin-bottom:18px;outline:none;-webkit-appearance:none}'
    + '.hint{font-size:13px;color:#e24b4a;margin-bottom:18px;line-height:1.5}'
    + '.row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px}'
    + '.bin{background:#1a3a5c;color:white;border:none;border-radius:12px;padding:22px;font-size:22px;font-weight:700;cursor:pointer;width:100%}'
    + '.bout{background:#e24b4a;color:white;border:none;border-radius:12px;padding:22px;font-size:22px;font-weight:700;cursor:pointer;width:100%}'
    + '.ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:999;align-items:center;justify-content:center}.ov.on{display:flex}'
    + '.ob{background:white;border-radius:16px;padding:2rem 1.5rem;max-width:280px;width:90%;text-align:center}'
    + '.oc{width:64px;height:64px;border-radius:50%;color:white;font-size:28px;display:flex;align-items:center;justify-content:center;margin:0 auto 1rem}'
    + '.ol{font-size:20px;font-weight:700;margin-bottom:6px}.os{font-size:15px;color:#888;margin-bottom:6px}'
    + '.ocd{font-size:12px;color:#aaa;margin-bottom:1.2rem}.od{width:100%;padding:10px;background:#1a3a5c;color:white;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer}'
    + '#pg{display:flex;position:fixed;inset:0;background:#f0f2f5;z-index:9999;align-items:center;justify-content:center}'
    + '#pb{background:white;border-radius:20px;padding:2.5rem 2rem;max-width:340px;width:90%;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.1)}'
    + '#pi{width:100%;padding:16px;font-size:32px;text-align:center;letter-spacing:16px;border:2px solid #e0e0e0;border-radius:12px;outline:none;margin-bottom:12px}'
    + '#pe{display:none;color:#c0392b;font-size:13px;margin-bottom:10px;font-weight:600}'
    + '#pbt{width:100%;padding:16px;background:#1a3a5c;color:white;border:none;border-radius:12px;font-size:17px;font-weight:700;cursor:pointer}'
    + '#cncRow{display:none}#cncRow.show{display:block}'
    + '</style></head><body>'
    + '<div id="pg"><div id="pb">'
    + '<div style="font-size:48px;margin-bottom:12px">🔒</div>'
    + '<div style="font-size:20px;font-weight:700;color:#1a3a5c;margin-bottom:6px">Member Access</div>'
    + '<div style="font-size:13px;color:#888;margin-bottom:20px">Enter your member PIN</div>'
    + '<input id="pi" type="password" inputmode="numeric" maxlength="4" autocomplete="off">'
    + '<div id="pe">✗ Incorrect PIN</div>'
    + '<button id="pbt" onclick="checkQRPin()">Enter</button>'
    + '</div></div>'
    + '<div id="mw" style="display:none;width:100%;align-items:center;justify-content:center;min-height:100vh">'
    + '<div class="ov" id="ov"><div class="ob">'
    + '<div class="oc" id="oc"></div><div class="ol" id="ol"></div>'
    + '<div class="os">Submission confirmed</div><div class="ocd" id="ocd"></div>'
    + '<button class="od" onclick="doneFn()">Done</button></div></div>'
    + '<div class="card">'
    + '<div class="org">Bergen County Chaverim</div>'
    + '<div class="itm">' + si2 + '</div>'
    + '<div class="loc">Home: ' + sl + '</div>'
    + '<div class="badge" id="badge" style="background:' + bgBadge + ';color:' + colBadge + '">' + label + '</div>'
    + '<div class="sep"></div>'
    + '<label>Your BC Member #</label><input id="mb" type="text" inputmode="numeric" placeholder="e.g. 38">'
    + '<label>Call Number</label><input id="ph" type="text" inputmode="numeric" placeholder="Dispatched call #">'
    + '<label>CC or CNC?</label>'
    + '<select id="ccSel" onchange="toggleCNC()">'
    + '<option value="">-- Select --</option>'
    + '<option value="CC">CC — Correct location</option>'
    + '<option value="CNC">CNC — Wrong location</option>'
    + '</select>'
    + '<div id="cncRow"><label>CNC Note — where is the item?</label>'
    + '<input id="cncNote" type="text" placeholder="e.g. Left at Teaneck Garage"></div>'
    + '<div class="hint">CC = item returned to correct location &nbsp;|&nbsp; CNC = item in wrong location — be specific</div>'
    + '<div class="row"><button class="bin" onclick="go(\'in\')">IN</button><button class="bout" onclick="go(\'out\')">OUT</button></div>'
    + '</div></div></div>'
    + '<script>'
    + 'var BASE_URL_QR="' + BASE_URL + '";'
    + '(function(){'
    + '  var ok=localStorage.getItem("cobc_qr_pin_ok");'
    + '  if(ok==="1"){'
    + '    var mem=localStorage.getItem("cobc_qr_member");'
    + '    if(mem){try{var m=JSON.parse(mem);document.getElementById("mb").value=m.id||"";}catch(e){}}'
    + '    document.getElementById("pg").style.display="none";showQRForm();'
    + '  }else{document.getElementById("pi").focus();}'
    + '})();'
    + 'document.getElementById("pi").addEventListener("keydown",function(e){if(e.key==="Enter")checkQRPin();});'
    + 'function checkQRPin(){'
    + '  var v=document.getElementById("pi").value.trim();'
    + '  if(!v)return;'
    + '  if(v==="cobcadmin"||v==="cobcet"){'
    + '    localStorage.setItem("cobc_qr_pin_ok","1");'
    + '    localStorage.removeItem("cobc_qr_member");'
    + '    document.getElementById("pg").style.display="none";showQRForm();'
    + '    return;'
    + '  }'
    + '  document.getElementById("pi").disabled=true;'
    + '  fetch(BASE_URL_QR+"?action=getMemberByPin&pin="+encodeURIComponent(v),{redirect:"follow"})'
    + '  .then(function(r){return r.json();})'
    + '  .then(function(d){'
    + '    document.getElementById("pi").disabled=false;'
    + '    if(d&&d.id){'
    + '      localStorage.setItem("cobc_qr_pin_ok","1");'
    + '      localStorage.setItem("cobc_qr_member",JSON.stringify(d));'
    + '      document.getElementById("mb").value=d.id;'
    + '      document.getElementById("pg").style.display="none";showQRForm();'
    + '    }else{'
    + '      document.getElementById("pe").style.display="block";'
    + '      document.getElementById("pi").value="";'
    + '      document.getElementById("pi").focus();'
    + '      setTimeout(function(){document.getElementById("pe").style.display="none";},2000);'
    + '    }'
    + '  })'
    + '  .catch(function(){'
    + '    document.getElementById("pi").disabled=false;'
    + '    document.getElementById("pe").textContent="Connection error";'
    + '    document.getElementById("pe").style.display="block";'
    + '    document.getElementById("pi").value="";'
    + '    setTimeout(function(){document.getElementById("pe").style.display="none";},3000);'
    + '  });'
    + '}'
    + 'function showQRForm(){document.getElementById("mw").style.display="flex";}'
    + 'function toggleCNC(){var v=document.getElementById("ccSel").value;var row=document.getElementById("cncRow");row.className=v==="CNC"?"cncRow show":"cncRow";}'
    + 'var U="' + BASE_URL + '",IT="' + si2 + '",iv=null;'
    + 'function doneFn(){if(iv)clearInterval(iv);document.getElementById("ov").classList.remove("on");document.getElementById("mb").value="";document.getElementById("ph").value="";document.getElementById("ccSel").value="";document.getElementById("cncNote").value="";document.getElementById("cncRow").className="cncRow";}'
    + '<\/script></body></html>';

  return HtmlService.createHtmlOutput(h2).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── doPost ────────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action || '';
    var ss     = SpreadsheetApp.openById(SSID);
    var sheet  = ss.getSheetByName(SHEET);

    // CHECK IN / OUT from GitHub PWA
    if (action === 'checkInOut') {
      var rowNum = parseInt(body.row);
      if (!rowNum || isNaN(rowNum)) {
        var rows = sheet.getDataRange().getValues();
        for (var i = 1; i < rows.length; i++) {
          if (String(rows[i][2]).trim().toLowerCase() === String(body.row).trim().toLowerCase()) { rowNum = i+1; break; }
        }
      }
      if (!rowNum) return jr({success:false, error:'Item not found'});
      var status  = body.status || 'IN';
      var now     = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yy h:mm a');
      var ccSel   = body.ccSel  || 'CC';
      var cncNote = body.cncNote || '';
      var colH = (ccSel === 'CNC' && cncNote) ? 'CNC - ' + cncNote : ccSel;
      sheet.getRange(rowNum, 1, 1, 2).clearContent();
      sheet.getRange(rowNum, 1).setValue(status === 'IN'  ? 'IN'  : '');
      sheet.getRange(rowNum, 2).setValue(status === 'OUT' ? 'OUT' : '');
      sheet.getRange(rowNum, 5).setValue(body.member || '');
      sheet.getRange(rowNum, 6).setValue(body.call   || '');
      sheet.getRange(rowNum, 7).setValue(now);
      sheet.getRange(rowNum, 8).setValue(colH);
      SpreadsheetApp.flush();
      return jr({success:true});
    }

    // ── v75: UPDATE EQUIPMENT STATUS (col K) ──────────────────────────────────
    if (action === 'updateEquipmentStatus') {
      var rowNum2 = parseInt(body.row);
      if (!rowNum2 || isNaN(rowNum2)) return jr({success:false, error:'Invalid row'});
      var validStatuses = ['OK', 'Missing', 'Damaged', 'Need More', 'Not Active'];
      var newStatus = body.status || 'OK';
      if (validStatuses.indexOf(newStatus) === -1) return jr({success:false, error:'Invalid status'});
      sheet.getRange(rowNum2, 11).setValue(newStatus);
      if (newStatus === 'OK') {
        sheet.getRange(rowNum2, 12).setValue('');
        sheet.getRange(rowNum2, 8).setValue('CC');
      } else {
        if (body.member) {
          var memberNum = body.member.toString().replace(/^BC-?/i, '').trim();
          sheet.getRange(rowNum2, 5).setValue(memberNum);
        }
        if (body.note && body.note.toString().trim() !== '') {
          var equipNote = newStatus + ' - ' + body.note.toString().trim();
          sheet.getRange(rowNum2, 12).setValue(equipNote);
        }
      }
      SpreadsheetApp.flush();
      return jr({success:true});
    }

    // ── v76: SUBMIT CHECKLIST ─────────────────────────────────────────────────
    if (action === 'submitChecklist') {
      var rows  = body.rows;
      var bcNum = body.bc ? body.bc.toString().replace(/^BC-?/i, '').trim() : '?';
      if (!rows || !rows.length) return jr({success:false, error:'No rows provided'});

      var tz      = Session.getScriptTimeZone();
      var chkTime = Utilities.formatDate(new Date(), tz, 'MMM d, yyyy · h:mm a');
      var logVal  = 'BC-' + bcNum + ' · ' + chkTime;

      rows.forEach(function(r) {
        var rn = parseInt(r);
        if (rn && !isNaN(rn)) sheet.getRange(rn, 13).setValue(logVal);
      });
      SpreadsheetApp.flush();

      var logSheet = ss.getSheetByName('ChecklistLog');
      if (!logSheet) {
        logSheet = ss.insertSheet('ChecklistLog');
      }

      var existingHeaders = logSheet.getLastRow() > 0
        ? logSheet.getRange(1, 1, 1, logSheet.getLastColumn()).getValues()[0]
        : [];
      if (existingHeaders.length < 7 || !existingHeaders[3]) {
        logSheet.getRange(1, 1, 1, 7).setValues([['Timestamp','Location','Submitted By','Checked','Total','Issues','Issue Details']]);
        logSheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#1a3a5c').setFontColor('#ffffff');
        logSheet.setFrozenRows(1);
        logSheet.setColumnWidth(7, 320);
      }

      var issueDetails = body.issueDetails || [];
      var detailStr = issueDetails.length > 0
        ? issueDetails.map(function(d) {
            var s = '[' + (d.status || 'Issue') + '] ' + (d.name || '');
            if (d.note) s += ' — ' + d.note;
            return s;
          }).join('\n')
        : 'No issues';

      var location = body.location
        || (rows[0] ? sheet.getRange(parseInt(rows[0]), 4).getValue() : 'Unknown');

      var ts = body.timestamp ? new Date(body.timestamp) : new Date();

      logSheet.appendRow([
        ts,
        location,
        'BC-' + bcNum,
        body.checked   != null ? body.checked   : rows.length,
        body.total     != null ? body.total     : rows.length,
        body.issueCount != null ? body.issueCount : issueDetails.length,
        detailStr
      ]);

      var newRow = logSheet.getLastRow();
      logSheet.getRange(newRow, 1).setNumberFormat('M/d/yyyy h:mm am/pm');
      logSheet.getRange(newRow, 7).setWrap(true);

      return jr({success:true, log:logVal});
    }

    // ── v76: GET CHECKLIST LOG ────────────────────────────────────────────────
    if (action === 'getChecklistLog') {
      var logSheet = ss.getSheetByName('ChecklistLog');
      if (!logSheet || logSheet.getLastRow() < 2) {
        return ContentService.createTextOutput(JSON.stringify({log:[]}))
          .setMimeType(ContentService.MimeType.JSON);
      }
      var numCols = logSheet.getLastColumn();
      var logData = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, numCols).getValues();
      var log = [];
      for (var i = 0; i < logData.length; i++) {
        var row = logData[i];
        var tsVal = row[0];
        if (!tsVal) continue;

        var issueStr = (numCols >= 7 && row[6]) ? row[6].toString() : '';
        var issueDetails = [];
        if (issueStr && issueStr !== 'No issues') {
          issueDetails = issueStr.split('\n').filter(Boolean).map(function(line) {
            var m = line.match(/^\[([^\]]+)\]\s*(.+?)(?:\s+—\s+(.*))?$/);
            return m
              ? {status: m[1], name: m[2].trim(), note: m[3] ? m[3].trim() : ''}
              : {status: 'Issue', name: line, note: ''};
          });
        }

        log.push({
          timestamp:    tsVal instanceof Date ? tsVal.toISOString() : tsVal.toString(),
          location:     row[1] ? row[1].toString() : '',
          bc:           row[2] ? row[2].toString().replace(/^BC-?/i, '') : '',
          checked:      numCols >= 4 ? (row[3] || 0) : 0,
          total:        numCols >= 5 ? (row[4] || 0) : 0,
          issues:       numCols >= 6 ? (row[5] || 0) : issueDetails.length,
          issueDetails: issueDetails
        });
      }
      return ContentService.createTextOutput(JSON.stringify({log: log}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── v75: SUBMIT REPORT ────────────────────────────────────────────────────
    if (action === 'submitReport') {
      var rSheet = ss.getSheetByName('Reports');
      if (!rSheet) {
        rSheet = ss.insertSheet('Reports');
        rSheet.getRange(1,1,1,6).setValues([['Timestamp','Item','Location','Type','Note','Member']]);
        rSheet.getRange(1,1,1,6).setFontWeight('bold').setBackground('#1a3a5c').setFontColor('#ffffff');
      }
      var now2 = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yy h:mm a');
      rSheet.appendRow([now2, body.item||'', body.location||'', body.type||'', body.note||'', body.member||'']);
      SpreadsheetApp.flush();
      return jr({success:true});
    }

    // ADD ITEM (admin)
    if (action === 'addItem') {
      var name     = body.name     || '';
      var location = body.location || 'COBC';
      if (!name) return jr({success:false, error:'Name required'});
      var lastRow = sheet.getLastRow() + 1;
      sheet.getRange(lastRow, 1).setValue('IN');
      sheet.getRange(lastRow, 3).setValue(name);
      sheet.getRange(lastRow, 4).setValue(location);
      sheet.getRange(lastRow, 8).setValue('CC');
      var colKCell = sheet.getRange(lastRow, 11);
      colKCell.setValue('OK');
      var rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(['OK','Missing','Damaged','Need More','Not Active'], true)
        .setAllowInvalid(false).build();
      colKCell.setDataValidation(rule);
      var fUrl = 'https://aryehw330-lgtm.github.io/chaverim-equipment/form.html?name=' + encodeURIComponent(name);
      var qUrl = BASE_URL + '?item=' + encodeURIComponent(name) + '&view=qr';
      sheet.getRange(lastRow, 9).setFormula('=HYPERLINK("' + fUrl + '","Open Form")');
      sheet.getRange(lastRow,10).setFormula('=HYPERLINK("' + qUrl + '","🖨️ Print QR Sticker")');
      SpreadsheetApp.flush();
      return jr({success:true, row:lastRow});
    }

    // UPDATE HOME LOCATION (admin only)
    if (action === 'updateLocation' || action === 'updateHomeLocation') {
      var r = parseInt(body.row);
      if (!r || isNaN(r)) return jr({success:false, error:'Invalid row'});
      sheet.getRange(r, 4).setValue(body.location || '');
      SpreadsheetApp.flush();
      return jr({success:true});
    }

    // ADD MEMBER (admin)
    if (action === 'addMember') {
      var mss    = SpreadsheetApp.openById(MEMBER_SSID);
      var msheet = mss.getSheets()[0];
      var mLast  = msheet.getLastRow() + 1;
      msheet.getRange(mLast, 1).setValue(body.memberId  || '');
      msheet.getRange(mLast, 2).setValue(body.lastName  || '');
      msheet.getRange(mLast, 3).setValue(body.firstName || '');
      msheet.getRange(mLast, 4).setValue(body.phone     || '');
      SpreadsheetApp.flush();
      return jr({success:true});
    }

    if (action === 'updateCNCNote') {
      var rn3 = parseInt(body.row);
      if (!rn3 || isNaN(rn3)) return jr({success:false, error:'Invalid row'});
      sheet.getRange(rn3, 8).setValue(body.cncNote || '');
      if (body.member) sheet.getRange(rn3, 5).setValue(body.member);
      SpreadsheetApp.flush();
      return jr({success:true});
    }

    if (action === 'deleteMember') {
      var mss2   = SpreadsheetApp.openById(MEMBER_SSID);
      var msh2   = mss2.getSheets()[0];
      var mdata  = msh2.getDataRange().getValues();
      for (var di = 1; di < mdata.length; di++) {
        if (String(mdata[di][0]).trim() === String(body.memberId).trim()) {
          msh2.deleteRow(di+1);
          SpreadsheetApp.flush();
          return jr({success:true});
        }
      }
      return jr({success:false, error:'Member not found'});
    }

    if (action === 'updateLocations') {
      var ps = PropertiesService.getScriptProperties();
      ps.setProperty('LOCATIONS', JSON.stringify(body.locations || ['COBC']));
      return jr({success:true});
    }

    if (action === 'getall') return getInventoryJSON();

    // CHECK IN/OUT BY ITEM NAME (from QR scan via form.html)
    if (action === 'checkInByName') {
      var name = body.name || '';
      if (!name) return jr({success:false, error:'No item name'});
      var rows = sheet.getDataRange().getValues();
      var rowNum = -1;
      for (var i = 1; i < rows.length; i++) {
        if (String(rows[i][2]).trim().toLowerCase() === name.trim().toLowerCase()) {
          rowNum = i + 1; break;
        }
      }
      if (rowNum < 0) return jr({success:false, error:'Item not found: ' + name});
      var status  = body.status || 'IN';
      var now     = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yy h:mm a');
      var ccSel   = body.ccSel  || 'CC';
      var cncNote = body.cncNote || '';
      var colH = (ccSel === 'CNC' && cncNote) ? 'CNC - ' + cncNote : ccSel;
      sheet.getRange(rowNum, 1, 1, 2).clearContent();
      sheet.getRange(rowNum, 1).setValue(status === 'IN'  ? 'IN'  : '');
      sheet.getRange(rowNum, 2).setValue(status === 'OUT' ? 'OUT' : '');
      sheet.getRange(rowNum, 5).setValue(body.member || '');
      sheet.getRange(rowNum, 6).setValue(body.call   || '');
      sheet.getRange(rowNum, 7).setValue(now);
      sheet.getRange(rowNum, 8).setValue(colH);
      SpreadsheetApp.flush();
      return jr({success:true});
    }

    // ── v77: CAR SCHEDULE ACTIONS ─────────────────────────────────────────────

    // BOOK CAR SHIFT — creates a new booking row
    if (action === 'bookCarShift') {
      var memberId   = (body.memberId   || '').toString().trim();
      var memberName = (body.memberName || '').toString().trim();
      var date       = (body.date       || '').toString().trim(); // YYYY-MM-DD
      var startTime  = (body.startTime  || '').toString().trim(); // HH:MM
      var endTime    = (body.endTime    || '').toString().trim(); // HH:MM
      var note       = (body.note       || '').toString().trim();
      var needsApproval = body.needsApproval ? true : false;

      if (!memberId || !date || !startTime || !endTime) {
        return jr({success:false, error:'Missing required fields'});
      }

      var carSheet = getOrCreateCarScheduleSheet(ss);
      var carData  = carSheet.getDataRange().getValues();

      // Check for conflicts on the same date (approved or active bookings)
      var newStartMin = timeTo24Min(startTime);
      var newEndMin   = timeTo24Min(endTime);
      var tz0 = Session.getScriptTimeZone();
      for (var ci = 1; ci < carData.length; ci++) {
        var rowStatus = carData[ci][6] ? carData[ci][6].toString() : '';
        if (rowStatus === 'cancelled' || rowStatus === 'done') continue;
        // Normalise stored date to YYYY-MM-DD regardless of Sheets auto-format
        var rowDateVal = carData[ci][3];
        var rowDate = (rowDateVal instanceof Date)
          ? Utilities.formatDate(rowDateVal, tz0, 'yyyy-MM-dd')
          : (rowDateVal ? rowDateVal.toString().trim() : '');
        if (rowDate !== date) continue;
        // Numeric overlap check (string comparison of 12hr times is unreliable)
        var eStartMin = timeTo24Min(formatTimeCol(carData[ci][4]));
        var eEndMin   = timeTo24Min(formatTimeCol(carData[ci][5]));
        if (eStartMin >= 0 && eEndMin > 0 && newStartMin >= 0 && newEndMin > 0) {
          if (newStartMin < eEndMin && newEndMin > eStartMin) {
            return jr({success:false, error:'Time conflict with an existing booking'});
          }
        }
      }

      var newId = 'car_' + Date.now();
      var initialStatus = needsApproval ? 'pending' : 'approved';
      var tz2 = Session.getScriptTimeZone();
      var createdTs = Utilities.formatDate(new Date(), tz2, 'yyyy-MM-dd HH:mm:ss');

      carSheet.appendRow([
        newId,          // A - ID
        memberId,       // B - MemberID
        memberName,     // C - MemberName
        date,           // D - Date
        startTime,      // E - StartTime
        endTime,        // F - EndTime
        initialStatus,  // G - Status
        note,           // H - Notes
        needsApproval,  // I - NeedsApproval
        createdTs       // J - CreatedTimestamp
      ]);
      SpreadsheetApp.flush();
      return jr({success:true, id:newId, status:initialStatus});
    }

    // START CAR SHIFT — member is leaving with the car
    if (action === 'startCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({success:false, error:'No shift ID'});
      var carSheet2 = getOrCreateCarScheduleSheet(ss);
      var carData2  = carSheet2.getDataRange().getValues();
      for (var si2i = 1; si2i < carData2.length; si2i++) {
        if (carData2[si2i][0] && carData2[si2i][0].toString() === shiftId) {
          var curStatus = carData2[si2i][6] ? carData2[si2i][6].toString() : '';
          if (curStatus !== 'approved') {
            return jr({success:false, error:'Shift is not approved (status: ' + curStatus + ')'});
          }
          var signOutTs = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
          carSheet2.getRange(si2i + 1, 7).setValue('active');
          carSheet2.getRange(si2i + 1, 11).setValue(signOutTs); // K = ActualSignOut
          SpreadsheetApp.flush();
          return jr({success:true});
        }
      }
      return jr({success:false, error:'Shift not found'});
    }

    // END CAR SHIFT — member has returned the car
    if (action === 'endCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({success:false, error:'No shift ID'});
      var carSheet3 = getOrCreateCarScheduleSheet(ss);
      var carData3  = carSheet3.getDataRange().getValues();
      for (var ei = 1; ei < carData3.length; ei++) {
        if (carData3[ei][0] && carData3[ei][0].toString() === shiftId) {
          var signInTs = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
          carSheet3.getRange(ei + 1, 7).setValue('done');
          carSheet3.getRange(ei + 1, 12).setValue(signInTs); // L = ActualSignIn
          SpreadsheetApp.flush();
          return jr({success:true});
        }
      }
      return jr({success:false, error:'Shift not found'});
    }

    // CANCEL CAR SHIFT — member cancels their own booking
    if (action === 'cancelCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({success:false, error:'No shift ID'});
      var carSheet4 = getOrCreateCarScheduleSheet(ss);
      var carData4  = carSheet4.getDataRange().getValues();
      for (var cai = 1; cai < carData4.length; cai++) {
        if (carData4[cai][0] && carData4[cai][0].toString() === shiftId) {
          carSheet4.getRange(cai + 1, 7).setValue('cancelled');
          SpreadsheetApp.flush();
          return jr({success:true});
        }
      }
      return jr({success:false, error:'Shift not found'});
    }

    // DELETE CAR SHIFT — admin hard-deletes a booking row from the sheet
    if (action === 'deleteCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({success:false, error:'No shift ID'});
      var carSheetD = getOrCreateCarScheduleSheet(ss);
      var carDataD  = carSheetD.getDataRange().getValues();
      for (var di = 1; di < carDataD.length; di++) {
        if (carDataD[di][0] && carDataD[di][0].toString() === shiftId) {
          carSheetD.deleteRow(di + 1); // +1 because sheet rows are 1-indexed and row 1 is header
          SpreadsheetApp.flush();
          return jr({success:true});
        }
      }
      return jr({success:false, error:'Shift not found'});
    }

    // APPROVE CAR SHIFT — chief/admin approves a pending booking
    if (action === 'approveCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({success:false, error:'No shift ID'});
      var carSheet5 = getOrCreateCarScheduleSheet(ss);
      var carData5  = carSheet5.getDataRange().getValues();
      for (var api = 1; api < carData5.length; api++) {
        if (carData5[api][0] && carData5[api][0].toString() === shiftId) {
          carSheet5.getRange(api + 1, 7).setValue('approved');
          carSheet5.getRange(api + 1, 9).setValue(false); // clear needsApproval flag
          SpreadsheetApp.flush();
          return jr({success:true});
        }
      }
      return jr({success:false, error:'Shift not found'});
    }

    // SET CAR ACCESS — admin toggles a member's car access (col G of member sheet)
    if (action === 'setCarAccess') {
      var targetId  = (body.memberId  || '').toString().trim().replace(/^BC-/i, '');
      var hasAccess = body.hasAccess ? true : false;
      if (!targetId) return jr({success:false, error:'No member ID'});
      var mssCA   = SpreadsheetApp.openById(MEMBER_SSID);
      var mshCA   = mssCA.getSheets()[0];
      var mdataCA = mshCA.getDataRange().getValues();
      for (var mi = 1; mi < mdataCA.length; mi++) {
        var rowId = mdataCA[mi][0] ? mdataCA[mi][0].toString().trim().replace(/^BC-/i,'') : '';
        if (rowId === targetId) {
          mshCA.getRange(mi + 1, 7).setValue(hasAccess); // col G (1-indexed = 7)
          SpreadsheetApp.flush();
          return jr({success:true});
        }
      }
      return jr({success:false, error:'Member not found'});
    }

    return jr({success:false, error:'Unknown action: ' + action});
  } catch(err) {
    return jr({success:false, error:err.toString()});
  }
}

// ── Data endpoints ────────────────────────────────────────────────────────────
function getInventoryJSON() {
  var ss    = SpreadsheetApp.openById(SSID);
  var sheet = ss.getSheetByName(SHEET);
  var data  = sheet.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][2]) continue;
    var colH = data[i][7] ? data[i][7].toString().trim() : '';
    var isCNC = colH.toUpperCase().indexOf('CNC') === 0;
    items.push({
      row:           i + 1,
      name:          data[i][2].toString().trim(),
      homeLocation:  data[i][3] ? data[i][3].toString() : '',
      status:        data[i][1] === 'OUT' ? 'OUT' : (data[i][0] === 'IN' ? 'IN' : ''),
      member:        data[i][4] ? data[i][4].toString() : '',
      call:          data[i][5] ? data[i][5].toString() : '',
      lastUpdated:   data[i][6] ? data[i][6].toString() : '',
      ccnc:          colH,
      isCNC:         isCNC,
      cncNote:       isCNC ? colH.replace(/^CNC\s*[-–]\s*/i, '') : '',
      equipStatus:   data[i][10] ? data[i][10].toString() : 'OK',
      equipNote:     data[i][11] ? data[i][11].toString() : '',
      lastChecked:   data[i][12] ? data[i][12].toString() : ''
    });
  }
  return ContentService.createTextOutput(JSON.stringify({items:items}))
    .setMimeType(ContentService.MimeType.JSON);
}

function getChecklistJSON() {
  var ss    = SpreadsheetApp.openById(SSID);
  var sheet = ss.getSheetByName(SHEET);
  var data  = sheet.getDataRange().getValues();
  var byLoc = {};
  for (var i = 1; i < data.length; i++) {
    if (!data[i][2]) continue;
    var loc  = data[i][3] ? data[i][3].toString().trim() : 'COBC';
    var colH = data[i][7] ? data[i][7].toString().trim() : '';
    var isCNC = colH.toUpperCase().indexOf('CNC') === 0;
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push({
      row:         i + 1,
      name:        data[i][2].toString().trim(),
      status:      data[i][1] === 'OUT' ? 'OUT' : (data[i][0] === 'IN' ? 'IN' : ''),
      equipStatus: data[i][10] ? data[i][10].toString() : 'OK',
      equipNote:   data[i][11] ? data[i][11].toString() : '',
      lastChecked: data[i][12] ? data[i][12].toString() : '',
      ccnc:        colH,
      isCNC:       isCNC,
      cncNote:     isCNC ? colH.replace(/^CNC\s*[-–]\s*/i, '') : '',
      lastUpdated: data[i][6] ? data[i][6].toString() : ''
    });
  }
  return ContentService.createTextOutput(JSON.stringify({byLocation: byLoc}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── v77: getMembersJSON — includes carAccess field ────────────────────────────
function getMembersJSON() {
  try {
    var ss    = SpreadsheetApp.openById(MEMBER_SSID);
    var sheet = ss.getSheets()[0];
    var data  = sheet.getDataRange().getValues();
    var members = [];
    for (var i = 1; i < data.length; i++) {
      var id = data[i][0] ? data[i][0].toString().trim().replace(/^BC-/i,'') : '';
      if (!id) continue;
      var rawAccess = data[i][6];
      var carAccess = rawAccess === true || (rawAccess && rawAccess.toString().toLowerCase() === 'true');
      members.push({
        id:        id,
        unit:      id,
        lastName:  data[i][1] ? data[i][1].toString().trim() : '',
        firstName: data[i][2] ? data[i][2].toString().trim() : '',
        phone:     data[i][3] ? data[i][3].toString().trim() : '',
        pin:       data[i][5] ? data[i][5].toString().trim() : '',
        name:      ((data[i][2]||'') + ' ' + (data[i][1]||'')).trim(),
        carAccess: carAccess
      });
    }
    return ContentService.createTextOutput(JSON.stringify({members:members}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({members:[], error:err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getLocationsJSON() {
  var ps = PropertiesService.getScriptProperties();
  var stored = ps.getProperty('LOCATIONS');
  var locs = stored ? JSON.parse(stored) : ['COBC'];
  return ContentService.createTextOutput(JSON.stringify({locations:locs}))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── v77: getMemberByPinJSON — includes carAccess field ───────────────────────
function getMemberByPinJSON(pin) {
  if (!pin) return jr({id:null, error:'No PIN'});
  try {
    var ss    = SpreadsheetApp.openById(MEMBER_SSID);
    var sheet = ss.getSheets()[0];
    var data  = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var rowPin = data[i][5] ? data[i][5].toString().trim() : '';
      if (rowPin && rowPin === pin.toString().trim()) {
        var rawId = data[i][0] ? data[i][0].toString().trim() : '';
        var id = rawId.replace(/^BC-/i, '');
        var firstName = data[i][2] ? data[i][2].toString().trim() : '';
        var lastName  = data[i][1] ? data[i][1].toString().trim() : '';
        var rawAccess = data[i][6];
        var carAccess = rawAccess === true || (rawAccess && rawAccess.toString().toLowerCase() === 'true');
        return jr({
          id:        id,
          unit:      id,
          name:      (firstName + ' ' + lastName).trim(),
          firstName: firstName,
          lastName:  lastName,
          phone:     data[i][3] ? data[i][3].toString().trim() : '',
          carAccess: carAccess
        });
      }
    }
    return jr({id:null, error:'PIN not found'});
  } catch(err) {
    return jr({id:null, error:err.toString()});
  }
}

// ── v77: getCarScheduleJSON ───────────────────────────────────────────────────
function getCarScheduleJSON() {
  try {
    var ss       = SpreadsheetApp.openById(SSID);
    var carSheet = getOrCreateCarScheduleSheet(ss);
    var lastRow  = carSheet.getLastRow();

    if (lastRow < 2) {
      return ContentService.createTextOutput(JSON.stringify({bookings:[]}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var data     = carSheet.getRange(2, 1, lastRow - 1, 10).getValues();
    var bookings = [];
    var now      = new Date();
    var cutoff   = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    for (var i = 0; i < data.length; i++) {
      var row    = data[i];
      var id     = row[0] ? row[0].toString() : '';
      if (!id) continue;

      var status = row[6] ? row[6].toString() : '';
      // Always return date as YYYY-MM-DD — Sheets may auto-convert to a Date object
      var tz1    = Session.getScriptTimeZone();
      var dateVal = row[3];
      var date = (dateVal instanceof Date)
        ? Utilities.formatDate(dateVal, tz1, 'yyyy-MM-dd')
        : (dateVal ? dateVal.toString().trim() : '');

      // Filter out old cancelled/done bookings (older than 30 days)
      if (status === 'cancelled' || status === 'done') {
        if (date && date < cutoff.toISOString().substring(0, 10)) continue;
      }

      var needsApproval = row[8];
      bookings.push({
        id:            id,
        memberId:      row[1] ? row[1].toString() : '',
        memberName:    row[2] ? row[2].toString() : '',
        date:          date,
        startTime:     formatTimeCol(row[4]),
        endTime:       formatTimeCol(row[5]),
        status:        status,
        note:          row[7] ? row[7].toString() : '',
        needsApproval: needsApproval === true || needsApproval === 'TRUE' || needsApproval === 'true',
        createdAt:     row[9] ? row[9].toString() : '',
        actualSignOut: row[10] ? row[10].toString() : '',
        actualSignIn:  row[11] ? row[11].toString() : ''
      });
    }

    return ContentService.createTextOutput(JSON.stringify({bookings:bookings}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch(err) {
    return ContentService.createTextOutput(JSON.stringify({bookings:[], error:err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── v77: Safely read a time cell — Google Sheets auto-converts "3:30 PM" to a Date ──
// Returns "3:30 PM" style string regardless of whether the cell value is a Date or string
function formatTimeCol(val) {
  if (val === '' || val === null || val === undefined) return '';
  if (val instanceof Date) {
    var h = val.getHours(), mn = val.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12 || 12;
    return h12 + ':' + (mn < 10 ? '0' + mn : '' + mn) + ' ' + ap;
  }
  // Already a string — return as-is
  return val.toString();
}

// ── v77: Convert "H:MM AM/PM" → minutes since midnight (for safe time comparison) ─
function timeTo24Min(t) {
  var str = (t instanceof Date) ? formatTimeCol(t) : (t||'').toString();
  var m = str.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return -1;
  var h = parseInt(m[1]), mn = parseInt(m[2]), ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + mn;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function ep(e, key) {
  return (e.parameter && e.parameter[key]) ? e.parameter[key] : '';
}
function esc(v) {
  return (v||'').toString()
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function jr(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function exportAllQRCodes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Inventory");
  const lastRow = sheet.getLastRow();
  const names = sheet.getRange("C2:C" + lastRow).getValues();
  const links = sheet.getRange("J2:J" + lastRow).getValues();
  const folders = DriveApp.getFoldersByName("COBC Stickers");
  if (!folders.hasNext()) {
    SpreadsheetApp.getUi().alert("Folder 'COBC Stickers' not found.");
    return;
  }
  const folder = folders.next();
  for (let i = 0; i < links.length; i++) {
    let itemName = names[i][0];
    let qrUrl = links[i][0];
    if (qrUrl && qrUrl.toString().includes("http")) {
      try {
        let response = UrlFetchApp.fetch(qrUrl, {followRedirects: true, muteHttpExceptions: true});
        let blob = response.getBlob().setName(itemName + ".png");
        folder.createFile(blob);
      } catch (e) {
        console.log("Skipping " + itemName + " - Error: " + e.toString());
      }
    }
  }
  SpreadsheetApp.getUi().alert("Finished! Check your 'COBC Stickers' folder.");
}

function extractPrintQRLinks() {
  var ss = SpreadsheetApp.openById(SSID);
  var sheet = ss.getSheetByName(SHEET);
  var lastRow = sheet.getLastRow();
  var formulas = sheet.getRange(2, 10, lastRow - 1, 1).getFormulas();
  var output = [];
  for (var i = 0; i < formulas.length; i++) {
    var formula = formulas[i][0];
    if (formula && formula.indexOf("HYPERLINK") !== -1) {
      var match = formula.match(/HYPERLINK\("([^"]+)"/);
      output.push([match ? match[1] : ""]);
    } else {
      output.push([""]);
    }
  }
  sheet.getRange(2, 13, output.length, 1).setValues(output);
  SpreadsheetApp.getUi().alert("✅ Done — QR links copied to Column M");
}

function exportQRsToExistingFolder() {
  var ss = SpreadsheetApp.openById(SSID);
  var sheet = ss.getSheetByName(SHEET);
  var lastRow = sheet.getLastRow();
  var names = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
  var urls  = sheet.getRange(2, 13, lastRow - 1, 1).getValues();
  var folderId = "1ANy4I6vAVnXbVmHa4Bqtdo5iwGeS5j1r";
  var folder = DriveApp.getFolderById(folderId);
  for (var i = 0; i < urls.length; i++) {
    var url = urls[i][0];
    var name = names[i][0];
    if (!url || !name) continue;
    try {
      var qrApi = "https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=" + encodeURIComponent(url);
      var response = UrlFetchApp.fetch(qrApi);
      var blob = response.getBlob().setName(name + ".png");
      folder.createFile(blob);
    } catch (e) {
      Logger.log("Failed: " + name + " - " + e);
    }
  }
  SpreadsheetApp.getUi().alert("✅ Done — QR codes exported to your folder.");
}
