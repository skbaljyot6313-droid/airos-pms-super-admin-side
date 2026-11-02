import { describe, expect, it } from 'vitest';
import { ActivityLog } from '../api/logs';
import { attachmentUrls, dateBounds, formatEvent, groupActivity, safeMetadata } from './activityLogs';

const photo: ActivityLog = { log_uid: 'photo:1', occurred_at: '2026-10-29T10:30:00Z', category: 'photo', action: 'task_photo_attached', actor_name: 'Worker', entity_type: 'task', entity_uid: 'task', entity_name: 'Cleaning', property_uid: 'property', property_name: 'Hotel', detail: { submission_uid: 'attempt' } };
describe('activity presentation', () => {
  it('never claims attached evidence proves completion', () => { expect(formatEvent(photo).title).toBe('Task photo attached'); expect(formatEvent(photo).description).toContain('not task completion'); });
  it('handles missing metadata and unknown action safely', () => { expect(formatEvent({ ...photo, action: 'unknown_action', actor_name: null, entity_name: null, detail: null as unknown as Record<string, unknown> }).title).toContain('unknown action'); });
  it('redacts nested credentials, bearer values and signed query parameters', () => {
    const result = JSON.stringify(safeMetadata({ token: 'secretvalue', nested: [{ password_hash: 'hashvalue', note: 'Bearer hiddenvalue' }], url: 'https://example.com/image?X-Amz-Signature=privatevalue&ok=1' }));
    for (const value of ['secretvalue', 'hashvalue', 'hiddenvalue', 'privatevalue']) expect(result).not.toContain(value);
  });
  it('groups legitimate attachment events without deleting any', () => {
    const items = [photo, { ...photo, log_uid: 'photo:2' }, { ...photo, log_uid: 'photo:3', detail: { submission_uid: 'different' } }];
    expect(groupActivity(items).map((g) => g.events.length)).toEqual([2, 1]);
    expect(groupActivity(items).flatMap((g) => g.events)).toEqual(items);
    expect(groupActivity(items, false).length).toBe(3);
  });
  it('never groups missing submissions, different tasks, actors or old timestamps', () => {
    for (const change of [{ detail: {} }, { actor_name: null }, { entity_uid: 'other' }, { property_uid: 'other' }, { occurred_at: '2026-10-28T10:00:00Z' }]) expect(groupActivity([photo, { ...photo, log_uid: 'photo:2', ...change }]).length).toBe(2);
  });
  it('resolves only supported media paths or HTTP URLs', () => {
    for (const url of ['javascript:alert(1)', '//foreign/image', '/api/v1/admin/logs', 'data:text/html,x']) expect(attachmentUrls({ ...photo, detail: { url } })).toEqual([]);
    expect(attachmentUrls({ ...photo, detail: { url: '/api/v1/media/file/photo.jpg' } })[0]).toContain('/api/v1/media/file/photo.jpg');
  });
  it('uses IST calendar boundaries for presets', () => {
    expect(dateBounds('today', '', '', new Date('2026-10-29T23:00:00Z'))).toEqual({ date_from: '2026-10-29T18:30:00.000Z', date_to: '2026-10-30T18:30:00.000Z' });
    expect(dateBounds('7', '', '', new Date('2026-10-29T10:00:00Z')).date_from).toBe('2026-10-22T18:30:00.000Z');
  });
});
