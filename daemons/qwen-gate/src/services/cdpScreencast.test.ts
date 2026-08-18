import { describe, expect, test } from 'bun:test';
import { getCdpMouseState } from './cdpScreencast.ts';

describe('CDP screencast mouse state', () => {
  test('preserves the held left button throughout a slider drag', () => {
    expect(getCdpMouseState('mousedown', 0, 1)).toEqual({ button: 'left', buttons: 1 });
    expect(getCdpMouseState('mousemove', 0, 1)).toEqual({ button: 'left', buttons: 1 });
    expect(getCdpMouseState('mouseup', 0, 0)).toEqual({ button: 'left', buttons: 0 });
  });

  test('reports ordinary hover movement with no pressed button', () => {
    expect(getCdpMouseState('mousemove', 0, 0)).toEqual({ button: 'none', buttons: 0 });
  });

  test('maps secondary and middle button bitmasks', () => {
    expect(getCdpMouseState('mousemove', 2, 2)).toEqual({ button: 'right', buttons: 2 });
    expect(getCdpMouseState('mousemove', 1, 4)).toEqual({ button: 'middle', buttons: 4 });
  });
});
