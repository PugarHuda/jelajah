// A 1080×1080 trophy card to post: the trophy art wallets show (the BCMR icon), the rally, who earned it and how to join.
// Phones share the image straight to WhatsApp/Instagram/X through the Web Share API (files); elsewhere it downloads.
const W = 1080;

const load = (src: string) => new Promise<HTMLImageElement>((ok, fail) => {
  const i = new Image();
  i.onload = () => ok(i);
  i.onerror = () => fail(new Error(`could not load ${src}`));
  i.src = src;
});

export async function trophyCard(o: { rally: string; network: string; collector: string; bonus: boolean; site: string; art: string; lines: [string, string] }): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = c.height = W;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f6efe4'; g.fillRect(0, 0, W, W); // the app's paper colour
  g.strokeStyle = o.bonus ? '#7c3aed' : '#b8862b'; g.lineWidth = 18; g.strokeRect(40, 40, W - 80, W - 80);
  const art = await load(o.art);
  g.drawImage(art, (W - 420) / 2, 120, 420, 420);
  g.textAlign = 'center';
  g.fillStyle = '#b3261e'; g.font = '700 34px system-ui, sans-serif';
  g.fillText(`${o.rally.toUpperCase()} · ${o.network === 'mainnet' ? 'BITCOIN CASH' : 'BCH CHIPNET'}`, W / 2, 610);
  g.fillStyle = '#2a1d14'; g.font = '800 70px Georgia, serif';
  g.fillText(o.lines[0], W / 2, 705);
  g.font = '400 40px system-ui, sans-serif';
  g.fillText(o.lines[1], W / 2, 770);
  g.fillStyle = '#6b5a4a'; g.font = '400 30px ui-monospace, monospace';
  g.fillText(o.collector, W / 2, 850);
  g.fillStyle = '#b3261e'; g.font = '700 36px system-ui, sans-serif';
  g.fillText(o.site, W / 2, 950);
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('canvas export failed'))), 'image/png'));
}

/** Share the card as a file where the OS allows it, otherwise download it. Returns what happened. */
export async function shareOrDownload(blob: Blob, name: string, text: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], text });
    return 'shared';
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return 'downloaded';
}
