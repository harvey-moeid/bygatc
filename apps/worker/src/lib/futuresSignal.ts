/**
 * lib/futuresSignal.ts
 * -------------------------------------------------------------------
 * Notifikasi Discord untuk perubahan regime volatilitas NOCTUA, dipakai
 * futures desk untuk position sizing (lihat docs/TRADE_FLOW.md bagian 8).
 *
 * PENTING -- ini BUKAN sinyal arah (long/short). upside dan p_up_raw di
 * payload NOCTUA sengaja tidak dipakai sebagai sinyal arah: log-loss
 * walk-forward-nya (0.6941) nyaris sama dengan lempar koin (0.6931) --
 * lihat docs/TRADE_FLOW.md bagian 3 dan bagian 8 ("Kenapa arah tetap harus
 * dari luar model"). buildFuturesPlan() di frontend juga mewajibkan
 * `direction` dari pemanggil, bukan dari NOCTUA, dengan alasan yang sama.
 *
 * p_up_raw TETAP disertakan di notif (sebagai field terpisah, bukan
 * dihilangkan) supaya datanya tetap terlihat -- tapi berlabel jelas
 * "info only, NOT validated", bukan dibingkai sebagai rekomendasi
 * beli/jual yang bisa diandalkan. Jangan hapus label ini kalau field-nya
 * diubah nanti -- itu satu-satunya hal yang mencegah angka lempar-koin ini
 * kelihatan seperti sinyal trading asli.
 *
 * Yang dipakai buat tier di sini cuma p_vol_amplify -- satu-satunya
 * komponen NOCTUA yang tervalidasi lewat walk-forward testing (beda 2.79%
 * QLIKE vs baseline, p = 0.043). Tier-nya sama dengan blocker/reason di
 * buildFuturesDecision() (apps/frontend/src/data.js):
 *   >= 0.70 -> "high"     (blocker: ukuran wajib dikecilkan)
 *   >= 0.55 -> "elevated" (waspada, ukuran dikurangi otomatis)
 *   else    -> "calm"     (tenang, ukuran penuh)
 *
 * Teks notif memakai istilah trading standar (Volatility Regime, Position
 * Size, Entry) -- label tampilan tiap tier ada di TIER_META.label.
 *
 * Notif dikirim tiap kali tier BERUBAH (naik atau turun) dibanding push
 * sebelumnya -- bukan tiap push (yang jalan tiap jam dari GH Actions, akan
 * spam kalau dikirim tiap kali).
 *
 * Tier "high" di-mention @here di content pesan (bukan cuma embed) supaya
 * tidak kelewat di channel yang ramai. Tier calm/elevated cukup embed biasa
 * tanpa mention. Embed juga deep-link ke /futures.html (klik judul embed
 * di Discord langsung buka desk futures) -- lihat lib/discord.ts::dashboardUrl().
 *
 * KV key: alert:vol_regime_state -- { tier: 'calm' | 'elevated' | 'high' }
 */

import type { Env } from '../index';
import { sendDiscordAlert, dashboardUrl, type DiscordEmbedField } from './discord';

type VolTier = 'calm' | 'elevated' | 'high';

function classifyVolTier(pVolAmplify: number): VolTier {
  if (pVolAmplify >= 0.70) return 'high';
  if (pVolAmplify >= 0.55) return 'elevated';
  return 'calm';
}

const TIER_META: Record<VolTier, { title: string; label: string; color: number; note: string }> = {
  high: {
    title: 'NOCTUA: High Volatility Regime',
    label: 'HIGH',
    color: 0xef4444,
    note: 'Volatility expansion risk is high. Position size must be reduced; avoid new entries if possible.',
  },
  elevated: {
    title: 'NOCTUA: Elevated Volatility Regime',
    label: 'ELEVATED',
    color: 0xf59e0b,
    note: 'Volatility expansion risk is rising. Stay cautious; position size is reduced automatically.',
  },
  calm: {
    title: 'NOCTUA: Low Volatility Regime',
    label: 'LOW',
    color: 0x22c55e,
    note: 'Volatility expansion risk is low. Normal conditions; full position size.',
  },
};

/**
 * Dipanggil dari routes/noctua.ts setiap kali payload baru berhasil
 * disimpan ke KV. Tidak throw -- kegagalan kirim notif tidak boleh bikin
 * POST /noctua/push ikut gagal.
 */
export async function checkFuturesVolAlert(
  env: Env,
  payload: Record<string, unknown>,
): Promise<void> {
  const pVolAmplify = payload['p_vol_amplify'];
  if (typeof pVolAmplify !== 'number' || !Number.isFinite(pVolAmplify)) {
    return; // payload lama / tidak ada field ini -- skip diam-diam
  }

  const tier = classifyVolTier(pVolAmplify);

  const stateRaw = await env.BTC_CACHE.get('alert:vol_regime_state');
  let prevTier: VolTier | null = null;
  if (stateRaw) {
    try {
      const s = JSON.parse(stateRaw) as { tier?: VolTier };
      prevTier = s.tier ?? null;
    } catch {
      // korup -- perlakukan seperti belum ada state
    }
  }

  if (tier === prevTier) return; // tidak berubah, tidak perlu notif

  const meta = TIER_META[tier];
  const pctStr = (pVolAmplify * 100).toFixed(0);
  const pUpRaw = payload['p_up_raw'];

  const fields: DiscordEmbedField[] = [];
  if (typeof pUpRaw === 'number') {
    fields.push({
      name: 'Directional Bias (p_up_raw): info only, NOT validated',
      value: `${(pUpRaw * 100).toFixed(0)}% directional probability. Historical walk-forward accuracy is close to a coin flip, so do not use it as a standalone signal (see docs/TRADE_FLOW.md #3).`,
      inline: false,
    });
  }

  const prevLabel = prevTier ? TIER_META[prevTier].label : null;

  const ok = await sendDiscordAlert(env.DISCORD_WEBHOOK_URL, {
    content: tier === 'high' ? '@here' : undefined,
    embeds: [
      {
        title: meta.title,
        url: dashboardUrl(env, '/futures.html'),
        description: `Probability of volatility expansion: **${pctStr}%**${prevLabel ? ` (previous regime: ${prevLabel})` : ''}\n\n${meta.note}`,
        color: meta.color,
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  });
  console.log(`[futuresSignal] tier ${prevTier ?? 'unknown'} -> ${tier} (p_vol_amplify=${pctStr}%), notif ${ok ? 'terkirim' : 'gagal'}`);

  await env.BTC_CACHE.put('alert:vol_regime_state', JSON.stringify({ tier }), {
    expirationTtl: 604800, // 7 hari
  });
}