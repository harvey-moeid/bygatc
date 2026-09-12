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
  color?: number;
  fields?: DiscordEmbedField[];
  timestamp?: string;
};

export type DiscordMessage = {
  content?: string;
  embeds?: DiscordEmbed[];
};

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
