/**
 * Claude2PDF feedback receiver for Google Apps Script.
 *
 * Setup:
 * 1. Create/open the Google Sheet where feedback should be saved.
 * 2. Open Extensions > Apps Script from that Sheet.
 * 3. Paste this file into Code.gs.
 * 4. Deploy > New deployment > Web app.
 * 5. Execute as: Me. Who has access: Anyone.
 *
 * The Claude2PDF backend sends JSON to this endpoint. This script also accepts
 * form-encoded payloads for compatibility with older deployments.
 */
const SHEET_NAME = 'Feedback';

function doGet() {
  const sheet = getFeedbackSheet_();
  return json_({
    success: true,
    message: 'Claude2PDF feedback endpoint is online.',
    spreadsheetUrl: sheet.getParent().getUrl()
  });
}

function doPost(e) {
  try {
    const payload = normalizePayload_(parsePayload_(e));
    validatePayload_(payload);

    const lock = LockService.getScriptLock();
    lock.waitLock(8000);

    try {
      const sheet = getFeedbackSheet_();
      ensureHeader_(sheet);
      sheet.appendRow([
        new Date(),
        payload.rating,
        payload.message,
        payload.email,
        payload.wantsUpdates ? 'Yes' : 'No',
        payload.provider,
        payload.appVersion,
        payload.page,
        payload.userAgent
      ]);
    } finally {
      lock.releaseLock();
    }

    return json_({ success: true });
  } catch (err) {
    return json_({ success: false, error: String(err && err.message ? err.message : err) });
  }
}

function parsePayload_(e) {
  if (e && e.parameter && Object.keys(e.parameter).length) {
    return e.parameter;
  }

  const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function normalizePayload_(data) {
  const wantsUpdatesRaw = data.wantsUpdates !== undefined ? data.wantsUpdates : data.updatesConsent;
  const wantsUpdates = wantsUpdatesRaw === true || wantsUpdatesRaw === 'true' || wantsUpdatesRaw === 'yes' || wantsUpdatesRaw === 'Yes';

  return {
    rating: Number(data.rating),
    message: String(data.message || '').trim().slice(0, 2000),
    email: String(data.email || '').trim().slice(0, 254),
    wantsUpdates,
    provider: String(data.provider || '').trim().slice(0, 64),
    appVersion: String(data.appVersion || '').trim().slice(0, 64),
    page: String(data.page || data.source || '').trim().slice(0, 500),
    userAgent: String(data.userAgent || '').trim().slice(0, 500)
  };
}

function validatePayload_(payload) {
  if (!Number.isInteger(payload.rating) || payload.rating < 1 || payload.rating > 5) {
    throw new Error('Invalid rating.');
  }

  if (!payload.message) {
    throw new Error('Invalid message.');
  }

  if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    throw new Error('Invalid email.');
  }
}

function getFeedbackSheet_() {
  let spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    const properties = PropertiesService.getScriptProperties();
    const spreadsheetId = properties.getProperty('SPREADSHEET_ID');

    if (spreadsheetId) {
      spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    } else {
      spreadsheet = SpreadsheetApp.create('Claude2PDF Feedback');
      properties.setProperty('SPREADSHEET_ID', spreadsheet.getId());
    }
  }

  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);
  return sheet;
}

function ensureHeader_(sheet) {
  const headers = [
    'Created At',
    'Rating',
    'Message',
    'Email',
    'Wants Updates',
    'Provider',
    'App Version',
    'Page',
    'User Agent'
  ];

  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const hasHeader = firstRow.some(function (cell) { return String(cell || '').trim(); });
  if (!hasHeader) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function testDoPost() {
  const fakeEvent = {
    postData: {
      contents: JSON.stringify({
        rating: 5,
        message: 'Teste direto do Apps Script',
        email: 'teste@example.com',
        wantsUpdates: true,
        provider: 'test',
        appVersion: '1.0.0',
        page: 'manual-test',
        userAgent: 'Apps Script test'
      })
    }
  };

  const result = doPost(fakeEvent);
  Logger.log(result.getContent());
}
