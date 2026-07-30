// COBC Equipment Dashboard - Apps Script v79
// v79: Added revertCarShift action (resets stuck 'active' shift back to 'approved')
// v78: Added setMemberEmail action (writes Gmail to col I of member sheet)
//      getMembersJSON now returns email field
// v77: Added COBC 4 Car Schedule system
//      - CarSchedule sheet (auto-created) tracks all bookings
//      - doGet: getCarSchedule action
//      - doPost: bookCarShift, startCarShift, endCarShift, cancelCarShift, approveCarShift, setCarAccess
//      - getMembersJSON / getMemberByPinJSON: now include carAccess field (col G of member sheet)

// ── Sheet IDs stored in Script Properties (Project Settings → Script Properties)
// Add keys: SSID, MEMBER_SSID  — never hardcode them here so they stay out of GitHub
var _props = PropertiesService.getScriptProperties();
var SSID = _props.getProperty('SSID') || '';
var MEMBER_SSID = _props.getProperty('MEMBER_SSID') || '';
var SHEET = 'Inventory';
var BASE_URL = 'https://script.google.com/macros/s/AKfycbwjnEHbt8v1aVKUO7361uc8XTodz5yBWGKoRgQ3H26UFOJeAQarVQAGaEuYj277Ed14rw/exec';

// ── Admin/ET PIN hashes — stored server-side only, never sent to client ─────────
// These are the SHA-256 hashes of your admin/ET passwords.
// level 3 = Admin, level 2 = Equipment Team, level 1 = ET secondary
var _SERVER_PASSWORDS = {
  'faa3719c835d433bfb62878c18e28062c12146011bc16c332f3b4a2fed5ba2d9': 1,
  '173c5ec3eea7bf07e14395ad73f741882e7637253831740557be9d4863dbda2e': 2,
  '399d4e4b288b5fe2124ff08579e851feb7518cd5ca8eda73594fc1835084c066': 3
};

// ── Equipment status reset passcode (server-side only) ───────────────────────────
var _EQUIP_PASSCODE = _props.getProperty('EQUIP_PASSCODE') || 'cobc2026';

// ── Sheet Column Map (0-indexed) ──────────────────────────────────────────────
// A(0)=IN  B(1)=OUT  C(2)=Item Name  D(3)=Home Location  E(4)=Member#
// F(5)=Call#  G(6)=Last Updated  H(7)=CC/CNC Note  I(8)=Open Form  J(9)=Print QR
// K(10)=Equipment Status  L(11)=Equipment Note  M(12)=Last Checked

// ── Member Sheet Column Map (0-indexed, MEMBER_SSID) ─────────────────────────
// A(0)=BC#  B(1)=LastName  C(2)=FirstName  D(3)=Phone  E(4)=StatusLevel
// F(5)=PIN  G(6)=CarAccess (TRUE/FALSE)  H(7)=unused  I(8)=GoogleEmail

// ── CarSchedule Sheet Column Map (0-indexed) ─────────────────────────────────
// A(0)=ID  B(1)=MemberID  C(2)=MemberName  D(3)=Date(YYYY-MM-DD)
// E(4)=StartTime  F(5)=EndTime  G(6)=Status  H(7)=Notes
// I(8)=NeedsApproval  J(9)=CreatedTimestamp

// ── Sheet Menu ────────────────────────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚙️ COBC Tools')
    .addItem('🖨️ Make QR Codes for New Items', 'addQRLinks')
    .addItem('🛠️ Setup Equipment Status Column', 'setupEquipmentStatusColumn')
    .addItem('🔄 Rebuild Cache Only', 'warmup')
    .addItem('🔧 Fix Col H from Col K', 'fixColH')
    .addItem('📅 Setup CarSchedule Sheet', 'setupCarScheduleSheet')
    .addToUi();
}

// ── Auto-update col H and col L when col K changes in the sheet ───────────────
function onEdit(e) {
  if (!e) return;
  var range = e.range;
  var sheet = range.getSheet();
  if (sheet.getName() !== SHEET) return;
  if (range.getColumn() !== 11) return; // only col K
  var row = range.getRow();
  if (row < 2) return;
  var newVal = (range.getValue() || '').toString().trim();
  if (newVal === 'OK') {
    sheet.getRange(row, 12).setValue(''); // clear col L note
    sheet.getRange(row, 8).setValue('CC'); // reset col H to CC
  }
}

// ── v75: Setup Equipment Status column K ─────────────────────────────────────
function setupEquipmentStatusColumn() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET);
  var last = sheet.getLastRow();

  var hdr = sheet.getRange(1, 11);
  hdr.setValue('Equipment Status');
  hdr.setFontWeight('bold');
  hdr.setBackground('#1a3a5c');
  hdr.setFontColor('#ffffff');

  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['OK', 'Missing', 'Damaged', 'Need More', 'Not Active'], true)
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

// ── Fix col H to match col K for Missing/Damaged rows ──────────────────────
function fixColH() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET);
  var data = sheet.getDataRange().getValues();
  var fixed = 0;
  if (!data[0][11] || data[0][11].toString().trim() === '') {
    sheet.getRange(1, 12).setValue('Equipment Note');
    sheet.getRange(1, 12).setFontWeight('bold').setBackground('#1a3a5c').setFontColor('#ffffff');
  }
  for (var i = 1; i < data.length; i++) {
    var colK = data[i][10] ? data[i][10].toString().trim() : '';
    var colH = data[i][7] ? data[i][7].toString().trim() : '';
    var colL = data[i][11] ? data[i][11].toString().trim() : '';
    if ((colK === 'Missing' || colK === 'Damaged' || colK === 'Need More') && !colL) {
      var prefix = colK.toUpperCase();
      if (colH.toUpperCase().indexOf(prefix) === 0) {
        sheet.getRange(i + 1, 12).setValue(colH);
        sheet.getRange(i + 1, 8).setValue('CC');
        fixed++;
      } else if (colH !== 'CC' && colH !== '') {
        sheet.getRange(i + 1, 12).setValue(prefix);
        fixed++;
      }
    }
  }
  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert('Migrated ' + fixed + ' rows to col L. Col H preserved.');
}

function addQRLinks() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET);
  var data = sheet.getDataRange().getValues();
  var count = 0;
  for (var i = 1; i < data.length; i++) {
    var item = data[i][2];
    if (!item) continue;
    var name = item.toString().trim();
    var isCobc4 = name.toLowerCase().replace(/\s/g, '') === 'cobc4';
    var formUrl = isCobc4
      ? 'https://aryehw330-lgtm.github.io/chaverim-equipment/?page=car'
      : 'https://aryehw330-lgtm.github.io/chaverim-equipment/form.html?name=' + encodeURIComponent(name);
    var qrUrl = BASE_URL + '?item=' + encodeURIComponent(name) + '&view=qr';
    sheet.getRange(i + 1, 9).setFormula('=HYPERLINK("' + formUrl + '","Open Form")');
    sheet.getRange(i + 1, 10).setFormula('=HYPERLINK("' + qrUrl + '","🖨️ Print QR Sticker")');
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
    var headers = ['ID', 'MemberID', 'MemberName', 'Date', 'StartTime', 'EndTime', 'Status', 'Notes', 'NeedsApproval', 'CreatedTimestamp', 'ActualSignOut', 'ActualSignIn', 'BookedBy', 'Vehicle'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#1a3a5c')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(3, 160);
    sheet.setColumnWidth(4, 110);
    sheet.setColumnWidth(7, 100);
    sheet.setColumnWidth(8, 220);
  }
  // Back-fill headers on an already-created sheet (safe to run every time)
  if (sheet.getRange(1, 14).getValue() !== 'Vehicle') {
    if (!sheet.getRange(1, 13).getValue()) sheet.getRange(1, 13).setValue('BookedBy');
    sheet.getRange(1, 14).setValue('Vehicle');
  }
  return sheet;
}

