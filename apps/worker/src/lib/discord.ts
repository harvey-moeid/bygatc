/**
 * lib/discord.ts
 * -------------------------------------------------------------------
 * Helper kirim notifikasi ke Discord lewat Incoming Webhook.
 * Secret: DISCORD_WEBHOOK_URL (wrangler secret put DISCORD_WEBHOOK_URL)
 *
 * Bikin webhook: Discord -> Server Settings -> Integrations -> Webhooks ->
 * New Webhook -> Copy Webhook URL.
 */

export type DiscordEmbedField = { name: string; value: string; inline?: boolean };

export type DiscordEmbed = {
  title?: string;
  description?: string;
  url?: string; // deep link -- klik judul embed di Discord langsung buka halaman ini
  color?: number;
  fields?: DiscordEmbedField[];
  timestamp?: string;
};

export type DiscordMessage = {
  content?: string;
  embeds?: DiscordEmbed[];
};

// Fallback kalau env.DASHBOARD_URL belum diset (mis. lupa deploy var baru).
// env.DASHBOARD_URL tetap sumber utama supaya tidak hardcode URL di banyak
// tempat kalau worker pindah subdomain/custom domain nanti. Custom domain
// bygatc.muidsoft.com sudah di-route ke worker ini, dipakai sebagai default.
const FALLBACK_DASHBOARD_URL = 'https://bygatc.muidsoft.com';

/**
 * Bangun URL dashboard untuk deep-link di notif Discord.
 * path contoh: '' (root/index.html) atau '/futures.html'.
 */
export function dashboardUrl(env: { DASHBOARD_URL?: string }, path = ''): string {
  const base = (env.DASHBOARD_URL || FALLBACK_DASHBOARD_URL).replace(/\/$/, '');
  return `${base}${path}`;
}

/**
 * Kirim pesan ke Discord webhook. Selalu return boolean (tidak throw) --
 * kegagalan kirim notif tidak boleh bikin cron/route pemanggilnya ikut gagal.
 */
export async function sendDiscordAlert(
  webhookUrl: string | undefined,
  message: DiscordMessage,
): Promise<boolean> {
  if (!webhookUrl) {
    console.warn('[discord] DISCORD_WEBHOOK_URL belum diset, skip notif');
    return false;
  }

  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`[discord] webhook HTTP ${r.status}: ${body.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[discord] gagal kirim:', (e as Error).message);
    return false;
  }
}
