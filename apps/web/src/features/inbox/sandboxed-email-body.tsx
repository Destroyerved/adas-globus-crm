import { useMemo, useState } from 'react';
import { activateRemoteImages } from '@adas/shared';
import { Button } from '@/components/ui/button.js';

function escapeTitle(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders synced HTML email inside a scriptless sandboxed iframe (`sandbox=""`) with remote
 * images blocked until the user clicks "Load remote images", or renders plain text cleanly.
 */
export function SandboxedEmailBody({
  subject,
  bodyText,
  bodyHtmlSanitized,
  hasRemoteImages = false,
}: {
  subject: string;
  bodyText: string;
  bodyHtmlSanitized?: string | null;
  hasRemoteImages?: boolean;
}) {
  const [showImages, setShowImages] = useState(false);

  const srcDoc = useMemo(() => {
    if (!bodyHtmlSanitized) return null;
    const htmlContent = showImages ? activateRemoteImages(bodyHtmlSanitized) : bodyHtmlSanitized;
    const safeTitle = escapeTitle(subject || 'Email message');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${safeTitle}</title><style>
      html,body{margin:0;padding:0;background:rgb(255,255,255);color:rgb(15,27,42);font:13.5px/1.55 "Hanken Grotesk",system-ui,-apple-system,sans-serif;word-break:break-word}
      main{padding:2px 0}
      a{color:rgb(0,94,109);text-decoration:underline}
      img{max-width:100%;height:auto}
      img[data-remote-url]{display:inline-block;padding:2px 8px;border:1px dashed rgb(188,198,200);border-radius:4px;font-size:12px;color:rgb(68,81,97)}
      blockquote{margin:8px 0;padding-left:10px;border-left:2px solid rgb(220,226,226);color:rgb(68,81,97)}
      p{margin:0 0 8px}
      p:last-child{margin-bottom:0}
    </style></head><body><main>${htmlContent}</main></body></html>`;
  }, [bodyHtmlSanitized, showImages, subject]);

  if (!srcDoc) {
    return (
      <div className="text-[13.5px] leading-[1.55] text-ink whitespace-pre-line break-words">
        {bodyText}
      </div>
    );
  }

  return (
    <div className="space-y-[8px]">
      {hasRemoteImages && !showImages && (
        <div className="flex flex-wrap items-center justify-between gap-[8px] px-[10px] py-[6px] rounded-[8px] bg-bg-alt border border-line text-[12.5px] text-ink-2">
          <span>Remote images are hidden to protect your privacy.</span>
          <Button variant="secondary" size="sm" onClick={() => setShowImages(true)}>
            Load remote images
          </Button>
        </div>
      )}
      <iframe
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        title={`Email message: ${subject || 'Conversation'}`}
        className="w-full min-h-[110px] border-0 bg-surface rounded-[6px]"
      />
    </div>
  );
}
