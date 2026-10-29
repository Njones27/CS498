import type { DraftLayout } from '../types'

export const rylanDraftFixture: DraftLayout = {
  lotId: 'test-lot',
  revision: 1,
  basedOnVersion: 1,
  updatedAt: '2026-10-28T14:05:00Z',
  updatedBy: 'admin@example.edu',
  schematic: { width: 1000, height: 600 },
  spaces: [
    {
      spaceId: 'sp_a01',
      label: 'A-01',
      type: 'STANDARD',
      rect: { x: 50, y: 50, w: 100, h: 180 },
      retired: false,
    },
    {
      spaceId: 'sp_a02',
      label: 'A-02',
      type: 'STANDARD',
      rect: { x: 170, y: 50, w: 100, h: 180 },
      retired: false,
    },
    {
      spaceId: 'sp_a03',
      label: 'A-03',
      type: 'STANDARD',
      rect: { x: 290, y: 50, w: 100, h: 180 },
      retired: false,
    },
    {
      spaceId: 'sp_a04',
      label: 'A-04',
      type: 'ADA',
      rect: { x: 410, y: 50, w: 100, h: 180 },
      retired: false,
    },
    {
      spaceId: 'sp_a05',
      label: 'A-05',
      type: 'EV',
      rect: { x: 530, y: 50, w: 100, h: 180 },
      retired: true,
    },
  ],
  viewpoints: [
    {
      viewId: 'V1',
      name: 'North Corner',
      referenceImage: {
        url: '/api/_test/objects/reference/test-lot/V1/2585ffab2de3.jpg',
        width: 640,
        height: 360,
      },
      outlines: {
        sp_a01: [
          [0.1, 0.2],
          [0.2, 0.2],
          [0.2, 0.3],
          [0.1, 0.3],
        ],
        sp_a02: [
          [0.25, 0.2],
          [0.35, 0.2],
          [0.35, 0.3],
          [0.25, 0.3],
        ],
        sp_a05: [
          [0.6, 0.2],
          [0.7, 0.2],
          [0.7, 0.3],
          [0.6, 0.3],
        ],
      },
      outlineReview: {
        sp_a01: { source: 'drawn', status: 'accepted' },
        sp_a02: { source: 'proposed', status: 'pending' },
        sp_a05: { source: 'drawn', status: 'accepted' },
      },
    },
    {
      viewId: 'V2',
      name: 'East Gate',
      referenceImage: {
        url: '/api/_test/objects/reference/test-lot/V2/2585ffab2de3.jpg',
        width: 640,
        height: 360,
      },
      outlines: {
        sp_a01: [
          [0.15, 0.25],
          [0.25, 0.25],
          [0.25, 0.35],
          [0.15, 0.35],
        ],
      },
      outlineReview: {
        sp_a01: { source: 'drawn', status: 'accepted' },
      },
    },
    {
      viewId: 'V3',
      name: 'South Tower',
      referenceImage: null,
      outlines: {},
      outlineReview: {},
    },
  ],
}
