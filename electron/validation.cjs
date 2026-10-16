const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const STATUS = new Set(['inbox', 'active', 'waiting', 'later', 'done']);
const PRIORITY = new Set(['high', 'medium', 'low']);
const SOURCE = new Set(['telegram', 'chatgpt', 'screenshot', 'note']);

function fail(message) { throw new Error(message); }
function object(value, label = 'Value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}
function text(value, max, label, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`${label} is invalid or too long.`);
  return value;
}
function id(value) { return text(value, 128, 'ID', false); }
function list(value, max, label) {
  if (!Array.isArray(value) || value.length > max) fail(`${label} is invalid or too large.`);
  return value;
}
function date(value, label, timestamp = false) {
  text(value, 40, label, !timestamp);
  if (timestamp) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${label} is invalid.`);
  } else if (value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} is invalid.`);
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(2000, month - 1, day, 12); parsed.setFullYear(year);
    if (year < 1 || parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) fail(`${label} is invalid.`);
  }
}
function imageData(value, type) {
  text(value, Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 100, 'Image');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !IMAGE_TYPES.has(match[1]) || (type && type !== match[1]) || match[2].length % 4 !== 0) fail('Use a PNG, JPEG, or WebP image up to 5 MB.');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 12 || bytes.toString('base64') !== match[2]) fail('Image data is invalid or too large.');
  const signature = match[1] === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : match[1] === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!signature) fail('Image content does not match its format.');
  return { mimeType: match[1], data: match[2], bytes: bytes.length };
}
function task(value) {
  object(value, 'Request');
  id(value.id);
  text(value.title, 500, 'Title', false);
  text(value.body, 100000, 'Context');
  text(value.project, 200, 'Project');
  if (!STATUS.has(value.status) || !PRIORITY.has(value.priority) || !SOURCE.has(value.source)) fail('Request status, priority, or source is invalid.');
  text(value.sourceUrl, 4096, 'Source URL');
  if (value.sourceUrl) {
    let parsed; try { parsed = new URL(value.sourceUrl); } catch { fail('Source URL is invalid.'); }
    if (!['http:', 'https:', 'tg:'].includes(parsed.protocol)) fail('Source URL must be a web or Telegram link.');
  }
  date(value.createdAt, 'Created date', true);
  date(value.updatedAt, 'Updated date', true);
  date(value.dueDate, 'Due date');
  date(value.followUpDate, 'Follow-up date');
  text(value.waitingOn, 2000, 'Waiting on');
  if (typeof value.committed !== 'boolean' || !Number.isSafeInteger(value.order) || value.order < 0) fail('Request commitment or order is invalid.');
  list(value.attachments, 6, 'Attachments').forEach(attachment => {
    object(attachment, 'Attachment'); id(attachment.id); text(attachment.name, 255, 'Attachment name', false);
    if (!IMAGE_TYPES.has(attachment.type)) fail('Attachments must be PNG, JPEG, or WebP images.');
    imageData(attachment.dataUrl, attachment.type);
  });
  list(value.relatedIds, 2000, 'Related requests').forEach(id);
  list(value.activity, 500, 'Activity').forEach(activity => {
    object(activity, 'Activity'); id(activity.id); text(activity.text, 20000, 'Activity text', false); date(activity.createdAt, 'Activity date', true);
  });
  for (const entries of [value.attachments.map(entry => entry.id), value.relatedIds, value.activity.map(entry => entry.id)]) {
    if (new Set(entries).size !== entries.length) fail('Attachment, relation, and activity IDs must be unique.');
  }
  return value;
}
function tasks(value, max = 2000) {
  list(value, max, 'Requests').forEach(task);
  if (new Set(value.map(item => item.id)).size !== value.length) fail('Request IDs must be unique.');
  return value;
}
function workspace(value) {
  object(value, 'Workspace');
  if (value.version !== 1 || typeof value.sample !== 'boolean') fail('Unsupported workspace format.');
  tasks(value.tasks); text(value.focus, 2000, 'Focus');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_WORKSPACE_BYTES) fail('Workspace exceeds 32 MB. Remove a few large images.');
  return value;
}
function model(value) {
  if (typeof value !== 'string' || !/^gemini-[a-z0-9][a-z0-9.-]{0,100}$/.test(value)) fail('Enter a valid Gemini model name.');
  return value;
}
function dailyLimit(value) {
  if (!Number.isInteger(value) || value < 1 || value > 500) fail('Daily limit must be between 1 and 500.');
  return value;
}
function config(value) {
  object(value, 'Settings');
  if (value.version !== 1) fail('Unsupported settings format.');
  model(value.model); dailyLimit(value.dailyLimit);
  object(value.usage, 'Usage');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.usage.date) || !Number.isInteger(value.usage.count) || value.usage.count < 0 || value.usage.count > 1000000) fail('Invalid request usage.');
  for (const key of ['inputTokens', 'outputTokens']) {
    if (value.usage[key] !== undefined && (!Number.isSafeInteger(value.usage[key]) || value.usage[key] < 0 || value.usage[key] > 1000000000000)) fail('Invalid reported token usage.');
  }
  if (value.usage.estimatedCost !== undefined && value.usage.estimatedCost !== null && (typeof value.usage.estimatedCost !== 'number' || !Number.isFinite(value.usage.estimatedCost) || value.usage.estimatedCost < 0 || value.usage.estimatedCost > 1000000)) fail('Invalid estimated cost.');
  if (value.encryptedKey !== undefined && (typeof value.encryptedKey !== 'string' || value.encryptedKey.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.encryptedKey))) fail('Invalid stored credential.');
  return value;
}
function externalUrl(value) {
  text(value, 4096, 'Link', false);
  let url; try { url = new URL(value); } catch { fail('Enter a valid web or Telegram link.'); }
  if (!['http:', 'https:', 'tg:'].includes(url.protocol) || url.username || url.password || /[\u0000-\u001f\u007f]/.test(value)) fail('Only web and Telegram links can be opened.');
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) fail('Invalid web link.');
  if (url.protocol === 'tg:' && !['resolve', 'privatepost', 'openmessage', 'user'].includes(url.hostname)) fail('Use a Telegram conversation or message link.');
  return url.href;
}

module.exports = { MAX_WORKSPACE_BYTES, MAX_IMAGE_BYTES, object, text, id, list, task, tasks, workspace, imageData, model, dailyLimit, config, externalUrl };
