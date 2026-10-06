import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PddMode, PddRegistration } from '../shared/waybill';
import { HomeModeControls, HomeModeHeading, ReceivedRegistrationThanks, receivedRegistrationThanks } from '../src/pdd-home';

function registration(mode: PddMode): PddRegistration {
  return {
    registrationCode: 'PDD-R-SYNTHETIC', number: 'SYNTHETIC123', mode, source: 'manual',
    contact: { kind: 'wechat', value: 'synthetic_user' }, note: null, revision: 1, visibility: 'active',
    createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    record: {
      code: 'PDD-P-SYNTHETIC', tail: 'C123', resolution: 'open', visibility: 'active', revision: 1,
      lostRegistered: mode === 'lost', receivedRegistered: mode === 'received',
      createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    },
  };
}

describe('server-confirmed holder registration feedback', () => {
  const thanks = (registrations: (PddRegistration | null)[]) => renderToStaticMarkup(createElement(ReceivedRegistrationThanks, { registrations }));

  it('shows one acknowledgment for single or batch received registrations', () => {
    for (const size of [1, 2, 50]) {
      const html = thanks(Array.from({ length: size }, () => registration('received')));
      expect(html.split(receivedRegistrationThanks)).toHaveLength(2);
      expect(html).toContain('role="status"');
    }
    expect(thanks([null, registration('lost'), registration('received'), null])).toContain(receivedRegistrationThanks);
  });

  it('does not claim a holder registration for empty, null or lost responses', () => {
    for (const registrations of [[], [null], [registration('lost')], [null, registration('lost'), null]]) {
      expect(thanks(registrations)).toBe('');
    }
  });
});

describe('homepage mode controls', () => {
  it('keeps both complete names in order and exposes only the selected mode as pressed', () => {
    for (const mode of ['lost', 'received'] as const) {
      const html = renderToStaticMarkup(createElement(HomeModeControls, { mode, disabled: false, onChange() {} }));
      const buttons = html.match(/<button\b[^>]*>.*?<\/button>/gs)!;
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toContain('<span>找包裹</span>');
      expect(buttons[1]).toContain('<span>找失主</span>');
      expect(buttons[0]).toContain(`aria-pressed="${mode === 'lost'}"`);
      expect(buttons[1]).toContain(`aria-pressed="${mode === 'received'}"`);
      expect(buttons.every(button => !button.includes('disabled='))).toBe(true);
    }
  });

  it('disables both mode changes while the current operation is pending', () => {
    const html = renderToStaticMarkup(createElement(HomeModeControls, { mode: 'received', disabled: true, onChange() {} }));
    const buttons = html.match(/<button\b[^>]*>/g)!;
    expect(buttons).toHaveLength(2);
    expect(buttons.every(button => button.includes('disabled=""'))).toBe(true);
  });
});

describe('homepage scene headings', () => {
  it('switches the two-line title while keeping both responsive decorative scenes mounted', () => {
    const titles = {
      lost: ['我的拼多多快递', '去哪了？'],
      received: ['你的拼多多包裹', '在我这儿！'],
    } as const;
    for (const mode of ['lost', 'received'] as const) {
      const html = renderToStaticMarkup(createElement(HomeModeHeading, { mode }));
      expect(html).toContain(`data-mode="${mode}"`);
      expect(html).toContain(`<h1>${titles[mode][0]}<br/><span>${titles[mode][1]}</span></h1>`);
      const scenes = html.match(/<picture\b[^>]*>.*?<\/picture>/gs)!;
      expect(scenes).toHaveLength(4);
      for (const scene of scenes) {
        expect(scene).toContain('aria-hidden="true"');
        expect(scene).toContain('media="(max-width:800px)"');
        expect(scene).toContain('alt=""');
      }
    }
  });
});
