/**
 * Claude2PDF feedback receiver for Google Apps Script.
 *
 * Recommended setup:
 * 1. Create a Google Sheet for feedback.
 * 2. Open Extensions > Apps Script from that Sheet.
 * 3. Paste this file into Code.gs.
 * 4. Deploy > New deployment > Web app.
 * 5. Execute as: Me. Who has access: Anyone.
 * 6. Copy the /exec URL and use it as FEEDBACK_ENDPOINT on your server.
 */
function doPost(e) {
  try {
    var payload = parsePayload_(e);
    var sheet = getFeedbackSheet_();
    ensureHeader_(sheet);

    var lock = LockService.getScriptLock();
    lock.waitLock(8000);
    try {
      sheet.appendRow([
        new Date(),
        payload.rating || '',
        payload.message || '',
        payload.email || '',
        payload.updatesConsent || 'no',
        payload.provider || '',
        payload.appVersion || '',
        payload.source || ''
      ]);
    } finally {
      lock.releaseLock();
    }

    return json_({ success: true });
  } catch (err) {
    return json_({ success: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet() {
  return json_({ success: true, message: 'Claude2PDF feedback endpoint is online.' });
}

function parsePayload_(e) {
  if (e && e.parameter && Object.keys(e.parameter).length) {
    return e.parameter;
  }

  var raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function getFeedbackSheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    var spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!spreadsheetId) throw new Error('No active spreadsheet. Bind this script to a Sheet or set SPREADSHEET_ID.');
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  }

  var sheet = spreadsheet.getSheetByName('Feedback');
  if (!sheet) sheet = spreadsheet.insertSheet('Feedback');
  return sheet;
}

function ensureHeader_(sheet) {
  var headers = ['Received at', 'Rating', 'Message', 'Email', 'Updates consent', 'Provider', 'App version', 'Source'];
  var firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var hasHeader = firstRow.some(function (cell) { return String(cell || '').trim(); });
  if (!hasHeader) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}