// ── Main doGet ────────────────────────────────────────────────────────────────
function doGet(e) {
  var item = ep(e, 'item');
  var view = ep(e, 'view');
  var action = ep(e, 'action');

  // ── PWA data endpoints ──
  if (!item) {
    if (action === 'getInventory' || action === 'getall') return getInventoryJSON();
    if (action === 'getMembers') { var _tok = ep(e, 'authToken'); if (!_tok || !_verifyFbJwt(_tok)) return ContentService.createTextOutput(JSON.stringify({ error: 'Unauthorized' })).setMimeType(ContentService.MimeType.JSON); return getMembersJSON(); }
    if (action === 'getLocations') return getLocationsJSON();
    if (action === 'getChecklist') return getChecklistJSON();
    if (action === 'getMemberByPin') return getMemberByPinJSON(ep(e, 'pin'));
    if (action === 'getMemberByEmail') return getMemberByEmailJSON(ep(e, 'email'));
    if (action === 'getRecentInventoryEvents') return getRecentInventoryEventsJSON();
    if (action === 'getCarSchedule') return getCarScheduleJSON();
    if (action === 'checkMemberEmail') return checkMemberEmailJSON(ep(e, 'email'));
    if (action === 'getInventoryHistory') return getInventoryHistoryJSON(ep(e, 'from'), ep(e, 'to'));
    return HtmlService.createHtmlOutput('<h2 style="font-family:Arial;padding:2rem">COBC Equipment API v79</h2>');
  }

  // ── Check-in/out pixel (from QR scan form) ──
  var chkAction = ep(e, 'action');
  if (chkAction === 'in' || chkAction === 'out') {
    try {
      var ss = SpreadsheetApp.openById(SSID);
      var sheet = ss.getSheetByName(SHEET);
      var data = sheet.getDataRange().getValues();
      var row = -1;
      for (var i = 1; i < data.length; i++) {
        if (data[i][2] && data[i][2].toString().trim().toLowerCase() === item.trim().toLowerCase()) {
          row = i + 1; break;
        }
      }
      if (row > 0) {
        var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yy h:mm a');
        var member = ep(e, 'member');
        var call = ep(e, 'phone');
        var ccnc = ep(e, 'ccnc');
        sheet.getRange(row, 1, 1, 2).clearContent();
        sheet.getRange(row, 1).setValue(chkAction === 'in' ? 'IN' : '');
        sheet.getRange(row, 2).setValue(chkAction === 'out' ? 'OUT' : '');
        sheet.getRange(row, 5).setValue(member);
        sheet.getRange(row, 6).setValue(call);
        sheet.getRange(row, 7).setValue(now);
        sheet.getRange(row, 8).setValue(ccnc);
        SpreadsheetApp.flush();
      }
    } catch (err) { }
    return HtmlService.createHtmlOutput('OK');
  }

  // ── QR page (printable sticker) ──
  if (view === 'qr') {
    var si = esc(item);
    var isCobc4Print = item.toString().toLowerCase().replace(/\s/g, '') === 'cobc4';
    var fUrl = isCobc4Print
      ? 'https://aryehw330-lgtm.github.io/chaverim-equipment/?page=car'
      : 'https://aryehw330-lgtm.github.io/chaverim-equipment/form.html?name=' + encodeURIComponent(item);
    var qrSrc = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(fUrl);
    var loc2 = '';
    try {
      var ss3 = SpreadsheetApp.openById(SSID);
      var sh3 = ss3.getSheetByName(SHEET);
      var d3 = sh3.getDataRange().getValues();
      for (var k = 1; k < d3.length; k++) {
        if (d3[k][2] && d3[k][2].toString().trim() === item.toString().trim()) {
          loc2 = d3[k][3] ? d3[k][3].toString() : ''; break;
        }
      }
    } catch (e3) { }
    var logoB64 = '';
    try {
      var logoResp = UrlFetchApp.fetch('https://raw.githubusercontent.com/aryehw330-lgtm/chaverim-equipment/main/logo.jpg');
      logoB64 = 'data:image/jpeg;base64,' + Utilities.base64Encode(logoResp.getContent());
    } catch (el) { }
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
    var ss2 = SpreadsheetApp.openById(SSID);
    var sheet2 = ss2.getSheetByName(SHEET);
    var data2 = sheet2.getDataRange().getValues();
    for (var j = 1; j < data2.length; j++) {
      if (data2[j][2] && data2[j][2].toString().trim().toLowerCase() === item.trim().toLowerCase()) {
        loc = data2[j][3] ? data2[j][3].toString() : '';
        status = data2[j][1] === 'OUT' ? 'OUT' : 'IN';
        break;
      }
    }
  } catch (e2) { }

  var isIn = (status === 'IN');
  var bgBadge = isIn ? '#EAF3DE' : '#fdecea';
  var colBadge = isIn ? '#2d6a4f' : '#c0392b';
  var label = isIn ? 'Currently IN' : 'Currently OUT';
  var si2 = esc(item);
  var sl = esc(loc);

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
    + '<div style="font-size:48px;margin-bottom:12px">🔑</div>'
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
    + 'function go(dir){'
    + '  var mb=document.getElementById("mb").value.trim();'
    + '  var ph=document.getElementById("ph").value.trim();'
    + '  var cc=document.getElementById("ccSel").value;'
    + '  var cn=document.getElementById("cncNote").value.trim();'
    + '  if(!mb||!ph||!cc){alert("Please fill in all fields.");return;}'
    + '  var colH=(cc==="CNC"&&cn)?"CNC - "+cn:cc;'
    + '  fetch(U+"?action="+dir+"&item="+encodeURIComponent(IT)+"&member="+encodeURIComponent(mb)+"&phone="+encodeURIComponent(ph)+"&ccnc="+encodeURIComponent(colH),{redirect:"follow"})'
    + '  .then(function(){var oc=document.getElementById("oc");oc.style.background=dir==="in"?"#2d6a4f":"#c0392b";oc.textContent=dir==="in"?"✓":"↑";document.getElementById("ol").textContent=IT+(dir==="in"?" — IN":" — OUT");document.getElementById("ocd").textContent="Member "+mb+" · Call "+ph;document.getElementById("badge").style.background=dir==="in"?"#EAF3DE":"#fdecea";document.getElementById("badge").style.color=dir==="in"?"#2d6a4f":"#c0392b";document.getElementById("badge").textContent=dir==="in"?"Currently IN":"Currently OUT";document.getElementById("ov").classList.add("on");})'
    + '  .catch(function(){alert("Network error — try again.");});'
    + '}'
    + 'function doneFn(){if(iv)clearInterval(iv);document.getElementById("ov").classList.remove("on");document.getElementById("mb").value="";document.getElementById("ph").value="";document.getElementById("ccSel").value="";document.getElementById("cncNote").value="";document.getElementById("cncRow").className="cncRow";}'
    + '<\/script></body></html>';

  return HtmlService.createHtmlOutput(h2).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── doPost ────────────────────────────────────────────────────────────────────
function doPost(e) {

  // —— Telzio webhook (detect: has caller fields but no 'action') ——
  var _telzioBody = (e.postData && e.postData.contents && e.postData.contents.charAt(0) === '{')
    ? JSON.parse(e.postData.contents) : (e.parameter || {});
  if (!_telzioBody.action && (_telzioBody.From || _telzioBody.from || _telzioBody.CallUUID)) {
    return handleTelzioWebhook(_telzioBody);
  }
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action || '';
    if (!_verifyFbJwt(body.authToken)) {
      return jr({ success: false, error: 'Unauthorized \u2014 please sign in again.' });
    }
    var ss = SpreadsheetApp.openById(SSID);
    var sheet = ss.getSheetByName(SHEET);

    // CHECK IN / OUT from GitHub PWA
    if (action === 'checkInOut') {
      var rowNum = parseInt(body.row);
      if (!rowNum || isNaN(rowNum)) {
        var rows = sheet.getDataRange().getValues();
        for (var i = 1; i < rows.length; i++) {
          if (String(rows[i][2]).trim().toLowerCase() === String(body.row).trim().toLowerCase()) { rowNum = i + 1; break; }
        }
      }
      if (!rowNum) return jr({ success: false, error: 'Item not found' });
      var status = body.status || 'IN';
      var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yy h:mm a');
      var ccSel = body.ccSel || 'CC';
      var cncNote = body.cncNote || '';
      var colH = (ccSel === 'CNC' && cncNote) ? 'CNC - ' + cncNote : ccSel;
      var memberVal = body.member || '';
      if (body.loggedBy) memberVal = memberVal + ' (by BC-' + body.loggedBy + ')';
      sheet.getRange(rowNum, 1, 1, 2).clearContent();
      sheet.getRange(rowNum, 1).setValue(status === 'IN' ? 'IN' : '');
      sheet.getRange(rowNum, 2).setValue(status === 'OUT' ? 'OUT' : '');
      sheet.getRange(rowNum, 5).setValue(memberVal);
      sheet.getRange(rowNum, 6).setValue(body.call || '');
      sheet.getRange(rowNum, 7).setValue(now);
      sheet.getRange(rowNum, 8).setValue(colH);
      SpreadsheetApp.flush();

      // Sync to Firestore immediately — don't wait for the on-edit trigger
      try {
        var fsItemName = sheet.getRange(rowNum, 3).getValue();
        if (fsItemName) {
          var fsToken = ScriptApp.getOAuthToken();
          var fsMask = 'updateMask.fieldPaths=status&updateMask.fieldPaths=memberNum&updateMask.fieldPaths=callNum&updateMask.fieldPaths=ccCnc&updateMask.fieldPaths=lastUpdated';
          var fsUrl = 'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/equipment/' + encodeURIComponent(fsItemName) + '?' + fsMask;
          UrlFetchApp.fetch(fsUrl, {
            method: 'patch', contentType: 'application/json',
            payload: JSON.stringify({
              fields: {
                'status': { stringValue: status },
                'memberNum': { stringValue: body.member || '' },
                'callNum': { stringValue: body.call || '' },
                'ccCnc': { stringValue: colH },
                'lastUpdated': { stringValue: now }
              }
            }),
            headers: { 'Authorization': 'Bearer ' + fsToken },
            muteHttpExceptions: true
          });
        }
      } catch (e) { Logger.log('Firestore checkInOut sync error: ' + e); }

      // ── Write history event to Firestore equipmentHistory ──────────────────────
      try {
        var histItemName = sheet.getRange(rowNum, 3).getValue();
        var histUrl = 'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/equipmentHistory?key=AIzaSyBYAz3ohsJGX_zo-Yq3faZ2m0uv4tfuSl8';
        var histResp = UrlFetchApp.fetch(histUrl, {
          method: 'post', contentType: 'application/json',
          payload: JSON.stringify({
            fields: {
              item:    { stringValue: String(histItemName || '') },
              action:  { stringValue: String(status || '') },
              byUnit:  { stringValue: String(body.member || '') },
              callNum: { stringValue: String(body.call || '') },
              status:  { stringValue: String(colH || '') },
              at:      { integerValue: String(Date.now()) }
            }
          }),
          muteHttpExceptions: true
        });
        Logger.log('equipmentHistory write: ' + histResp.getResponseCode());
      } catch (eHist) { Logger.log('equipmentHistory write error: ' + eHist); }

      
      // Log to InventoryEvents for recent-events feed
      try {
        var evS = getOrCreateSheet(ss, 'InventoryEvents');
        if (evS.getLastRow() < 1) evS.appendRow(['Timestamp', 'Action', 'Items', 'Member', 'LoggedBy', 'Call', 'CCNC']);
        var evItemName = sheet.getRange(rowNum, 3).getValue();
        evS.appendRow([new Date(), status, evItemName || '', body.member || '', body.loggedBy || '', body.call || '', body.ccnc || '']);
      } catch (eLg) { Logger.log('InventoryEvents log error: ' + eLg); }

      return jr({ success: true });
    }

    // ── LOG INVENTORY EVENT (for dispatch/admin push notifications) ──────────────
    if (action === 'logInventoryEvent') {
      try {
        var evSheet = getOrCreateSheet(ss, 'InventoryEvents');
        if (evSheet.getLastRow() < 1) {
          evSheet.appendRow(['Timestamp', 'Action', 'Items', 'Member', 'LoggedBy', 'Call', 'CCNC']);
        }
        var tz3 = Session.getScriptTimeZone();
        var evTs = Utilities.formatDate(new Date(), tz3, 'yyyy-MM-dd HH:mm:ss');
        evSheet.appendRow([
          evTs,
          body.action2 || '',
          body.items || '',
          body.member || '',
          body.loggedBy || '',
          body.call || '',
          body.ccnc || ''
        ]);
        try { _pushEquipEventGrouped(body.items, body.action2, body.member, body.call); } catch (ePush) { Logger.log('_pushEquipEventGrouped error: ' + ePush); }
        try {
          var lastRow = evSheet.getLastRow();
          if (lastRow > 5001) evSheet.deleteRows(2, lastRow - 5001);
          SpreadsheetApp.flush();
          return jr({ success: true });
        } catch (e2) {
          return jr({ success: false, error: e2.toString() });
        }
      } catch (e3) {
        return jr({ success: false, error: e3.toString() });
      }
    }

    // ── v75: UPDATE EQUIPMENT STATUS (col K) ──────────────────────────────────
    if (action === 'updateEquipmentStatus') {
      var rowNum2 = parseInt(body.row);
      if (!rowNum2 || isNaN(rowNum2)) return jr({ success: false, error: 'Invalid row' });
      // Validate passcode server-side for status resets
      if (body.passcode && body.passcode !== _EQUIP_PASSCODE) {
        return jr({ success: false, error: 'Incorrect passcode' });
      }
      var validStatuses = ['OK', 'Missing', 'Damaged', 'Need More', 'Not Active'];
      var newStatus = body.status || 'OK';
      if (validStatuses.indexOf(newStatus) === -1) return jr({ success: false, error: 'Invalid status' });
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

      // ── FIX: Sync to Firestore immediately — don't wait for the onEdit trigger.
      // Every other status-changing action (checkInOut, addMember, deleteMember)
      // already pushes its change straight to Firestore. This action never did,
      // so column K updates only ever reached the Sheet, never the live app —
      // that's the "Column K not updating" bug. Writing all three plausible
      // field names defensively (equipStatus / statusDetails / notActive) since
      // syncEquipmentToFirestore() already (confusingly) writes col K's value
      // under 'notActive'.
      try {
        var noteVal2 = sheet.getRange(rowNum2, 12).getValue();
        var fsToken2 = ScriptApp.getOAuthToken();
        var fsMask2 = 'updateMask.fieldPaths=equipStatus&updateMask.fieldPaths=statusDetails&updateMask.fieldPaths=notActive';
        var fsUrl2 = 'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/equipment/' + rowNum2 + '?' + fsMask2;
        UrlFetchApp.fetch(fsUrl2, {
          method: 'patch',
          contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + fsToken2 },
          payload: JSON.stringify({
            fields: {
              equipStatus:   { stringValue: newStatus },
              statusDetails: { stringValue: noteVal2 ? noteVal2.toString() : '' },
              notActive:     { stringValue: newStatus }
            }
          }),
          muteHttpExceptions: true
        });
      } catch (eFsK) { Logger.log('Firestore updateEquipmentStatus sync error: ' + eFsK); }

      return jr({ success: true });
    }

    // ── v76: SUBMIT CHECKLIST ─────────────────────────────────────────────────
    if (action === 'submitChecklist') {
      var rows = body.rows;
      var bcNum = body.bc ? body.bc.toString().replace(/^BC-?/i, '').trim() : '?';
      if (!rows || !rows.length) return jr({ success: false, error: 'No rows provided' });

      var tz = Session.getScriptTimeZone();
      var chkTime = Utilities.formatDate(new Date(), tz, 'MMM d, yyyy · h:mm a');
      var logVal = 'BC-' + bcNum + ' · ' + chkTime;

      rows.forEach(function (r) {
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
        logSheet.getRange(1, 1, 1, 7).setValues([['Timestamp', 'Location', 'Submitted By', 'Checked', 'Total', 'Issues', 'Issue Details']]);
        logSheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#1a3a5c').setFontColor('#ffffff');
        logSheet.setFrozenRows(1);
        logSheet.setColumnWidth(7, 320);
      }

      var issueDetails = body.issueDetails || [];
      var detailStr = issueDetails.length > 0
        ? issueDetails.map(function (d) {
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
        body.checked != null ? body.checked : rows.length,
        body.total != null ? body.total : rows.length,
        body.issueCount != null ? body.issueCount : issueDetails.length,
        detailStr
      ]);

      var newRow = logSheet.getLastRow();
      logSheet.getRange(newRow, 1).setNumberFormat('M/d/yyyy h:mm am/pm');
      logSheet.getRange(newRow, 7).setWrap(true);

      // ── Write history event to Firestore checklistHistory ────────────────────
      try {
        writeChecklistEvent(
          location,
          bcNum,
          body.checked != null ? body.checked : rows.length,
          body.issueCount != null ? body.issueCount : issueDetails.length
        );
      } catch (eChk) { Logger.log('checklistHistory write error: ' + eChk); }

      return jr({ success: true, log: logVal });
    }

    // ── v76: GET CHECKLIST LOG ────────────────────────────────────────────────
    if (action === 'getChecklistLog') {
      var logSheet = ss.getSheetByName('ChecklistLog');
      if (!logSheet || logSheet.getLastRow() < 2) {
        return ContentService.createTextOutput(JSON.stringify({ log: [] }))
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
          issueDetails = issueStr.split('\n').filter(Boolean).map(function (line) {
            var m = line.match(/^\[([^\]]+)\]\s*(.+?)(?:\s+—\s+(.*))?$/);
            return m
              ? { status: m[1], name: m[2].trim(), note: m[3] ? m[3].trim() : '' }
              : { status: 'Issue', name: line, note: '' };
          });
        }

        log.push({
          timestamp: tsVal instanceof Date ? tsVal.toISOString() : tsVal.toString(),
          location: row[1] ? row[1].toString() : '',
          bc: row[2] ? row[2].toString().replace(/^BC-?/i, '') : '',
          checked: numCols >= 4 ? (row[3] || 0) : 0,
          total: numCols >= 5 ? (row[4] || 0) : 0,
          issues: numCols >= 6 ? (row[5] || 0) : issueDetails.length,
          issueDetails: issueDetails
        });
      }
      return ContentService.createTextOutput(JSON.stringify({ log: log }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // ── v75: SUBMIT REPORT ────────────────────────────────────────────────────
    if (action === 'submitReport') {
      var rSheet = ss.getSheetByName('Reports');
      if (!rSheet) {
        rSheet = ss.insertSheet('Reports');
        rSheet.getRange(1, 1, 1, 6).setValues([['Timestamp', 'Item', 'Location', 'Type', 'Note', 'Member']]);
        rSheet.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#1a3a5c').setFontColor('#ffffff');
      }
      var now2 = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yy h:mm a');
      rSheet.appendRow([now2, body.item || '', body.location || '', body.type || '', body.note || '', body.member || '']);
      SpreadsheetApp.flush();
      // ── Write history event to Firestore reportHistory ────────────────────────
      try {
        writeReportEvent(body.type || '', body.item || '', body.member || '');
      } catch (eRep) { Logger.log('reportHistory write error: ' + eRep); }
      return jr({ success: true });
    }

    // ADD ITEM (admin)
    if (action === 'addItem') {
      var name = body.name || '';
      var location = body.location || 'COBC';
      if (!name) return jr({ success: false, error: 'Name required' });
      var lastRow = sheet.getLastRow() + 1;
      sheet.getRange(lastRow, 1).setValue('IN');
      sheet.getRange(lastRow, 3).setValue(name);
      sheet.getRange(lastRow, 4).setValue(location);
      sheet.getRange(lastRow, 8).setValue('CC');
      var colKCell = sheet.getRange(lastRow, 11);
      colKCell.setValue('OK');
      var rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(['OK', 'Missing', 'Damaged', 'Need More', 'Not Active'], true)
        .setAllowInvalid(false).build();
      colKCell.setDataValidation(rule);
      var isCobc4New = name.toLowerCase().replace(/\s/g, '') === 'cobc4';
      var fUrl = isCobc4New
        ? 'https://aryehw330-lgtm.github.io/chaverim-equipment/?page=car'
        : 'https://aryehw330-lgtm.github.io/chaverim-equipment/form.html?name=' + encodeURIComponent(name);
      var qUrl = BASE_URL + '?item=' + encodeURIComponent(name) + '&view=qr';
      sheet.getRange(lastRow, 9).setFormula('=HYPERLINK("' + fUrl + '","Open Form")');
      sheet.getRange(lastRow, 10).setFormula('=HYPERLINK("' + qUrl + '","🖨️ Print QR Sticker")');
      SpreadsheetApp.flush();
      return jr({ success: true, row: lastRow });
    }

    // UPDATE HOME LOCATION (admin only)
    if (action === 'updateLocation' || action === 'updateHomeLocation') {
      var r = parseInt(body.row);
      if (!r || isNaN(r)) return jr({ success: false, error: 'Invalid row' });
      sheet.getRange(r, 4).setValue(body.location || '');
      SpreadsheetApp.flush();
      return jr({ success: true });
    }

    // ADD MEMBER (admin)
    if (action === 'addMember') {
      var mss = SpreadsheetApp.openById(MEMBER_SSID);
      var msheet = mss.getSheetByName('Chaverim Member info');
      var mLast = msheet.getLastRow() + 1;
      var mId = body.memberId || '';
      var mFirst = body.firstName || '';
      var mLast2 = body.lastName || '';
      var mPhone = body.phone || '';
      var mRole = body.role || 'Member';
      var mPin = body.pin || '1234';
      msheet.getRange(mLast, 1).setValue(mId);
      msheet.getRange(mLast, 2).setValue(mLast2);
      msheet.getRange(mLast, 3).setValue(mFirst);
      msheet.getRange(mLast, 4).setValue(mPhone);
      msheet.getRange(mLast, 5).setValue(mRole);
      msheet.getRange(mLast, 6).setValue(mPin);
      SpreadsheetApp.flush();
      // Also write to Firestore immediately (on-edit trigger won't fire for script edits)
      try {
        var fsToken = ScriptApp.getOAuthToken();
        var fsDocId = mId;
        var fsFields = {
          unit: { stringValue: mId },
          firstName: { stringValue: mFirst },
          lastName: { stringValue: mLast2 },
          name: { stringValue: (mFirst + ' ' + mLast2).trim() },
          phone: { stringValue: mPhone },
          role: { stringValue: mRole.toLowerCase() },
        };
        UrlFetchApp.fetch(
          'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/members/' + encodeURIComponent(fsDocId),
          {
            method: 'PATCH', contentType: 'application/json',
            headers: { Authorization: 'Bearer ' + fsToken },
            payload: JSON.stringify({ fields: fsFields }),
            muteHttpExceptions: true
          }
        );
      } catch (fse) { Logger.log('Firestore addMember sync error: ' + fse); }
      return jr({ success: true });
    }

    if (action === 'updateMember') {
      var targetId = (body.memberId || '').toString().trim().replace(/^BC-?0*/i, '');
      if (!targetId) return jr({ success: false, error: 'No member ID' });
      var mssU = SpreadsheetApp.openById(MEMBER_SSID);
      var mshU = mssU.getSheetByName('Chaverim Member info');
      var mdataU = mshU.getDataRange().getValues();
      for (var ui = 1; ui < mdataU.length; ui++) {
        var rowIdU = mdataU[ui][0] ? mdataU[ui][0].toString().trim().replace(/^BC-?0*/i, '') : '';
        if (rowIdU === targetId) {
          if (body.lastName !== undefined) mshU.getRange(ui + 1, 2).setValue(body.lastName);
          if (body.firstName !== undefined) mshU.getRange(ui + 1, 3).setValue(body.firstName);
          if (body.phone !== undefined) mshU.getRange(ui + 1, 4).setValue(body.phone);
          if (body.role !== undefined) mshU.getRange(ui + 1, 5).setValue(body.role);
          if (body.pin !== undefined) mshU.getRange(ui + 1, 6).setValue(body.pin);
          SpreadsheetApp.flush();
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Member not found' });
    }

    if (action === 'updateCNCNote') {
      var rn3 = parseInt(body.row);
      if (!rn3 || isNaN(rn3)) return jr({ success: false, error: 'Invalid row' });
      sheet.getRange(rn3, 8).setValue(body.cncNote || '');
      if (body.member) sheet.getRange(rn3, 5).setValue(body.member);
      SpreadsheetApp.flush();
      return jr({ success: true });
    }

    if (action === 'deleteMember') {
      try {
        var memberId = ((body.memberId || body.unit || '') + '').trim();
        if (!memberId) return jr({ success: false, error: 'No memberId' });
        Logger.log('deleteMember: ' + memberId);

        // 1. Delete from Firestore (try multiple ID formats)
        var normNum = memberId.replace(/^BC-?0*/i, '').trim();
        var padded = normNum.length === 1 ? '0' + normNum : normNum;
        var fsIds = [memberId, 'BC-' + normNum, 'BC-' + padded];
        fsIds = fsIds.filter(function (v, i, a) { return a.indexOf(v) === i && v; });
        var fsToken = ScriptApp.getOAuthToken();
        for (var fi = 0; fi < fsIds.length; fi++) {
          UrlFetchApp.fetch(
            'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/members/' + encodeURIComponent(fsIds[fi]),
            { method: 'DELETE', headers: { Authorization: 'Bearer ' + fsToken }, muteHttpExceptions: true }
          );
        }

        // 2. Delete from Google Sheet using TextFinder (reliable, no string-normalisation needed)
        var ss = SpreadsheetApp.openById(MEMBER_SSID);
        var msh = ss.getSheetByName('Chaverim Member info');
        if (!msh) { Logger.log('Sheet not found'); return jr({ success: true }); }

        // Search column A for the member ID (case-insensitive, exact cell match)
        var colA = msh.getRange(1, 1, msh.getLastRow(), 1);
        var finder = colA.createTextFinder(memberId).matchCase(false).matchEntireCell(true);
        var found = finder.findNext();

        // If exact match fails, also try without the "BC-" prefix (bare number)
        if (!found) {
          var finder2 = colA.createTextFinder(normNum).matchCase(false);
          found = finder2.findNext();
        }

        if (found) {
          var rowNum = found.getRow();
          msh.deleteRow(rowNum);
          Logger.log('Deleted sheet row ' + rowNum + ' for ' + memberId);
        } else {
          Logger.log('Sheet row not found for: ' + memberId);
          // Dump col A rows 2-11 for diagnosis
          var dump = msh.getRange(2, 1, Math.min(10, msh.getLastRow() - 1), 1).getValues();
          for (var di = 0; di < dump.length; di++) Logger.log('  colA[' + (di + 2) + ']: ' + dump[di][0]);
        }
        return jr({ success: true });
      } catch (e2) {
        Logger.log('deleteMember error: ' + e2.message);
        return jr({ success: false, error: e2.message });
      }
    }
    if (action === 'updateLocations') {
      var ps = PropertiesService.getScriptProperties();
      ps.setProperty('LOCATIONS', JSON.stringify(body.locations || ['COBC']));
      return jr({ success: true });
    }

    if (action === 'getall') return getInventoryJSON();

    // CHECK IN/OUT BY ITEM NAME (from QR scan via form.html)
    if (action === 'checkInByName') {
      var name = body.name || '';
      if (!name) return jr({ success: false, error: 'No item name' });
      var rows = sheet.getDataRange().getValues();
      var rowNum = -1;
      for (var i = 1; i < rows.length; i++) {
        if (String(rows[i][2]).trim().toLowerCase() === name.trim().toLowerCase()) {
          rowNum = i + 1; break;
        }
      }
      if (rowNum < 0) return jr({ success: false, error: 'Item not found: ' + name });
      var status = body.status || 'IN';
      var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yy h:mm a');
      var ccSel = body.ccSel || 'CC';
      var cncNote = body.cncNote || '';
      var colH = (ccSel === 'CNC' && cncNote) ? 'CNC - ' + cncNote : ccSel;
      var memberVal2 = body.member || '';
      if (body.loggedBy) memberVal2 = memberVal2 + ' (by BC-' + body.loggedBy + ')';
      sheet.getRange(rowNum, 1, 1, 2).clearContent();
      sheet.getRange(rowNum, 1).setValue(status === 'IN' ? 'IN' : '');
      sheet.getRange(rowNum, 2).setValue(status === 'OUT' ? 'OUT' : '');
      sheet.getRange(rowNum, 5).setValue(memberVal2);
      sheet.getRange(rowNum, 6).setValue(body.call || '');
      sheet.getRange(rowNum, 7).setValue(now);
      sheet.getRange(rowNum, 8).setValue(colH);
      SpreadsheetApp.flush();

      // ── Write history event to Firestore equipmentHistory (drives dispatch push) ──
      try {
        var histUrl = 'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/equipmentHistory?key=AIzaSyBYAz3ohsJGX_zo-Yq3faZ2m0uv4tfuSl8';
        UrlFetchApp.fetch(histUrl, {
          method: 'post', contentType: 'application/json',
          payload: JSON.stringify({
            fields: {
              item:    { stringValue: String(name || '') },
              action:  { stringValue: String(status || '') },
              byUnit:  { stringValue: String(body.member || '') },
              callNum: { stringValue: String(body.call || '') },
              status:  { stringValue: String(colH || '') },
              at:      { integerValue: String(Date.now()) }
            }
          }),
          muteHttpExceptions: true
        });
      } catch (eHist) { Logger.log('checkInByName equipmentHistory error: ' + eHist); }

      try { _pushEquipEvent(name, status, body.member, body.call, colH); } catch(e){}

      return jr({ success: true });
    }

    // ── v77: CAR SCHEDULE ACTIONS ─────────────────────────────────────────────

    // BOOK CAR SHIFT — creates a new booking row
    if (action === 'bookCarShift') {
      var memberId = (body.memberId || '').toString().trim();
      var memberName = (body.memberName || '').toString().trim();
      var date = (body.date || '').toString().trim(); // YYYY-MM-DD
      var startTime = (body.startTime || '').toString().trim(); // HH:MM
      var endTime = (body.endTime || '').toString().trim(); // HH:MM
      var note = (body.note || '').toString().trim();
      var bookedBy = (body.bookedBy || '').toString().trim();
      var vehicle = (body.vehicle || 'COBC 4').toString().trim();
      var needsApproval = body.needsApproval ? true : false;
      if (!memberId || !date || !startTime || !endTime) {
        return jr({ success: false, error: 'Missing required fields' });
      }
      var carSheet = getOrCreateCarScheduleSheet(ss);
      var carData = carSheet.getDataRange().getValues();
      var newStartMin = timeTo24Min(startTime);
      var newEndMin = timeTo24Min(endTime);
      if (newEndMin <= newStartMin) newEndMin += 1440;
      var tz0 = Session.getScriptTimeZone();
      for (var ci = 1; ci < carData.length; ci++) {
        var rowStatus = carData[ci][6] ? carData[ci][6].toString() : '';
        if (rowStatus === 'cancelled' || rowStatus === 'done') continue;
        // Per-vehicle conflict only — two DIFFERENT vehicles may overlap in time.
        var rowVehicle = carData[ci][13] ? carData[ci][13].toString().trim() : 'COBC 4';
        if (rowVehicle !== vehicle) continue;
        var rowDateVal = carData[ci][3];
        var rowDate = (rowDateVal instanceof Date)
          ? Utilities.formatDate(rowDateVal, tz0, 'yyyy-MM-dd')
          : (rowDateVal ? rowDateVal.toString().trim() : '');
        if (rowDate !== date) continue;
        var eStartMin = timeTo24Min(formatTimeCol(carData[ci][4]));
        var eEndMin = timeTo24Min(formatTimeCol(carData[ci][5]));
        if (eEndMin <= eStartMin) eEndMin += 1440;
        if (eStartMin >= 0 && eEndMin > 0 && newStartMin >= 0 && newEndMin > 0) {
          if (newStartMin < eEndMin && newEndMin > eStartMin) {
            return jr({ success: false, error: 'Time conflict with an existing booking for ' + vehicle });
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
        createdTs,      // J - CreatedTimestamp
        '',             // K - ActualSignOut
        '',             // L - ActualSignIn
        bookedBy,       // M - BookedBy
        vehicle         // N - Vehicle
      ]);
      SpreadsheetApp.flush();
      return jr({ success: true, id: newId, status: initialStatus });
    }

    // START CAR SHIFT — member is leaving with the car
    if (action === 'startCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({ success: false, error: 'No shift ID' });
      var carSheet2 = getOrCreateCarScheduleSheet(ss);
      var carData2 = carSheet2.getDataRange().getValues();
      for (var si2i = 1; si2i < carData2.length; si2i++) {
        if (carData2[si2i][0] && carData2[si2i][0].toString() === shiftId) {
          var curStatus = carData2[si2i][6] ? carData2[si2i][6].toString() : '';
          if (curStatus !== 'approved') {
            return jr({ success: false, error: 'Shift is not approved (status: ' + curStatus + ')' });
          }
          var signOutTs = new Date().toISOString();
          carSheet2.getRange(si2i + 1, 7).setValue('active');
          carSheet2.getRange(si2i + 1, 11).setValue(signOutTs); // K = ActualSignOut
          SpreadsheetApp.flush();
          // ── Write history event to Firestore cobc4History ──────────────────────
          try {
            UrlFetchApp.fetch('https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/cobc4History', {
              method: 'post', contentType: 'application/json',
              payload: JSON.stringify({
                fields: {
                  driver: { stringValue: String(body.member || '') },
                  action: { stringValue: 'OUT' },
                  callNum: { stringValue: String(body.call || '') },
                  vehicle: { stringValue: String(body.vehicle || 'COBC 4') },
                  at: { integerValue: String(Date.now()) }
                }
              })
            });
          } catch (eCar) { Logger.log('cobc4History write error: ' + eCar); }
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Shift not found' });
    }

    // END CAR SHIFT — member has returned the car
    if (action === 'endCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({ success: false, error: 'No shift ID' });
      var carSheet3 = getOrCreateCarScheduleSheet(ss);
      var carData3 = carSheet3.getDataRange().getValues();
      for (var ei = 1; ei < carData3.length; ei++) {
        if (carData3[ei][0] && carData3[ei][0].toString() === shiftId) {
          var signInTs = new Date().toISOString();
          carSheet3.getRange(ei + 1, 7).setValue('done');
          carSheet3.getRange(ei + 1, 12).setValue(signInTs); // L = ActualSignIn
          SpreadsheetApp.flush();
          // ── Write history event to Firestore cobc4History ──────────────────────
          try {
            UrlFetchApp.fetch('https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/cobc4History', {
              method: 'post', contentType: 'application/json',
              payload: JSON.stringify({
                fields: {
                  driver: { stringValue: String(body.member || '') },
                  action: { stringValue: 'IN' },
                  callNum: { stringValue: String(body.call || '') },
                  vehicle: { stringValue: String(body.vehicle || 'COBC 4') },
                  at: { integerValue: String(Date.now()) }
                }
              })
            });
          } catch (eCar) { Logger.log('cobc4History write error: ' + eCar); }
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Shift not found' });
    }

    // CANCEL CAR SHIFT — member cancels their own booking
    if (action === 'cancelCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({ success: false, error: 'No shift ID' });
      var carSheet4 = getOrCreateCarScheduleSheet(ss);
      var carData4 = carSheet4.getDataRange().getValues();
      for (var cai = 1; cai < carData4.length; cai++) {
        if (carData4[cai][0] && carData4[cai][0].toString() === shiftId) {
          carSheet4.getRange(cai + 1, 7).setValue('cancelled');
          SpreadsheetApp.flush();
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Shift not found' });
    }

    // UPDATE CAR SHIFT NOTE — edits the Notes field (col H) of a booking
    if (action === 'updateCarShiftNote') {
      var noteId = (body.id || '').toString().trim();
      if (!noteId) return jr({ success: false, error: 'No shift ID' });
      var carSheetN = getOrCreateCarScheduleSheet(ss);
      var carDataN = carSheetN.getDataRange().getValues();
      for (var ni = 1; ni < carDataN.length; ni++) {
        if (carDataN[ni][0] && carDataN[ni][0].toString() === noteId) {
          carSheetN.getRange(ni + 1, 8).setValue(body.note || ''); // col H = Notes
          SpreadsheetApp.flush();
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Booking not found' });
    }

    // DELETE CAR SHIFT — admin hard-deletes a booking row from the sheet
    if (action === 'deleteCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({ success: false, error: 'No shift ID' });
      var carSheetD = getOrCreateCarScheduleSheet(ss);
      var carDataD = carSheetD.getDataRange().getValues();
      for (var di = 1; di < carDataD.length; di++) {
        if (carDataD[di][0] && carDataD[di][0].toString() === shiftId) {
          carSheetD.deleteRow(di + 1); // +1 because sheet rows are 1-indexed and row 1 is header
          SpreadsheetApp.flush();
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Shift not found' });
    }

    // APPROVE CAR SHIFT — chief/admin approves a pending booking
    if (action === 'approveCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({ success: false, error: 'No shift ID' });
      var carSheet5 = getOrCreateCarScheduleSheet(ss);
      var carData5 = carSheet5.getDataRange().getValues();
      for (var api = 1; api < carData5.length; api++) {
        if (carData5[api][0] && carData5[api][0].toString() === shiftId) {
          carSheet5.getRange(api + 1, 7).setValue('approved');
          carSheet5.getRange(api + 1, 9).setValue(false); // clear needsApproval flag
          SpreadsheetApp.flush();
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Shift not found' });
    }

    // REVERT CAR SHIFT — resets a stuck 'active' shift back to 'approved'
    // (used when the car was started but never actually signed OUT)
    if (action === 'revertCarShift') {
      var shiftId = (body.id || '').toString().trim();
      if (!shiftId) return jr({ success: false, error: 'No shift ID' });
      var carSheetR = getOrCreateCarScheduleSheet(ss);
      var carDataR = carSheetR.getDataRange().getValues();
      for (var rvi = 1; rvi < carDataR.length; rvi++) {
        if (carDataR[rvi][0] && carDataR[rvi][0].toString() === shiftId) {
          carSheetR.getRange(rvi + 1, 7).setValue('approved'); // G = Status
          carSheetR.getRange(rvi + 1, 11).setValue('');         // K = ActualSignOut
          SpreadsheetApp.flush();
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Shift not found' });
    }

    // SET ALERT RECIPIENT — admin toggles overdue alert flag for a member (col H)
    if (action === 'setAlertRecipient') {
      var targetIdAR = (body.memberId || '').toString().trim().replace(/^BC-?0*/i, '');
      var enabledAR = body.enabled ? true : false;
      if (!targetIdAR) return jr({ success: false, error: 'No member ID' });
      var mssAR2 = SpreadsheetApp.openById(MEMBER_SSID);
      var mshAR2 = mssAR2.getSheetByName('Chaverim Member info');
      var mdAR2 = mshAR2.getDataRange().getValues();
      for (var ri2 = 1; ri2 < mdAR2.length; ri2++) {
        var rowIdAR = mdAR2[ri2][0] ? mdAR2[ri2][0].toString().trim().replace(/^BC-?0*/i, '') : '';
        if (rowIdAR === targetIdAR) {
          mshAR2.getRange(ri2 + 1, 8).setValue(enabledAR); // col H
          SpreadsheetApp.flush();
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Member not found' });
    }

    // SET CAR ACCESS — admin toggles a member's car access (col G of member sheet)
    if (action === 'setCarAccess') {
      var targetId = (body.memberId || '').toString().trim().replace(/^BC-/i, '');
      var hasAccess = body.hasAccess ? true : false;
      if (!targetId) return jr({ success: false, error: 'No member ID' });
      var mssCA = SpreadsheetApp.openById(MEMBER_SSID);
      var mshCA = mssCA.getSheetByName('Chaverim Member info');
      var mdataCA = mshCA.getDataRange().getValues();
      for (var mi = 1; mi < mdataCA.length; mi++) {
        var rowId = mdataCA[mi][0] ? mdataCA[mi][0].toString().trim().replace(/^BC-/i, '') : '';
        if (rowId === targetId) {
          mshCA.getRange(mi + 1, 7).setValue(hasAccess); // col G (1-indexed = 7)
          SpreadsheetApp.flush();
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Member not found' });
    }

    // GET ALERT RECIPIENTS — returns array of member IDs with alertRecipient = true (col H)
    if (action === 'getAlertRecipients') {
      var mssAR = SpreadsheetApp.openById(MEMBER_SSID);
      var mshAR = mssAR.getSheetByName('Chaverim Member info');
      var mdAR = mshAR.getDataRange().getValues();
      var recips = [];
      for (var ri = 1; ri < mdAR.length; ri++) {
        if (mdAR[ri][7]) { // col H (index 7)
          var rid = mdAR[ri][0] ? mdAR[ri][0].toString().trim().replace(/^BC-?0*/i, '') : '';
          if (rid) recips.push(parseInt(rid, 10));
        }
      }
      return jr({ success: true, recipients: recips });
    }

    // SET MEMBER EMAIL — writes Gmail address to col I of member sheet
    if (action === 'setMemberEmail') {
      var targetId = (body.memberId || '').toString().trim().replace(/^BC-?/i, '');
      var email = (body.email || '').toString().trim();
      if (!targetId) return jr({ success: false, error: 'No member ID' });
      var mssSE = SpreadsheetApp.openById(MEMBER_SSID);
      var mshSE = mssSE.getSheetByName('Chaverim Member info');
      var mdSE = mshSE.getDataRange().getValues();
      for (var sei = 1; sei < mdSE.length; sei++) {
        var rowId = mdSE[sei][0] ? mdSE[sei][0].toString().trim().replace(/^BC-?/i, '') : '';
        if (rowId === targetId) {
          mshSE.getRange(sei + 1, 9).setValue(email); // Column I
          SpreadsheetApp.flush();
          return jr({ success: true });
        }
      }
      return jr({ success: false, error: 'Member not found' });
    }

    if (action === 'whatsappNotify') {
      notifyWhatsApp_(body.body || '');
      return jr({ success: true });
    }

    return jr({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jr({ success: false, error: err.toString() });
  }
}

// ── Data endpoints ────────────────────────────────────────────────────────────
function getInventoryJSON() {
  var ss = SpreadsheetApp.openById(SSID);
  var sheet = ss.getSheetByName(SHEET);
  var data = sheet.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][2]) continue;
    var colH = data[i][7] ? data[i][7].toString().trim() : '';
    var isCNC = colH.toUpperCase().indexOf('CNC') === 0;
    items.push({
      row: i + 1,
      name: data[i][2].toString().trim(),
      homeLocation: data[i][3] ? data[i][3].toString() : '',
      status: data[i][1] === 'OUT' ? 'OUT' : (data[i][0] === 'IN' ? 'IN' : ''),
      member: data[i][4] ? data[i][4].toString() : '',
      call: data[i][5] ? data[i][5].toString() : '',
      lastUpdated: data[i][6] ? data[i][6].toString() : '',
      ccnc: colH,
      isCNC: isCNC,
      cncNote: isCNC ? colH.replace(/^CNC\s*[-–]\s*/i, '') : '',
      equipStatus: data[i][10] ? data[i][10].toString() : 'OK',
      equipNote: data[i][11] ? data[i][11].toString() : '',
      lastChecked: data[i][12] ? data[i][12].toString() : ''
    });
  }
  return ContentService.createTextOutput(JSON.stringify({ items: items }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getChecklistJSON() {
  var ss = SpreadsheetApp.openById(SSID);
  var sheet = ss.getSheetByName(SHEET);
  var data = sheet.getDataRange().getValues();
  var byLoc = {};
  for (var i = 1; i < data.length; i++) {
    if (!data[i][2]) continue;
    var loc = data[i][3] ? data[i][3].toString().trim() : 'COBC';
    var colH = data[i][7] ? data[i][7].toString().trim() : '';
    var isCNC = colH.toUpperCase().indexOf('CNC') === 0;
    if (!byLoc[loc]) byLoc[loc] = [];
    byLoc[loc].push({
      row: i + 1,
      name: data[i][2].toString().trim(),
      status: data[i][1] === 'OUT' ? 'OUT' : (data[i][0] === 'IN' ? 'IN' : ''),
      equipStatus: data[i][10] ? data[i][10].toString() : 'OK',
      equipNote: data[i][11] ? data[i][11].toString() : '',
      lastChecked: data[i][12] ? data[i][12].toString() : '',
      ccnc: colH,
      isCNC: isCNC,
      cncNote: isCNC ? colH.replace(/^CNC\s*[-–]\s*/i, '') : '',
      lastUpdated: data[i][6] ? data[i][6].toString() : ''
    });
  }
  return ContentService.createTextOutput(JSON.stringify({ byLocation: byLoc }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── v77: getMembersJSON — includes carAccess field ────────────────────────────
function getMembersJSON() {
  try {
    var ss = SpreadsheetApp.openById(MEMBER_SSID);
    var sheet = ss.getSheetByName('Chaverim Member info');
    var data = sheet.getDataRange().getValues();
    var members = [];
    for (var i = 1; i < data.length; i++) {
      var id = data[i][0] ? data[i][0].toString().trim().replace(/^BC-/i, '') : '';
      if (!id) continue;
      var rawAccess = data[i][6];
      var carAccess = rawAccess === true || (rawAccess && rawAccess.toString().toLowerCase() === 'true');
      members.push({
        id: id,
        unit: id,
        lastName: data[i][1] ? data[i][1].toString().trim() : '',
        firstName: data[i][2] ? data[i][2].toString().trim() : '',
        phone: data[i][3] ? data[i][3].toString().trim() : '',
        status: data[i][4] ? data[i][4].toString().trim() : 'Member',
        name: ((data[i][2] || '') + ' ' + (data[i][1] || '')).trim(),
        carAccess: carAccess
      });
    }
    return ContentService.createTextOutput(JSON.stringify({ members: members }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ members: [], error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getLocationsJSON() {
  var ps = PropertiesService.getScriptProperties();
  var stored = ps.getProperty('LOCATIONS');
  var locs = stored ? JSON.parse(stored) : ['COBC'];
  return ContentService.createTextOutput(JSON.stringify({ locations: locs }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── v77: getMemberByPinJSON — includes carAccess field ───────────────────────
function getMemberByPinJSON(pin) {
  if (!pin) return jr({ id: null, error: 'No PIN' });
  try {
    // ── Check admin/ET hashed passwords first ────────────────────────────────
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      pin.toString().trim(), Utilities.Charset.UTF_8);
    var hexHash = digest.map(function (b) {
      var h = (b < 0 ? b + 256 : b).toString(16);
      return h.length < 2 ? '0' + h : h;
    }).join('');
    var adminLevel = _SERVER_PASSWORDS[hexHash] || 0;
    if (adminLevel > 0) {
      return jr({ id: null, adminLevel: adminLevel, isAdminPin: true });
    }
    // ── Otherwise check member PINs ──────────────────────────────────────────
    var ss = SpreadsheetApp.openById(MEMBER_SSID);
    var sheet = ss.getSheetByName('Chaverim Member info');
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var rowPin = data[i][5] ? data[i][5].toString().trim() : '';
      if (rowPin && rowPin === pin.toString().trim()) {
        var rawId = data[i][0] ? data[i][0].toString().trim() : '';
        var id = rawId.replace(/^BC-/i, '');
        var firstName = data[i][2] ? data[i][2].toString().trim() : '';
        var lastName = data[i][1] ? data[i][1].toString().trim() : '';
        var rawAccess = data[i][6];
        var carAccess = rawAccess === true || (rawAccess && rawAccess.toString().toLowerCase() === 'true');
        var statusRaw = data[i][4] ? data[i][4].toString().trim() : 'Member';
        return jr({
          id: id,
          unit: id,
          name: (firstName + ' ' + lastName).trim(),
          firstName: firstName,
          lastName: lastName,
          phone: data[i][3] ? data[i][3].toString().trim() : '',
          carAccess: carAccess,
          status: statusRaw
        });
      }
    }
    return jr({ id: null, error: 'PIN not found' });
  } catch (err) {
    return jr({ id: null, error: err.toString() });
  }
}

// ── getOrCreateSheet helper ─────────────────────────────────────────────────
function getOrCreateSheet(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

// ── getRecentInventoryEventsJSON — returns events from last 90 seconds ─────────
function getRecentInventoryEventsJSON() {
  try {
    var ss2 = SpreadsheetApp.openById(SSID);
    var evSheet = ss2.getSheetByName('InventoryEvents');
    if (!evSheet || evSheet.getLastRow() < 2) return jr({ events: [] });
    var data = evSheet.getDataRange().getValues();
    var cutoff = new Date(Date.now() - 90 * 1000); // last 90 seconds
    var events = [];
    for (var i = data.length - 1; i >= 1; i--) {
      var ts = data[i][0] ? new Date(data[i][0]) : null;
      if (!ts || ts < cutoff) break; // rows are chronological — stop when old
      events.push({
        ts: data[i][0] ? data[i][0].toString() : '',
        action: data[i][1] ? data[i][1].toString() : '',
        items: data[i][2] ? data[i][2].toString() : '',
        member: data[i][3] ? data[i][3].toString() : '',
        loggedBy: data[i][4] ? data[i][4].toString() : ''
      });
    }
    return ContentService.createTextOutput(JSON.stringify({ events: events }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (e) {
    return ContentService.createTextOutput(JSON.stringify({ events: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ── getMemberByEmailJSON — Google Sign-In lookup ──────────────────────────────
// Member sheet col H (index 7) must contain the member's Google/Gmail address.
function getMemberByEmailJSON(email) {
  if (!email) return jr({ id: null, error: 'No email' });
  try {
    var ss = SpreadsheetApp.openById(MEMBER_SSID);
    var sheet = ss.getSheetByName('Chaverim Member info');
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var rowEmail = data[i][8] ? data[i][8].toString().trim().toLowerCase() : '';
      if (rowEmail && rowEmail === email.toLowerCase().trim()) {
        var rawId = data[i][0] ? data[i][0].toString().trim() : '';
        var id = rawId.replace(/^BC-/i, '');
        var firstName = data[i][2] ? data[i][2].toString().trim() : '';
        var lastName = data[i][1] ? data[i][1].toString().trim() : '';
        var rawAccess = data[i][6];
        var carAccess = rawAccess === true || (rawAccess && rawAccess.toString().toLowerCase() === 'true');
        var statusRaw = data[i][4] ? data[i][4].toString().trim() : 'Member';
        return jr({
          id: id,
          unit: id,
          name: (firstName + ' ' + lastName).trim(),
          firstName: firstName,
          lastName: lastName,
          phone: data[i][3] ? data[i][3].toString().trim() : '',
          carAccess: carAccess,
          status: statusRaw
        });
      }
    }
    return jr({ id: null, error: 'Email not found' });
  } catch (err) {
    return jr({ id: null, error: err.toString() });
  }
}

// ── v77: getCarScheduleJSON ────────────────────────────────────────────────────
function autoCancelExpiredShifts(ss, carSheet) {
  var data = carSheet.getDataRange().getValues();
  var now = new Date();
  var changed = false;
  for (var i = 1; i < data.length; i++) {
    var status = data[i][6] ? data[i][6].toString().toLowerCase() : '';
    if (status !== 'approved' && status !== 'pending') continue;
    // Only cancel if not yet started (active would mean car is out)
    var dateVal = data[i][3];
    var endTimeVal = data[i][5];
    var dateStr = dateVal instanceof Date
      ? Utilities.formatDate(dateVal, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : dateVal.toString();
    var endTimeStr = formatTimeCol(endTimeVal);
    if (!dateStr || !endTimeStr) continue;
    var endMins = timeTo24Min(endTimeStr);
    if (endMins < 0) continue;
    var parts = dateStr.split('-');
    var endDt = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]),
      Math.floor(endMins / 60), endMins % 60, 0);
    if (endMins <= timeTo24Min(formatTimeCol(data[i][4]))) {
      endDt.setDate(endDt.getDate() + 1); // overnight shift ends next day
    }
    if (now > endDt) {
      carSheet.getRange(i + 1, 7).setValue('cancelled');
      changed = true;
    }
  }
  if (changed) SpreadsheetApp.flush();
}

function getCarScheduleJSON() {
  try {
    var ss = SpreadsheetApp.openById(SSID);
    var carSheet = getOrCreateCarScheduleSheet(ss);
    var lastRow = carSheet.getLastRow();

    if (lastRow < 2) {
      return ContentService.createTextOutput(JSON.stringify({ bookings: [] }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Auto-cancel any approved/pending shifts whose end time has already passed
    autoCancelExpiredShifts(ss, carSheet);

    var data = carSheet.getRange(2, 1, lastRow - 1, 14).getValues();
    var bookings = [];
    var now = new Date();
    var cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var id = row[0] ? row[0].toString() : '';
      if (!id) continue;

      var status = row[6] ? row[6].toString() : '';
      // Always return date as YYYY-MM-DD — Sheets may auto-convert to a Date object
      var tz1 = Session.getScriptTimeZone();
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
        id: id,
        memberId: row[1] ? row[1].toString() : '',
        memberName: row[2] ? row[2].toString() : '',
        date: date,
        startTime: formatTimeCol(row[4]),
        endTime: formatTimeCol(row[5]),
        status: status,
        note: row[7] ? row[7].toString() : '',
        needsApproval: needsApproval === true || needsApproval === 'TRUE' || needsApproval === 'true',
        createdAt: row[9] ? row[9].toString() : '',
        actualSignOut: row[10] ? row[10].toString() : '',
        actualSignIn: row[11] ? row[11].toString() : '',
        bookedBy: row[12] ? row[12].toString() : '',
        vehicle: row[13] ? row[13].toString() : 'COBC 4'
      });
    }

    return ContentService.createTextOutput(JSON.stringify({ bookings: bookings }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ bookings: [], error: err.toString() }))
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
  var str = (t instanceof Date) ? formatTimeCol(t) : (t || '').toString();
  var m = str.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return -1;
  var h = parseInt(m[1]), mn = parseInt(m[2]), ap = m[3].toUpperCase();
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + mn;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function ep(e, key) {
  return (e.parameter && e.parameter[key]) ? e.parameter[key] : '';
}
function esc(v) {
  return (v || '').toString()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
        let response = UrlFetchApp.fetch(qrUrl, { followRedirects: true, muteHttpExceptions: true });
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
  var urls = sheet.getRange(2, 13, lastRow - 1, 1).getValues();
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

// The Universal Traffic Cop: Watches the entire spreadsheet for edits
function globalSpreadsheetSyncTrigger(e) {
  var range = e.range;
  var sheetName = range.getSheet().getName();

  Logger.log("Edit detected on tab: " + sheetName);

  if (sheetName === "Chaverim Member info") {
    syncSheetsToFirestoreWithPins();
  }

  if (sheetName === "Inventory") {
    syncEquipmentToFirestore();
  }

  if (sheetName === "CarSchedule" || sheetName === "Car Schedule") {
    syncCarScheduleToFirestore();
  }
}

// 1. DYNAMIC MEMBER SYNC (Targeting your exact tab name)
function syncSheetsToFirestoreWithPins() {
  const firebaseUrl = "https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/members/";
  const token = ScriptApp.getOAuthToken();
  var _mss = SpreadsheetApp.openById(MEMBER_SSID);
  const sheet = _mss.getSheetByName("Chaverim Member info");
  const data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    var unitId = data[i][0].toString().trim();
    var role = data[i][4].toString().toLowerCase().trim();
    // col[5] = PIN — intentionally never read here
    var cobc4Approval = data[i][6].toString().trim();
    if (!unitId) continue;
    // Only safe, non-PII fields go to Firestore.
    // PII (names, phone, email) stays in the private Sheet only.
    var firestoreData = {
      "fields": {
        "unit": { "stringValue": unitId },
        "role": { "stringValue": role },
        "cobc4Approval": { "stringValue": cobc4Approval }
      }
    };
    var options = {
      "method": "patch",
      "contentType": "application/json",
      "headers": { "Authorization": "Bearer " + token },
      "payload": JSON.stringify(firestoreData),
      "muteHttpExceptions": true
    };
    // updateMask: only touch unit, role, cobc4Approval, and pin.
    // pin is listed but absent from the payload → Firestore deletes it on every sync.
    var updateMaskUrl = firebaseUrl + unitId
      + '?updateMask.fieldPaths=unit'
      + '&updateMask.fieldPaths=role'
      + '&updateMask.fieldPaths=cobc4Approval'
      + '&updateMask.fieldPaths=pin';
    var response = UrlFetchApp.fetch(updateMaskUrl, options);
    Logger.log("Synced Member " + unitId + " -> Status: " + response.getResponseCode());
  }
  // Cleanup: delete Firestore members no longer in the sheet
  try {
    var sheetIds = {};
    for (var si = 1; si < data.length; si++) {
      var sid = data[si][0].toString().trim();
      if (sid) sheetIds[sid.toLowerCase()] = true;
    }
    var listResp = UrlFetchApp.fetch(
      'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/members?pageSize=300',
      { method: 'GET', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true }
    );
    var listData = JSON.parse(listResp.getContentText());
    var docs = listData.documents || [];
    for (var di = 0; di < docs.length; di++) {
      var docName = docs[di].name;
      var docId = docName.split('/').pop();
      if (!sheetIds[docId.toLowerCase()]) {
        UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + docName,
          { method: 'DELETE', headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
        Logger.log('Deleted stale Firestore member: ' + docId);
      }
    }
  } catch (cleanupErr) {
    Logger.log('Member cleanup error: ' + cleanupErr);
  }
}

// 2. EQUIPMENT SYNC
function syncEquipmentToFirestore() {
  const firebaseUrl = "https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/equipment/";
  const token = ScriptApp.getOAuthToken();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Inventory");
  const data = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    var itemName = data[i][2] ? data[i][2].toString().trim() : null; // Column C: Item Name
    if (!itemName) continue;

    // Mapping your columns (Adjust the index [X] if these are in different columns!)
    var status = (data[i][1] !== "") ? "OUT" : "IN"; // Col B: OUT
    var location = data[i][3] ? data[i][3].toString().trim() : "COBC"; // Col D: Location
    var memberNum = data[i][4] ? data[i][4].toString() : ""; // Col E: Member #
    var callNum = data[i][5] ? data[i][5].toString() : ""; // Col F: Call #
    var lastUpdated = data[i][6] ? data[i][6].toString() : ""; // Col G: Last Updated
    var ccCnc = data[i][7] ? data[i][7].toString() : ""; // Col H: CC/CNC
    var statusDetails = data[i][11] ? data[i][11].toString() : ""; // Col L: Equipment status details
    var checklistChecked = data[i][12] ? data[i][12].toString() : ""; // Col M: Checklist Checked
    var notActive = data[i][10] ? data[i][10].toString() : ""; // Col K: Not Active

    var firestoreData = {
      "fields": {
        "itemName": { "stringValue": itemName },
        "status": { "stringValue": status },
        "location": { "stringValue": location },
        "memberNum": { "stringValue": memberNum },
        "callNum": { "stringValue": callNum },
        "lastUpdated": { "stringValue": lastUpdated },
        "ccCnc": { "stringValue": ccCnc },
        "statusDetails": { "stringValue": statusDetails },
        "equipStatus": { "stringValue": notActive },
        "notActive": { "stringValue": notActive },
        "checklistChecked": { "stringValue": checklistChecked },
        "row": { "integerValue": String(i + 1) }
      }
    };

    var options = {
      "method": "patch",
      "contentType": "application/json",
      "payload": JSON.stringify(firestoreData),
      "headers": { "Authorization": "Bearer " + token }
    };

    UrlFetchApp.fetch(firebaseUrl + String(i + 1), options);
  }
}

function syncCarScheduleToFirestore() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("CarSchedule") || ss.getSheetByName("Car Schedule");
  if (!sheet) { Logger.log("CarSchedule sheet not found"); return; }

  var data = sheet.getDataRange().getValues();
  var token = ScriptApp.getOAuthToken();
  var baseUrl = "https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/carSchedule/";

  var synced = 0;
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var id = String(row[0] || "").trim();
    if (!id) continue;

    var doc = {
      fields: {
        id: { stringValue: id },
        memberId: { stringValue: String(row[1] || "") },
        memberName: { stringValue: String(row[2] || "") },
        date: { stringValue: String(row[3] || "") },
        startTime: { stringValue: String(row[4] || "") },
        endTime: { stringValue: String(row[5] || "") },
        status: { stringValue: String(row[6] || "") },
        notes: { stringValue: String(row[7] || "") },
        needsApproval: { booleanValue: String(row[8] || "").toLowerCase() === "true" },
        createdAt: { stringValue: String(row[9] || "") },
        actualSignOut: { stringValue: String(row[10] || "") },
        actualSignIn: { stringValue: String(row[11] || "") },
        bookedBy: { stringValue: String(row[12] || "") },
        vehicle: { stringValue: String(row[13] || "COBC 4") }
      }
    };

    var options = {
      method: "PATCH",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify(doc),
      muteHttpExceptions: true
    };

    var resp = UrlFetchApp.fetch(baseUrl + encodeURIComponent(id), options);
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      synced++;
    } else {
      Logger.log("CarSchedule sync error row " + (i + 1) + ": " + resp.getContentText());
    }
  }
  Logger.log("syncCarScheduleToFirestore: synced " + synced + " bookings");
}

function syncInventoryEventsToFirestore() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("InventoryEvents");
  if (!sheet) { Logger.log("InventoryEvents sheet not found"); return; }

  var data = sheet.getDataRange().getValues();
  var token = ScriptApp.getOAuthToken();
  var baseUrl = "https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/inventoryEvents/";

  var synced = 0;
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var ts = row[0];
    if (!ts) continue;

    var docId = "row_" + (i + 1);
    var tsStr = (ts instanceof Date) ? ts.toISOString() : String(ts);

    var doc = {
      fields: {
        timestamp: { stringValue: tsStr },
        action: { stringValue: String(row[1] || "") },
        items: { stringValue: String(row[2] || "") },
        member: { stringValue: String(row[3] || "") },
        loggedBy: { stringValue: String(row[4] || "") },
        rowIndex: { integerValue: String(i + 1) }
      }
    };

    var options = {
      method: "PATCH",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + token },
      payload: JSON.stringify(doc),
      muteHttpExceptions: true
    };

    var resp = UrlFetchApp.fetch(baseUrl + docId, options);
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      synced++;
    } else {
      Logger.log("InventoryEvents sync error row " + (i + 1) + ": " + resp.getContentText());
    }
  }
  Logger.log("syncInventoryEventsToFirestore: synced " + synced + " events");
}

function syncAllToFirestore() {
  Logger.log("=== Starting full sync ===");
  syncSheetsToFirestoreWithPins();
  syncEquipmentToFirestore();
  syncCarScheduleToFirestore();
  syncInventoryEventsToFirestore();
  Logger.log("=== Full sync complete ===");
}

// Delete stale equipment docs from Firestore that have no 'row' field
// (created by old syncs that used wrong column as doc ID)
function cleanupStaleEquipmentDocs() {
  var token = ScriptApp.getOAuthToken();
  var base = "https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/equipment";
  var deleted = 0, kept = 0, errors = 0;

  // Fetch all docs (paginate)
  var pageToken = null;
  do {
    var url = base + "?pageSize=300" + (pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : "");
    var resp = UrlFetchApp.fetch(url, {
      headers: { "Authorization": "Bearer " + token },
      muteHttpExceptions: true
    });
    var data = JSON.parse(resp.getContentText());
    var docs = data.documents || [];
    pageToken = data.nextPageToken || null;

    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i];
      var fields = doc.fields || {};
      var hasRow = fields.hasOwnProperty("row") && fields.row && fields.row.integerValue;
      if (hasRow) {
        kept++;
      } else {
        // Delete stale doc
        var delResp = UrlFetchApp.fetch("https://firestore.googleapis.com/v1/" + doc.name, {
          method: "delete",
          headers: { "Authorization": "Bearer " + token },
          muteHttpExceptions: true
        });
        if (delResp.getResponseCode() === 200 || delResp.getResponseCode() === 204) {
          deleted++;
        } else {
          errors++;
          Logger.log("Failed to delete " + doc.name + ": " + delResp.getResponseCode());
        }
      }
    }
  } while (pageToken);

  Logger.log("cleanupStaleEquipmentDocs: kept=" + kept + " deleted=" + deleted + " errors=" + errors);
}

// ─── WhatsApp / Twilio ─────────────────────────────────────────────────────
// ── WhatsApp / Twilio ──────────────────────────────────────────────────
// [Redacted for the public GitHub mirror — this block hardcodes real Twilio
//  credentials (Account SID, Auth Token, from-number) as setProperty() literals
//  instead of reading them from Script Properties. GitHub's secret scanner
//  flagged it on push. The live Apps Script project still has the real code —
//  it should be edited there to pull these from Script Properties like SSID/
//  MEMBER_SSID already do, so no live credential ever needs to sit in source.]

function notifyWhatsApp_(msgBody) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('TWILIO_RECIPIENTS') || '';
  raw.split(',').map(function (r) { return r.trim(); }).filter(Boolean).forEach(function (r) {
    sendWhatsApp_(r, msgBody);
  });
}

// ── Server-side equipment check-in/out push (so notifications fire instantly, ─
// regardless of whether any dispatch/admin device has the app open) ───────────
var PUSH_SEND_URL_GS  = 'https://script.google.com/macros/s/AKfycbyrOTdBNqyvoDOBRx_n_BuxvSXP6IvrndPQv0dKBKCoQyhOTXT1KoxBHlbArty9eBxsFQ/exec';
var PUSH_SHARED_KEY_GS = 'cobc-2026-shared-secret';

// Push an equipment check-in/out notification to admins + equipment team + all
// dispatchers. (Server-side has no live on-duty-shift data handy, so we reach all
// dispatchers; the app-side de-dupe is gone once the client send is removed.)
function _pushEquipEvent(item, status, byUnit, callNum, colH) {
  try {
    var act = String(status||'').toUpperCase();
    if (act !== 'IN' && act !== 'OUT') return;
    var by = byUnit ? ('BC-' + String(byUnit).replace(/^BC-?/i,'')) : 'someone';
    var callTxt = callNum ? (' · Call #' + callNum) : '';
    var detail = String(colH||'').trim(), detailTxt = '';
    if (detail && detail.toUpperCase() !== 'CC') {
      if (/^cnc/i.test(detail)) { var d = detail.replace(/^cnc\s*-?\s*/i,''); detailTxt = ' · ⚠️ CNC' + (d ? (' (' + d + ')') : ''); }
      else if (/vehicle|truck/i.test(detail)) detailTxt = ' · 🚚 ' + detail;
      else if (/mov/i.test(detail)) detailTxt = ' · ↔️ Moving between calls';
      else detailTxt = ' · ' + detail;
    }
    var verb  = act === 'OUT' ? 'checked OUT' : 'checked IN';
    var emoji = act === 'OUT' ? '📤' : '📥';
    var title = emoji + ' ' + item + ' ' + verb;
    var body  = item + ' ' + verb + ' by ' + by + callTxt + detailTxt;
  var pushUrl = '/cobc-dispatch/?page=equipment';

  // Recipients: admins + equipment team + all dispatchers, from the member sheet.
  var mss = SpreadsheetApp.openById(MEMBER_SSID);
  var msh = mss.getSheetByName('Chaverim Member info');
  var data = msh.getDataRange().getValues();
  var units = {};
  for (var i = 1; i < data.length; i++) {
    var uid = data[i][0] ? String(data[i][0]).trim().replace(/^BC-?/i,'') : '';
    var role = data[i][4] ? String(data[i][4]).toLowerCase() : '';
    if (!uid) continue;
    if (role.indexOf('admin') >= 0 || role.indexOf('equipment') >= 0 || role.indexOf('dispatch') >= 0) units[uid] = true;
  }

  // Topic routing (FCM Topics migration) — optional, gated by Script Properties.
  // PUSH_TOPICS_URL unset (default) = topic call skipped entirely, byte-identical
  // to pre-migration behavior. PUSH_TOPICS_CUTOVER = 'true' only after the
  // parallel run is verified — until then BOTH the topic send and the token
  // pushes below fire, so nothing can go silently dark.
  var _tprops = PropertiesService.getScriptProperties();
  var topicsUrl = (_tprops.getProperty('PUSH_TOPICS_URL') || '').trim();
  var cutover = (_tprops.getProperty('PUSH_TOPICS_CUTOVER') || '').trim() === 'true';

  // Build every outgoing request up front (per-unit token pushes, plus the
  // topic send if configured) and fire them ALL together via fetchAll — this
  // runs them in parallel instead of one after another, so adding the topic
  // call costs zero extra serial latency versus the old per-unit-only loop.
  var unitIds = topicsUrl ? [] : Object.keys(units); // fix: topic-only when configured, no dual-send
  var requests = unitIds.map(function(u) {
    return {
      url: PUSH_SEND_URL_GS,
      method: 'post', contentType: 'text/plain',
      payload: JSON.stringify({ action:'send', key:PUSH_SHARED_KEY_GS, target:'unit', unit:u, title:title, body:body, url:pushUrl }),
      muteHttpExceptions: true
    };
  });
  if (topicsUrl) {
    requests.push({
      url: topicsUrl.replace(/\/$/, '') + '/push-topic',
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ key: PUSH_SHARED_KEY_GS, topic: 'equipment', title: title, body: body, url: pushUrl }),
      muteHttpExceptions: true
    });
  }
  if (!requests.length) return;

  var responses = UrlFetchApp.fetchAll(requests);
  if (topicsUrl) {
    try {
      var tRes = responses[responses.length - 1];
      var tData = JSON.parse(tRes.getContentText() || '{}');
      if (tData.ok !== true) Logger.log('_pushEquipEvent topic send failed: ' + tRes.getContentText());
    } catch (eTopic) { Logger.log('_pushEquipEvent topic parse error: ' + eTopic); }
  }
} catch (e) { Logger.log('_pushEquipEvent error: ' + e); }
}

// ── Grouped equipment push: one notification per checkout action, not per item ──
// Uses the combined comma-separated item list already sent to logInventoryEvent
// (single row per action, not per item) — see checkInOut, which no longer
// calls _pushEquipEvent per item (that was the "8 notifications for 2 items" bug).
function _pushEquipEventGrouped(itemsStr, action2, memberStr, callNum) {
  try {
    var act = String(action2||'').toUpperCase();
    if (act !== 'IN' && act !== 'OUT') return;
    var itemsArr = String(itemsStr||'').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    if (!itemsArr.length) return;
    var verb = act === 'OUT' ? 'checked OUT' : 'checked IN';
    var by = memberStr || 'someone';
    var callTxt = callNum ? (' — Call #' + callNum) : '';
    var label = itemsArr.length === 1 ? itemsArr[0] : (itemsArr.length + ' items');
    var title = label + ' ' + verb;
    var body = label + ' ' + verb + ' by ' + by + (itemsArr.length > 1 ? (' · ' + itemsArr.join(', ')) : '') + callTxt;
    var pushUrl = '/cobc-dispatch/?page=equipment';

    // Recipients: admins + equipment team + all dispatchers, from the member sheet.
    // (token-based direct send — small fixed audience, no FCM topic dependency)
    var mss = SpreadsheetApp.openById(MEMBER_SSID);
    var msh = mss.getSheetByName('Chaverim Member info');
    var data = msh.getDataRange().getValues();
    var units = {};
    for (var i = 1; i < data.length; i++) {
      var uid = data[i][0] ? String(data[i][0]).trim().replace(/^BC-?/i,'') : '';
      var role = data[i][4] ? String(data[i][4]).toLowerCase() : '';
      if (!uid) continue;
      if (role.indexOf('admin') >= 0 || role.indexOf('equipment') >= 0 || role.indexOf('dispatch') >= 0) units[uid] = true;
    }
    var unitIds = Object.keys(units);
    if (!unitIds.length) return;
    var requests = unitIds.map(function(u) {
      return {
        url: PUSH_SEND_URL_GS,
        method: 'post', contentType: 'text/plain',
        payload: JSON.stringify({ action:'send', key:PUSH_SHARED_KEY_GS, target:'unit', unit:u, title:title, body:body, url:pushUrl }),
        muteHttpExceptions: true
      };
    });
    UrlFetchApp.fetchAll(requests);
  } catch (e) { Logger.log('_pushEquipEventGrouped fn error: ' + e); }
}

// ── One-time sync: Google Sheet → Firestore ──────────────────────────────────
function syncAllMembersToFirestore() {
  var ss = SpreadsheetApp.openById(MEMBER_SSID);
  var sheet = ss.getSheetByName('Chaverim Member info');
  if (!sheet) { Logger.log('Sheet not found'); return; }

  var vals = sheet.getDataRange().getValues();
  var token = ScriptApp.getOAuthToken();
  var base = 'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/members/';

  var ok = 0, skip = 0, fail = 0;

  for (var i = 1; i < vals.length; i++) {
    var row = vals[i];
    var rawUnit = (row[0] + '').trim();
    if (!rawUnit) { skip++; continue; }

    // Normalise: keep "BC-XXX" form as the doc ID
    var docId = rawUnit.replace(/^bc-?/i, 'BC-').replace(/^BC(\d)/, 'BC-$1');

    var fields = {
      unit: { stringValue: docId },
      lastName: { stringValue: (row[1] + '').trim() },
      firstName: { stringValue: (row[2] + '').trim() },
      phone: { stringValue: (row[3] + '').trim() },
      role: { stringValue: (row[4] + '').trim() },
      carAccess: { booleanValue: (row[6] + '').toLowerCase() === 'true' || row[6] === true },
      alertRecipient: { stringValue: (row[7] + '').trim() },
      email: { stringValue: (row[8] + '').trim() }
    };

    var url = base + encodeURIComponent(docId);
    var resp = UrlFetchApp.fetch(url, {
      method: 'PATCH',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({ fields: fields }),
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() < 300) {
      ok++;
      Logger.log('OK: ' + docId);
    } else {
      fail++;
      Logger.log('FAIL ' + docId + ': ' + resp.getContentText());
    }
  }

  Logger.log('Done. OK=' + ok + '  skip=' + skip + '  fail=' + fail);
}

// ── Run this directly to diagnose sheet access and member delete ──────────────
function testDeleteMember() {
  var props = PropertiesService.getScriptProperties();
  var ssid = props.getProperty('MEMBER_SSID') || '';
  Logger.log('MEMBER_SSID = [' + ssid + ']');
  if (!ssid) { Logger.log('ERROR: MEMBER_SSID not set in script properties!'); return; }

  var ss = SpreadsheetApp.openById(ssid);
  var msh = ss.getSheetByName('Chaverim Member info');
  Logger.log('Sheet found: ' + (msh ? 'YES' : 'NO'));
  if (!msh) return;
  Logger.log('Last row: ' + msh.getLastRow());

  // Print first 5 values in column A
  var top5 = msh.getRange(1, 1, Math.min(6, msh.getLastRow()), 1).getValues();
  top5.forEach(function (r, i) { Logger.log('  row ' + (i + 1) + ': [' + r[0] + ']'); });

  // Try to find a member — change 'BC-997' to any ID that exists in your sheet
  var testId = 'BC-997';
  var colA = msh.getRange(1, 1, msh.getLastRow(), 1);
  var found = colA.createTextFinder(testId).matchCase(false).matchEntireCell(true).findNext();
  Logger.log('Search for ' + testId + ': ' + (found ? 'FOUND at row ' + found.getRow() : 'NOT FOUND'));
}
function getInventoryHistoryJSON(from, to) {
  return ContentService.createTextOutput(JSON.stringify({ events: [] }))
    .setMimeType(ContentService.MimeType.JSON);
}

// —— Data endpoints ——————————————————————————————————————————————————
// —— Telzio webhook handler ——————————————————————————————————————————
function handleTelzioWebhook(body) {
  try {
    var dir = String(body.Direction || body.direction || '').toLowerCase();
    if (dir && dir !== 'inbound' && dir !== 'incoming') {
      return _telzioJson({ ok: true, skipped: 'not inbound' });
    }
    var phone = body.From || body.from || '';
    var name = body.FromCnam || body.fromCnam || body.CallerName || body.caller_name || '';
    var digits = String(phone).replace(/\D+/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.substring(1);

    var token = ScriptApp.getOAuthToken();
    var url = 'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/config/telzioRecentCall'
      + '?updateMask.fieldPaths=name&updateMask.fieldPaths=phone&updateMask.fieldPaths=at';
    UrlFetchApp.fetch(url, {
      method: 'patch',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token },
      payload: JSON.stringify({
        fields: {
          name: { stringValue: name || '' },
          phone: { stringValue: digits || String(phone) || '' },
          at: { integerValue: String(Date.now()) }
        }
      }),
      muteHttpExceptions: true
    });
    return _telzioJson({ ok: true });
  } catch (err) {
    return _telzioJson({ ok: false, error: err.toString() });
  }
}

function _telzioJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function setupTelzio() {
  // Credentials already saved — run once then leave empty
  // _props.setProperty('TELZIO_API_KEY',    '');
  // _props.setProperty('TELZIO_API_SECRET', '');
  Logger.log('Already saved.');
}

function getRecentCallJSON() {
  try {
    var props = PropertiesService.getScriptProperties();
    var key = props.getProperty('TELZIO_API_KEY');
    var secret = props.getProperty('TELZIO_API_SECRET');
    var auth = Utilities.base64Encode(key + ':' + secret);
    var res = UrlFetchApp.fetch('https://api.telzio.com/calls?limit=1&direction=inbound', {
      headers: { Authorization: 'Basic ' + auth },
      muteHttpExceptions: true
    });
    var data = JSON.parse(res.getContentText());
    var call = (data.calls || data.data || data)[0];
    if (!call) return _telzioJson({ ok: false, error: 'no calls found' });
    var phone = call.from || call.caller || call.source || '';
    var name = call.caller_name || call.cnam || '';
    var digits = String(phone).replace(/\D+/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.substring(1);
    return _telzioJson({ ok: true, phone: digits || phone, name: name });
  } catch (err) {
    return _telzioJson({ ok: false, error: err.toString() });
  }
}
function _verifyFbJwt(tok) {
  // Real server-side verification via Firebase Identity Toolkit (checks signature,
  // expiry, and project match — the old version only decoded the payload locally
  // and never checked the signature, so any forged token would pass.
  if (!tok) return false;
  try {
    var resp = UrlFetchApp.fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=AIzaSyBYAz3ohsJGX_zo-Yq3faZ2m0uv4tfuSl8',
      { method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ idToken: tok }), muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) return false;
    var data = JSON.parse(resp.getContentText());
    return !!(data.users && data.users.length);
  } catch (e_) { return false; }
}

// ── v78: checkMemberEmailJSON — server-side email membership check ─────────────
// Called by the getAuthToken Cloud Function to verify a member's email.
// Reads column I (index 8) of the Chaverim Member info sheet.
// Returns {authorized:true, id, unit, status, name} or {authorized:false}.
// Email list is NEVER exposed to clients.
function checkMemberEmailJSON(email) {
  try {
    var ss = SpreadsheetApp.openById(MEMBER_SSID);
    var sheet = ss.getSheetByName('Chaverim Member info');
    var data = sheet.getDataRange().getValues();
    var needle = (email || '').toString().toLowerCase().trim();
    if (!needle) {
      return ContentService.createTextOutput(JSON.stringify({ authorized: false }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    for (var i = 1; i < data.length; i++) {
      var memberEmail = (data[i][8] || '').toString().toLowerCase().trim();
      if (memberEmail && memberEmail === needle) {
        var rawId = data[i][0] ? data[i][0].toString().trim() : '';
        var id = rawId.replace(/^BC-?/i, '');
        if (!id) continue;
        return ContentService.createTextOutput(JSON.stringify({
          authorized: true,
          id: id,
          unit: rawId,
          status: data[i][4] ? data[i][4].toString().trim() : 'Member',
          name: ((data[i][2] || '') + ' ' + (data[i][1] || '')).trim()
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ authorized: false }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log('checkMemberEmailJSON error: ' + err);
    return ContentService.createTextOutput(JSON.stringify({ authorized: false }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ══════════════════════════════════════════════════════════════
// YEARLY ARCHIVE — moves rows older than 1 year out of active sheets
// Triggered automatically once a year via setupYearlyArchiveTrigger()
// ══════════════════════════════════════════════════════════════

function archiveOldHistory() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);
  var cutoffMs = cutoff.getTime();

  // Sheets to archive: [sourceName, archiveName, timestampColIndex (0-based)]
  var targets = [
    ['InventoryEvents', 'Archive - InventoryEvents', 6],   // col G = Last Updated
    ['CarSchedule',     'Archive - CarSchedule',     9]    // col J = CreatedTimestamp
  ];

  targets.forEach(function(t) {
    var srcName = t[0], archName = t[1], tsCol = t[2];
    var src = ss.getSheetByName(srcName);
    if (!src) return; // sheet doesn't exist yet — skip

    var data = src.getDataRange().getValues();
    if (data.length <= 1) return; // header only

    var arch = getOrCreateSheet(ss, archName);
    var toArchive = [];
    var toKeep    = [data[0]]; // always keep header

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var tsVal = row[tsCol];
      var tsMs;
      if (tsVal instanceof Date) {
        tsMs = tsVal.getTime();
      } else if (typeof tsVal === 'number' && tsVal > 1e12) {
        tsMs = tsVal; // already milliseconds
      } else if (typeof tsVal === 'string' && tsVal.length > 0) {
        tsMs = new Date(tsVal).getTime();
      } else {
        toKeep.push(row); continue; // can't parse — keep it
      }
      if (isNaN(tsMs) || tsMs >= cutoffMs) {
        toKeep.push(row);
      } else {
        toArchive.push(row);
      }
    }

    if (toArchive.length === 0) return; // nothing old enough

    // Append old rows to archive sheet
    var archLastRow = arch.getLastRow();
    arch.getRange(archLastRow + 1, 1, toArchive.length, toArchive[0].length)
        .setValues(toArchive);

    // Rewrite source with only kept rows
    src.clearContents();
    src.getRange(1, 1, toKeep.length, toKeep[0].length).setValues(toKeep);

    Logger.log('Archived ' + toArchive.length + ' rows from ' + srcName + ' → ' + archName);
  });
}

// Run once to install the yearly trigger (then never need to run again)
function setupYearlyArchiveTrigger() {
  // Remove any existing archive triggers first
  ScriptApp.getProjectTriggers().forEach(function(tr) {
    if (tr.getHandlerFunction() === 'archiveOldHistory') {
      ScriptApp.deleteTrigger(tr);
    }
  });
  // Create a new yearly trigger (fires every year in January)
  ScriptApp.newTrigger('archiveOldHistory')
    .timeBased()
    .onMonthDay(1)
    .inTimezone(Session.getScriptTimeZone())
    .everyYear()
    .create();
  Logger.log('Yearly archive trigger installed.');
}

// ── Firestore history writers (checklist + reports) ───────────────────────────
function writeChecklistEvent(location, byUnit, itemsChecked, issuesFlagged) {
  var url = 'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/checklistHistory?key=AIzaSyBYAz3ohsJGX_zo-Yq3faZ2m0uv4tfuSl8';
  var payload = { fields: {
    location:       { stringValue: String(location || '') },
    byUnit:         { stringValue: String(byUnit || '') },
    itemsChecked:   { integerValue: String(itemsChecked || 0) },
    issuesFlagged:  { integerValue: String(issuesFlagged || 0) },
    at:             { integerValue: String(Date.now()) }
  }};
  var resp = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  Logger.log('checklistHistory write: ' + resp.getResponseCode());
}

function writeReportEvent(type, item, byUnit) {
  var url = 'https://firestore.googleapis.com/v1/projects/cobc-dispatch/databases/(default)/documents/reportHistory?key=AIzaSyBYAz3ohsJGX_zo-Yq3faZ2m0uv4tfuSl8';
  var payload = { fields: {
    type:   { stringValue: String(type || '') },
    item:   { stringValue: String(item || '') },
    byUnit: { stringValue: String(byUnit || '') },
    at:     { integerValue: String(Date.now()) }
  }};
  var resp = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  Logger.log('reportHistory write: ' + resp.getResponseCode());
}
