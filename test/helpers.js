'use strict';
const record = (type, payload, timestamp = new Date().toISOString()) => ({ type, payload, timestamp });
const item = (type, fields, timestamp) => record('event_msg', { type: 'item_completed', item: { type, ...fields } }, timestamp);
const call = (name, args, id = 'call-1', namespace) => record('response_item', { type: 'function_call', name, namespace, call_id: id, arguments: JSON.stringify(args) });
const output = (value, id = 'call-1') => record('response_item', { type: 'function_call_output', call_id: id, output: typeof value === 'string' ? value : JSON.stringify(value) });
module.exports = { record, item, call, output };
