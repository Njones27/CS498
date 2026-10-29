import type { DraftLayout } from '../types'

/** A small Test Lot draft: three spaces (one retired), V1 with a reference photo and outlines, V2 without. */
export function draftFixture(over: Partial<DraftLayout> = {}): DraftLayout {
  return {
    lotId: 'test-lot',
    revision: 0,
    basedOnVersion: 1,
    updatedAt: '2026-10-28T14:05:00Z',
    updatedBy: null,
    schematic: { width: 1000, height: 600 },
    spaces: [
      { spaceId: 'A-01', label: 'A-01', type: 'ADA', rect: { x: 80, y: 80, w: 110, h: 180 }, retired: false },
      { spaceId: 'A-02', label: 'A-02', type: 'STANDARD', rect: { x: 200, y: 80, w: 110, h: 180 }, retired: false },
      { spaceId: 'A-03', label: 'A-03', type: 'EV', rect: { x: 320, y: 80, w: 110, h: 180 }, retired: true },
    ],
    viewpoints: [
      {
        viewId: 'V1',
        name: 'North corner',
        referenceImage: { url: '/api/_test/objects/reference/test-lot/V1/abc.jpg', width: 640, height: 360 },
        outlines: {
          'A-01': [
            [0.05, 0.55],
            [0.17, 0.55],
            [0.15, 0.92],
            [0.03, 0.92],
          ],
        },
        outlineReview: { 'A-01': { source: 'drawn', status: 'accepted' } },
      },
      { viewId: 'V2', name: 'South corner', referenceImage: null, outlines: {}, outlineReview: {} },
    ],
    ...over,
  }
}
