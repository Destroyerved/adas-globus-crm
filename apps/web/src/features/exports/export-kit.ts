import { api } from '@/lib/api.js';

/**
 * Downloads a ready export and hands it to the browser as a file. Going through the API
 * client means an expired or unfinished export shows its error instead of leaving the page.
 */
export async function saveExport(exportId: string): Promise<void> {
  const { blob, filename } = await api.downloadExport(exportId);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Give the browser a moment to start the download before the URL goes away.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
