import type { DraftLayout, DraftSpace } from '../types'

/** A draft space with Test Lot's 100 x 120 rectangle at (x, y). */
export function space(spaceId: string, x: number, y: number, over: Partial<DraftSpace> = {}): DraftSpace {
  return { spaceId, label: spaceId, type: 'STANDARD', rect: { x, y, w: 100, h: 120 }, retired: false, ...over }
}

/**
 * Test Lot for the schematic editor, based on v3: row A is A-01 to A-05 on one line (A-02 is ADA,
 * A-04 is EV, A-05 is retired but still outlined in V1). The schematic is 1000 x 600.
 */
export function davidFixture(over: Partial<DraftLayout> = {}): DraftLayout {
  return {
    lotId: 'test-lot',
    revision: 7,
    basedOnVersion: 3,
    updatedAt: '2026-10-28T14:05:00Z',
    updatedBy: 'admin@example.edu',
    schematic: { width: 1000, height: 600 },
    spaces: [
      space('A-01', 40, 40),
      space('A-02', 150, 40, { type: 'ADA' }),
      space('A-03', 260, 40),
      space('A-04', 370, 40, { type: 'EV' }),
      space('A-05', 480, 40, { retired: true }),
    ],
    viewpoints: [
      {
        viewId: 'V1',
        name: 'North corner',
        referenceImage: { url: '/api/_test/objects/reference/test-lot/V1/abc.jpg', width: 4000, height: 3000 },
        outlines: {
          'A-01': [
            [0.1, 0.2],
            [0.18, 0.2],
            [0.19, 0.31],
            [0.09, 0.31],
          ],
          'A-05': [
            [0.5, 0.2],
            [0.58, 0.2],
            [0.59, 0.31],
            [0.49, 0.31],
          ],
        },
        outlineReview: {
          'A-01': { source: 'drawn', status: 'accepted' },
          'A-05': { source: 'drawn', status: 'accepted' },
        },
      },
    ],
    ...over,
  }
}
