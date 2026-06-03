import { describe, expect, it } from 'vitest';

import { gateCommand } from './command-gate.js';

describe('gateCommand host controls', () => {
  it('handles /status on the host', () => {
    expect(gateCommand('/status', null, 'ag-1')).toEqual({ action: 'status', command: '/status' });
    expect(gateCommand(JSON.stringify({ text: '/status please' }), null, 'ag-1')).toEqual({
      action: 'status',
      command: '/status',
    });
  });

  it('keeps /stop as a host command', () => {
    expect(gateCommand('/stop', null, 'ag-1')).toEqual({ action: 'stop', command: '/stop' });
  });
});
